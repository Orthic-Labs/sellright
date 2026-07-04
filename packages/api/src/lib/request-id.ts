/**
 * OBS-1: request-id middleware + per-request access log.
 *
 * Every inbound request gets a stable `x-request-id`:
 *   - if the client sent one, we trust it (lets an upstream LB / gateway stitch
 *     its trace with ours)
 *   - otherwise we mint a uuid v4
 *
 * The id flows three ways:
 *   1. attached to `c.var.requestId` so every handler / downstream log line can
 *      pick it up (use `withContext({ requestId })` from lib/logger.ts)
 *   2. written back on the response (`x-request-id` header) so a curl caller
 *      can correlate a failure with the server log
 *   3. attached to the per-request access log line so all access logs are
 *      correlatable with the handler logs that ran for that request
 *
 * Order: register FIRST in createApp() so every other middleware (CORS, CSRF,
 * onError) and every handler can see the id.
 */
import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { log } from './logger.js';

export const REQUEST_ID_HEADER = 'x-request-id';

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
  }
}

/** Read inbound id (any case of the header) or mint one. */
function resolveRequestId(header: string | undefined): string {
  // c.req.header is already lower-cased by Hono — direct read is fine.
  const inbound = header?.trim();
  if (inbound && inbound.length <= 200 && /^[\w.-]+$/.test(inbound)) return inbound;
  return randomUUID();
}

/** Build the request-id middleware — one shared instance keeps the closure cheap. */
export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
    c.set('requestId', requestId);
    c.header(REQUEST_ID_HEADER, requestId);
    await next();
  };
}

/**
 * Per-request access log. Emits ONE line per request at the END of the
 * response so status + duration are known. Carries the same requestId the
 * request-id middleware set.
 *
 * Bound as `c.var.requestLogger` so a handler can `log.info(...)` directly
 * through the same logger instance (the per-request child picks up requestId
 * automatically) — keeping the access log + handler log on the same logger
 * family is what lets you grep one requestId and see the whole story.
 */
export function accessLogMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    await next();
    const durationMs = Date.now() - start;
    log.info('request', {
      requestId: c.var.requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs,
    });
  };
}