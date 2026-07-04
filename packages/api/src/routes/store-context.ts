/**
 * Shared store-resolution helper for shop route handlers.
 *
 * Every shop route needs to resolve the store from the incoming request. This
 * was previously copy-pasted as a private `store(c)` function in every route
 * file (ra-017). Extract once here and import everywhere.
 *
 * OPS-1: resolution now goes through resolveStoreForRequest, which prefers an
 * explicit x-store-slug header, then matches Host/X-Forwarded-Host against
 * store.config.hostnames, and only falls back to DEV_DEFAULT_STORE outside
 * production. In production, an unmatched host 404s instead of silently
 * serving the dev default — this is the fix for a CDN stripping the
 * x-store-slug header and routing every request to 'damned'.
 */
import { resolveStoreForRequest, type StoreCtx } from '../store-context.js';

/** Minimal context shape accepted — matches what Hono's OpenAPIHono handlers expose. */
type RequestCtx = { req: { header: (k: string) => string | undefined } };

/**
 * Resolve the store from an incoming shop request context.
 * See resolveStoreForRequest for the full precedence rules.
 * Throws StoreSlugError/HostRoutingError (404) on invalid, unknown, or
 * unmatched hosts (WP1.6, OPS-1).
 */
export async function resolveStoreFromCtx(c: RequestCtx): Promise<StoreCtx> {
  return resolveStoreForRequest({
    storeSlugHeader: c.req.header('x-store-slug'),
    host: c.req.header('host'),
    forwardedHost: c.req.header('x-forwarded-host'),
  });
}
