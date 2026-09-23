/**
 * Extension seam: resolve a store by a literal slug/appKey, falling back to a
 * configured slug when the primary one is unknown — lets a consolidated
 * multi-tenant deployment share ONE store across many app keys without a
 * literal fallback slug living in routes/apps.ts.
 */
import { resolveStore, StoreSlugError, type StoreCtx } from '../store-context.js';

/**
 * Resolve `slug` via `resolveStore`. If that throws StoreSlugError (unknown
 * slug) AND `fallbackSlug` is set, resolve `fallbackSlug` instead. Any other
 * error, or an unset `fallbackSlug` (the default — see
 * env.APPS_FALLBACK_STORE_SLUG), rethrows the original error unchanged.
 */
export async function resolveStoreWithFallback(slug: string, fallbackSlug: string | undefined): Promise<StoreCtx> {
  try {
    return await resolveStore(slug);
  } catch (e) {
    if (e instanceof StoreSlugError && fallbackSlug) {
      return resolveStore(fallbackSlug);
    }
    throw e;
  }
}
