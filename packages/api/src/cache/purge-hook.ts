/**
 * Cache-invalidation trigger for catalog CONTENT changes (ADR-0001: stock commits no longer purge HTML; the shell
 * holds no stock and price is a live value). Called from manifest/stock-hook.ts's onCatalogContentChanged() only. Zero debounce — same LOCKED policy as the
 * stock manifest: no coalescing window, fire on every commit. Fire-and-
 * forget: never await this from a request handler (see purgeCloudflareUrls
 * for why it can never throw either).
 */
import { env } from '../env.js';
import { appValue } from '../email/dispatch.js';
import { purgeCloudflareHosts, purgeCloudflareUrls, resolveCloudflareConfig } from './cloudflare-purge.js';
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
    firePurge('product-content', storeSlug, { urls });
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
 * blog row commit IS the publication). Purges the home page (it lists recent posts), the blog index, each changed post (old and new slug on a rename)
 * and the sitemaps (ADR-0001 item 5). Call after the blog mutation commits; fire-and-forget, never throws.
 */
export function blogPurgeUrls(storeSlug: string, postSlugs: readonly string[]): string[] | null {
  const base = storefrontOrigin(storeSlug);
  if (!base) return null;
  const urls = [`${base}/`, `${base}/blog/`, `${base}/sitemap-blog.xml`, `${base}/sitemap.xml`];
  for (const slug of new Set(postSlugs)) if (slug) urls.push(`${base}/blog/${encodeURIComponent(slug)}/`);
  return urls;
}

export function onBlogContentChanged(storeSlug: string, postSlugs: readonly string[]): void {
  try {
    const urls = blogPurgeUrls(storeSlug, postSlugs);
    if (urls) firePurge('blog-content', storeSlug, { urls });
  } catch (e) {
    logErr.error('blog cache purge hook failed to resolve/queue', e, { storeSlug });
  }
}

// ── ADR-0001 item 5: reliable purge triggers ────────────────────────────────────────────────────────────────────
// Cloudflare purge limits, from https://developers.cloudflare.com/cache/how-to/purge-cache/ (fetched 2026-10-31):
//   by URL: 100 URLs per request on Free/Pro/Business (500 Enterprise); 800 URLs/s Free, 1500/s Pro+Business.
//   by hostname/tag/prefix/everything: 100 operations per request; Free 5 requests/min (bucket 25), Pro 5/s, Business 10/s.
// cloudflare-purge.ts keeps its older, safer 30-URL batch. Past PURGE_URL_FALLBACK_THRESHOLD URLs a trigger stops
// enumerating and purges the whole host in ONE request (one call against the 5/min Free budget instead of many).
export const PURGE_URL_FALLBACK_THRESHOLD = 100;
export const PURGE_ATTEMPT_TIMEOUT_MS = 5_000;
export const PURGE_MAX_ATTEMPTS = 3;
export const PURGE_BACKOFF_BASE_MS = 1_000; // 1s, then 4s (x4 each retry)

export type PurgeEvent = 'blog-content' | 'collection' | 'store-config' | 'maintenance' | 'product-content' | 'manual';
export type PurgeSpec = { urls: string[] } | { everything: true };
export type PurgeResult = 'purged' | 'skipped' | 'failed';

let retryPolicy = { attemptTimeoutMs: PURGE_ATTEMPT_TIMEOUT_MS, maxAttempts: PURGE_MAX_ATTEMPTS, backoffBaseMs: PURGE_BACKOFF_BASE_MS };
/** Test-only: shrink the timeout/backoff. Pass nothing to restore the defaults. */
export function _setPurgeRetryPolicyForTest(p?: Partial<typeof retryPolicy>): void {
  retryPolicy = { attemptTimeoutMs: PURGE_ATTEMPT_TIMEOUT_MS, maxAttempts: PURGE_MAX_ATTEMPTS, backoffBaseMs: PURGE_BACKOFF_BASE_MS, ...p };
}

/** Pure planning step (exported for the K-3 tests): which request shape a trigger uses. */
export function planPurge(spec: PurgeSpec): { mode: 'urls'; urls: string[] } | { mode: 'host'; reason: 'everything' | 'over-threshold' } {
  if ('everything' in spec) return { mode: 'host', reason: 'everything' };
  const urls = [...new Set(spec.urls)];
  return urls.length > PURGE_URL_FALLBACK_THRESHOLD ? { mode: 'host', reason: 'over-threshold' } : { mode: 'urls', urls };
}

