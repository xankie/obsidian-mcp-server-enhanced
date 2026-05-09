/**
 * @fileoverview T1.2/T1.3/T1.4/T1.5 — High-order wrapper applied to every
 * write-capable MCP tool's request handler.
 *
 * Pipeline (in order):
 *   1. T1.4 idempotency — UUID lookup, cached MCP response on hit.
 *   2. Inner handler runs (which itself uses retryWithExponentialBackoff at
 *      the API-call sites and calls verifyContentMatch / verifyDeletion).
 *   3. T1.5 success path — annotate response with verification metadata if
 *      the inner handler attached `__verification`, and store under UUID.
 *   4. T1.5 error path — every thrown error is mapped to a structured error
 *      response. No silent fails, no raw McpError leaking through.
 *
 * Usage in registration.ts:
 *   const result = await runWriteTool({
 *     toolName, idempotencyKey, context,
 *     handler: async () => processObsidianFooBar(validatedParams, context, vm),
 *   });
 *   return result;  // already a CallToolResult
 *
 * @module src/utils/internal/writeToolWrapper
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError } from "../../types-global/errors.js";
import { getIdempotencyStore } from "./idempotencyStore.js";
import { logger } from "./logger.js";
import { RequestContext } from "./requestContext.js";
import {
  StructuredError,
  fromMcpError,
  fromUnknown,
  isStructuredError,
} from "./structuredError.js";
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
    const responseObj = await handler();
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
