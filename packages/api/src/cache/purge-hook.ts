/**
 * Cache-invalidation trigger for catalog/stock changes, hooked in alongside
 * manifest/stock-hook.ts's onStockChanged() at every call site that mutates a
 * product, variant, or stock row. Zero debounce — same LOCKED policy as the
 * stock manifest: no coalescing window, fire on every commit. Fire-and-
 * forget: never await this from a request handler (see purgeCloudflareUrls
 * for why it can never throw either).
 */
import { env } from '../env.js';
import { appValue } from '../email/dispatch.js';
import { purgeCloudflareUrls } from './cloudflare-purge.js';
import { err as logErr } from '../lib/logger.js';

function storefrontOrigin(storeSlug: string): string | null {
  const raw = appValue(env.STOREFRONT_ORIGIN_BY_STORE, storeSlug) ?? env.STOREFRONT_URL;
  if (typeof raw !== 'string' || !raw) return null;
  return raw.replace(/\/+$/, '');
}

/**
 * The shop root/listing/sitemaps (+ one product page when given) for a store,
 * as absolute URLs against its configured storefront origin. Returns null
 * when the store has no resolvable origin. Shared by the automatic hook below
 * and the manual admin purge route (routes/admin-cache.ts), so "purge the
 * standard set" means the same thing whether it fires automatically or on
 * request.
 */
export function standardPurgeUrls(storeSlug: string, opts: { productSlug?: string } = {}): string[] | null {
  const base = storefrontOrigin(storeSlug);
  if (!base) return null;
  const urls = [`${base}/`, `${base}/shop/`, `${base}/sitemap.xml`, `${base}/sitemap-products.xml`];
  if (opts.productSlug) urls.push(`${base}/products/${opts.productSlug}/`);
  return urls;
}

/**
 * Call this AFTER a transaction that changed a product, variant, or stock row
 * for `storeSlug` has committed. Never throws — this is called
 * unconditionally from onStockChanged (manifest/stock-hook.ts), which itself
 * must never throw into its callers, so every failure here (including a
 * misconfigured/missing STOREFRONT_URL) is logged and swallowed, exactly like
 * purgeCloudflareUrls()'s own failures. Fire-and-forget: does not await the
 * purge, and does not report success/failure back to the caller — for that,
 * use the admin purge route instead.
 */
export function onCatalogCacheChanged(storeSlug: string, opts: { productSlug?: string } = {}): void {
  try {
    const urls = standardPurgeUrls(storeSlug, opts);
    if (!urls) return; // no configured origin for this store — nothing to purge against
    void purgeCloudflareUrls(storeSlug, urls);
  } catch (e) {
    logErr.error('cache purge hook failed to resolve/queue', e, { storeSlug });
  }
}