const sleep = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/**
 * Run one purge with a per-attempt timeout and retry with exponential backoff. Call only AFTER the triggering
 * transaction committed. Never throws. After the last failed attempt it logs ONE structured error line carrying
 * `alert: 'cache_purge_failed'` plus event/store/mode/counts, which the log alerting keys on (QS-7). 'skipped' (no
 * storefront origin or no Cloudflare config) is not a failure.
 */
export async function runPurge(event: PurgeEvent, storeSlug: string, spec: PurgeSpec): Promise<PurgeResult> {
  let plan: ReturnType<typeof planPurge>;
  let base: string | null;
  try {
    base = storefrontOrigin(storeSlug);
    if (!base || !resolveCloudflareConfig(storeSlug)) return 'skipped';
    plan = planPurge(spec);
  } catch (e) {
    logErr.error('cache purge failed to resolve', e, { alert: 'cache_purge_failed', event, storeSlug, phase: 'resolve' });
    return 'failed';
  }
  const hostname = new URL(base).hostname;
  const attemptOnce = (): Promise<boolean | 'timeout'> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), retryPolicy.attemptTimeoutMs); timer.unref?.(); });
    const call = plan.mode === 'urls' ? purgeCloudflareUrls(storeSlug, plan.urls) : purgeCloudflareHosts(storeSlug, [hostname]);
    return Promise.race([call, deadline]).finally(() => { if (timer) clearTimeout(timer); });
  };
  let last = 'rejected';
  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
    try {
      const out = await attemptOnce();
      if (out === true) return 'purged';
      last = out === 'timeout' ? 'timeout' : 'rejected';
    } catch (e) { last = e instanceof Error ? e.message : 'error'; }
    if (attempt < retryPolicy.maxAttempts) await sleep(retryPolicy.backoffBaseMs * 4 ** (attempt - 1));
  }
  logErr.error('cache purge failed after retries', new Error(`purge ${last}`), {
    alert: 'cache_purge_failed', event, storeSlug, host: hostname, mode: plan.mode,
    urlCount: plan.mode === 'urls' ? plan.urls.length : undefined, reason: plan.mode === 'host' ? plan.reason : undefined,
    attempts: retryPolicy.maxAttempts, last,
  });
  return 'failed';
}

/** Fire-and-forget wrapper for request handlers. Never throws, never rejects. */
export function firePurge(event: PurgeEvent, storeSlug: string, spec: PurgeSpec): void {
  void runPurge(event, storeSlug, spec).catch((e) => logErr.error('cache purge crashed', e, { alert: 'cache_purge_failed', event, storeSlug }));
}

/** Collection page + shop listing (+ collection sitemaps) for the changed collections. Null: no storefront origin. */
export function collectionPurgeUrls(storeSlug: string, collectionSlugs: readonly string[]): string[] | null {
  const base = storefrontOrigin(storeSlug);
  if (!base) return null;
  const urls = [`${base}/shop/`, `${base}/sitemap-collections.xml`, `${base}/sitemap.xml`];
  for (const slug of new Set(collectionSlugs)) if (slug) urls.push(`${base}/collections/${encodeURIComponent(slug)}/`);
  return urls;
}

/** Collection create/update/delete/membership change, called after commit. */
export function onCollectionChanged(storeSlug: string, collectionSlugs: readonly string[]): void {
  try {
    const urls = collectionPurgeUrls(storeSlug, collectionSlugs);
    if (urls) firePurge('collection', storeSlug, { urls });
  } catch (e) {
    logErr.error('collection cache purge hook failed to resolve/queue', e, { alert: 'cache_purge_failed', event: 'collection', storeSlug });
  }
}

/** Theme, store identity, name/logo, sign-in providers, head/analytics config or anything else the shell or its CSP renders: purge the whole host. */
export function onStoreShellConfigChanged(storeSlug: string): void {
  firePurge('store-config', storeSlug, { everything: true });
}

/** Maintenance toggled (awaitable: the CLI process exits right after). Purges the whole host. */
export function purgeHostForMaintenance(storeSlug: string): Promise<PurgeResult> {
  return runPurge('maintenance', storeSlug, { everything: true });
}
