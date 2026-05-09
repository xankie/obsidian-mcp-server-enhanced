/**
 * @fileoverview T1.2/T1.3/T1.4/T1.5 + T2.2 — High-order wrapper applied to
 * every write-capable MCP tool's request handler.
 *
 * Pipeline (in order):
 *   1. T1.4 idempotency — UUID lookup, cached MCP response on hit.
 *   2. T2.2 lock acquisition — when `lockKey` is set, the handler runs
 *      inside `acquireWriteLock`, serializing concurrent writes on the
 *      same key (in-process mutex + cross-process temp-dir lock file with
 *      30s stale-takeover policy).
 *   3. Inner handler runs (which itself uses retryWithExponentialBackoff at
 *      the API-call sites, optionally calls preflightContentHash /
 *      assertContentHash for T2.3 hash pre-flight, and calls
 *      verifyContentMatch / verifyDeletion for T1.3 readback).
 *   4. T1.5 success path — annotate response with verification metadata if
 *      the inner handler attached it, and store under the idempotency UUID.
 *   5. T1.5 error path — every thrown error (including T2.2
 *      WriteLockTimeoutError and T2.3 HashMismatchError) is mapped to a
 *      structured error response. No silent fails, no raw McpError leaking
 *      through.
 *
 * **T2.1 transaction semantics (no separate wrapper code).** Every current
 * write tool issues at most one PUT per invocation, with all in-memory
 * composition (search/replace, frontmatter edits, tag edits, task edits)
 * computed before the PUT. A throw mid-composition exits before the PUT,
 * leaving the vault file untouched — the "no partial state" property of
 * T2.1's spec is satisfied by construction. For future multi-PUT tools,
 * use `withSnapshotRestore` from `./snapshotRestore.ts` for best-effort
 * compensation on mid-sequence failure.
 *
 * Usage in registration.ts:
 *   const result = await runWriteTool({
 *     toolName,
 *     idempotencyKey: params.idempotency_key,
 *     lockKey: buildWriteLockKey(params.vault, params.filePath),
 *     context,
 *     handler: async () => processObsidianFooBar(validatedParams, context, vm),
 *   });
 *   return result;  // already a CallToolResult
 *
 * @module src/utils/internal/writeToolWrapper
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError } from "../../types-global/errors.js";
import { HashMismatchError } from "./contentHashPreflight.js";
import { getIdempotencyStore } from "./idempotencyStore.js";
import { logger } from "./logger.js";
import { RequestContext } from "./requestContext.js";
import {
  StructuredError,
  fromMcpError,
  fromUnknown,
  isStructuredError,
} from "./structuredError.js";
import { acquireWriteLock, WriteLockTimeoutError } from "./writeLock.js";
import { WriteRetryExhaustedError } from "./writeRetry.js";

export interface RunWriteToolOptions<T> {
  toolName: string;
  /** Optional client-supplied UUID. Empty string / undefined disables caching. */
  idempotencyKey?: string;
  context: RequestContext;
  /** The actual tool logic. Returns whatever JSON-shaped object the tool already returns. */
  handler: () => Promise<T>;
  /** Targets used in error context if the handler throws before logging it. */
  errorContext?: Record<string, unknown>;
  /**
   * T2.2 — optional write lock key. When provided, the handler runs inside
   * `acquireWriteLock(lockKey, ...)` so concurrent writes on the same key
   * are serialized. Tools build keys like `${vaultId}:${filePath}`; pass
   * `undefined` for tools without a stable file identifier (e.g. activeFile).
   */
  lockKey?: string;
}

/** Marker key tools may attach to their response payload to surface verification. */
export const VERIFICATION_KEY = "verification";

export async function runWriteTool<T extends object>(
  opts: RunWriteToolOptions<T>,
): Promise<CallToolResult> {
  const {
    toolName,
    idempotencyKey,
    context,
    handler,
    errorContext = {},
    lockKey,
  } = opts;

  // ---- T1.4: idempotency lookup ----
  const store = getIdempotencyStore();
  const useIdempotency =
    typeof idempotencyKey === "string" && idempotencyKey.length > 0;

  if (useIdempotency) {
    const lookup = store.lookup<CallToolResult>(toolName, idempotencyKey!);
    if (lookup.hit) {
      logger.info(
        `Idempotency hit for ${toolName} (key=${idempotencyKey}); returning cached result.`,
        { ...context, operation: "IdempotencyHit", toolName },
      );
      // Return the cached MCP response verbatim so the client sees identical bytes.
      return lookup.entry.result;
    }
  }

  const startedAt = Date.now();

  try {
    // T2.2: serialize concurrent writes on the same lockKey. When no
    // lockKey is supplied, run the handler directly (e.g. tools targeting
    // the active file have no stable identifier to lock on).
    const responseObj = lockKey
      ? await acquireWriteLock(lockKey, handler, context)
      : await handler();
    const elapsed_ms = Date.now() - startedAt;

    // ---- T1.5 success path ----
    const successPayload = {
      ...responseObj,
      idempotency_key: useIdempotency ? idempotencyKey : null,
      elapsed_ms,
    };

    const callToolResult: CallToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify(successPayload, null, 2),
        },
      ],
      isError: false,
    };

    if (useIdempotency) {
      store.store(toolName, idempotencyKey!, callToolResult);
    }

    return callToolResult;
  } catch (err) {
    const elapsed_ms = Date.now() - startedAt;

    // ---- T1.5 error path: ALWAYS structured ----
    let structured: StructuredError;

    if (err instanceof WriteRetryExhaustedError) {
      structured = err.structured;
    } else if (err instanceof HashMismatchError) {
      structured = err.structured;
    } else if (err instanceof WriteLockTimeoutError) {
      structured = err.structured;
    } else if (err instanceof McpError) {
      structured = fromMcpError(err, {
        ...errorContext,
        operation: toolName,
        elapsed_ms,
      });
    } else if (isStructuredError(err)) {
      structured = err;
    } else {
      structured = fromUnknown(err, {
        ...errorContext,
        operation: toolName,
        elapsed_ms,
      });
    }

    logger.error(
      `Write tool '${toolName}' returning structured error: ${structured.error_type}`,
      err instanceof Error ? err : undefined,
      {
        ...context,
        operation: toolName,
        error_type: structured.error_type,
        retry_safe: structured.retry_safe,
        elapsed_ms,
      },
    );

    const errorPayload = {
      success: false,
      error: structured,
      idempotency_key: useIdempotency ? idempotencyKey : null,
      elapsed_ms,
    };

    const callToolResult: CallToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify(errorPayload, null, 2),
        },
      ],
      isError: true,
    };

    // Errors are NOT cached under idempotency keys — a retry with the same
    // UUID after a transport failure should be allowed to actually retry the
    // write rather than re-receive the failure.
    return callToolResult;
  }
}

/** Zod schema fragment to add `idempotency_key` to a write tool's input. */
export const idempotencyKeyDescription =
  "Optional client-supplied UUID. If the same key is sent twice within 60s, the second call is a no-op and returns the cached result. Closes delete+rewrite race conditions on retry.";
