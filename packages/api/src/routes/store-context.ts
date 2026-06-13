/**
 * Shared store-resolution helper for shop route handlers.
 *
 * Every shop route needs to resolve the store from the incoming request
 * (x-store-slug header → DEV_DEFAULT_STORE fallback). This was previously
 * copy-pasted as a private `store(c)` function in every route file (ra-017).
 * Extract once here and import everywhere.
 */
import { resolveStore, DEV_DEFAULT_STORE, type StoreCtx } from '../store-context.js';

/** Minimal context shape accepted — matches what Hono's OpenAPIHono handlers expose. */
type RequestCtx = { req: { header: (k: string) => string | undefined } };

/**
 * Resolve the store from an incoming shop request context.
 * Reads the `x-store-slug` request header; falls back to DEV_DEFAULT_STORE.
 * Throws StoreSlugError (404) on invalid or unknown slugs (WP1.6).
 */
export async function resolveStoreFromCtx(c: RequestCtx): Promise<StoreCtx> {
  const slug = c.req.header('x-store-slug') ?? DEV_DEFAULT_STORE;
  return resolveStore(slug);
}
