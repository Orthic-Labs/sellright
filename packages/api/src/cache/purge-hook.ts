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
import { purgeCloudflareUrls, resolveCloudflareConfig } from './cloudflare-purge.js';
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
export function standardPurgeUrls(storeSlug: string, opts: { productPath?: string } = {}): string[] | null {
  const base = storefrontOrigin(storeSlug);
  if (!base) return null;
  const urls = [`${base}/`, `${base}/shop/`, `${base}/sitemap.xml`, `${base}/sitemap-products.xml`];
  // The product page path comes from the store's own SEO config (seo/config.ts productPath): `/products/{slug}/` by default,
  // `/shop/{slug}/` for a store whose storefront serves products there. Never rebuilt here from a hard-coded prefix.
  if (opts.productPath) urls.push(`${base}${opts.productPath}`);
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
export function onCatalogCacheChanged(storeSlug: string, opts: { productPath?: string } = {}): void {
  try {
    const urls = standardPurgeUrls(storeSlug, opts);
    if (!urls) return; // no configured origin for this store — nothing to purge against
    void purgeCloudflareUrls(storeSlug, urls);
  } catch (e) {
    logErr.error('cache purge hook failed to resolve/queue', e, { storeSlug });
  }
}

/** F5: the longest a post-publication purge may hold its caller (the catalog publisher, under its leader lock). */
export const PURGE_AFTER_PUBLISH_TIMEOUT_MS = 5_000;

export type PurgeOutcome = 'purged' | 'skipped' | 'failed';

/**
 * N9 / F5: purge AFTER a validated content generation is durably published, never before — an edge that refills
 * between purge and publication would otherwise re-cache the old content. Awaited, but bounded: a hung Cloudflare
 * call resolves as 'failed' after `timeoutMs` (the request itself is left to settle in the background and is still
 * logged by purgeCloudflareUrls). 'skipped' means nothing to purge against (no storefront origin or no Cloudflare
 * config for this store) and is NOT a failure. 'failed' is retryable: the publisher reports it so the durable
 * catalog_manifest_pending marker stays and the drain pass republishes + purges again. Never throws.
 */
export async function purgeAfterPublish(storeSlug: string, productPaths: readonly string[] = [], timeoutMs = PURGE_AFTER_PUBLISH_TIMEOUT_MS): Promise<PurgeOutcome> {
  try {
    const urls = standardPurgeUrls(storeSlug);
    if (!urls || !resolveCloudflareConfig(storeSlug)) return 'skipped';
    const base = storefrontOrigin(storeSlug)!;
    for (const path of new Set(productPaths)) if (path) urls.push(`${base}${path}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); timer.unref?.(); });
    try {
      const ok = await Promise.race([purgeCloudflareUrls(storeSlug, urls), deadline]);
      if (ok === 'timeout') {
        logErr.error('cache purge after publish timed out', new Error(`purge exceeded ${timeoutMs}ms`), { storeSlug, fileCount: urls.length });
        return 'failed';
      }
      return ok ? 'purged' : 'failed';
    } finally { if (timer) clearTimeout(timer); }
  } catch (e) {
    logErr.error('cache purge after publish failed to resolve/queue', e, { storeSlug });
    return 'failed';
  }
}

/**
 * P4b purge-on-publish for blog content (not part of the catalog generation, so there is nothing to publish first: the
 * blog row commit IS the publication). Purges the blog index, each changed post (old and new slug on a rename) and the
 * blog sitemap. Call after the blog mutation commits; fire-and-forget, never throws.
 */
export function blogPurgeUrls(storeSlug: string, postSlugs: readonly string[]): string[] | null {
  const base = storefrontOrigin(storeSlug);
  if (!base) return null;
  const urls = [`${base}/blog/`, `${base}/sitemap-blog.xml`, `${base}/sitemap.xml`];
  for (const slug of new Set(postSlugs)) if (slug) urls.push(`${base}/blog/${encodeURIComponent(slug)}/`);
  return urls;
}

export function onBlogContentChanged(storeSlug: string, postSlugs: readonly string[]): void {
  try {
    const urls = blogPurgeUrls(storeSlug, postSlugs);
    if (urls) void purgeCloudflareUrls(storeSlug, urls);
  } catch (e) {
    logErr.error('blog cache purge hook failed to resolve/queue', e, { storeSlug });
  }
}
