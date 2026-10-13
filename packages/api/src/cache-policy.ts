/**
 * API response cache policy (CLAUDE.md "Stock Architecture": no cache, TTL or debounce for stock anywhere).
 *
 * Every response is `private, no-store` unless it is on `CACHEABLE_EXCEPTIONS`. The middleware runs AFTER the
 * handler, so it also covers error envelopes (onError), 404s and any route (built-in or plugin) that sets its own
 * header: a route-set value survives only for an exception entry, on a 200 response to a GET/HEAD. Anything else is
 * forced to `private, no-store` and loses any CDN/surrogate cache header, so a newly added route that forgets a header,
 * or sets a cacheable one, still fails closed. `cache-tag` is stripped from EVERY response, exceptions included: Cloudflare ties
 * tags to cached content and none is emitted anywhere (Cloudflare design P0-c).
 *
 * An exception must be provably stock-free AND identical for every visitor of the store (no cookie, auth, cart or
 * price/availability dependence). Add one only with a `reason` saying why, and a `source` file; the unit test fails
 * when a source file sets a cacheable Cache-Control that is not listed here.
 *
 * Plugin exceptions: a plugin that owns stock-free routes of its own (e.g. a release-update feed) declares them with
 * `registerCacheableExceptions(entries)` (or the `cacheableExceptions` field on `ApiPlugin`, applied by
 * `registerApiPlugin`) BEFORE `createApp()`. Registered entries are appended to the live set and follow the same rule
 * as the static list: kept only on a 200 GET/HEAD, forced to `private, no-store` on any other method or status, and
 * `cache-tag` is always stripped. Registration is fail-closed and all-or-nothing: every entry needs a non-empty
 * `source` and `reason`; an absolute path (or an anchored RegExp); no duplicate or overlap with the static list or an
 * earlier registration; and it must not fall under the hard deny list (`assertNotDenied`): catalog, cart, checkout,
 * stock/inventory/availability/price, feeds, and admin/account/auth/orders/customer paths. The static list and its
 * behaviour are unchanged; a plugin can only ADD a cacheable path, never relax an existing no-store one.
 */
import type { Context, MiddlewareHandler } from 'hono';

export const NO_STORE = 'private, no-store';

export interface CacheableException {
  /** Exact request path, or a RegExp tested against it. */
  path: string | RegExp;
  /** Source file (relative to packages/api/src) that sets the header. */
  source: string;
  reason: string;
}

export const CACHEABLE_EXCEPTIONS: readonly CacheableException[] = [
  { path: /^\/v1\/shop\/seo\/sitemap(-(main|products|collections|blog))?\.xml$/, source: 'routes/seo.ts', reason: 'sitemaps list URLs and lastmod only; no price or availability, same for every visitor' },
  { path: '/v1/shop/seo/robots.txt', source: 'routes/seo.ts', reason: 'crawler directives from store config; no stock, same for every visitor' },
  { path: '/v1/shop/seo/jsonld/organization', source: 'routes/seo.ts', reason: 'Organization/WebSite JSON-LD from store config; product JSON-LD (live price + stock) is NOT listed and stays no-store' },
  { path: '/v1/shop/seo/indexnow-key.txt', source: 'routes/seo.ts', reason: 'static IndexNow key file body from store config' },
  { path: '/v1/pro/revocations', source: 'licensing/revocation-feed.ts', reason: 'opaque revoked-license ids per tenant (frozen 60s wire contract for shipped Workers); no stock, no visitor state' },
];

/** Entries added by plugins at boot (registerCacheableExceptions); read live by every request. */
const registeredExceptions: CacheableException[] = [];

function matches(e: CacheableException, path: string): boolean {
  return typeof e.path === 'string' ? e.path === path : e.path.test(path);
}

export function isCacheableException(path: string): boolean {
  return CACHEABLE_EXCEPTIONS.some((e) => matches(e, path)) || registeredExceptions.some((e) => matches(e, path));
}

/** Read-only view of the plugin-registered entries (diagnostics, tests). */
export function listRegisteredCacheableExceptions(): readonly CacheableException[] {
  return registeredExceptions;
}

/** Test-only: drop every plugin-registered exception (the static list is untouched). */
export function _clearRegisteredCacheableExceptionsForTest(): void {
  registeredExceptions.length = 0;
}

/**
 * Hard deny list: no plugin may make these cacheable, whatever its reason. A path segment (or file stem) that names
 * stock, inventory, availability, price, catalog, cart, checkout or feeds, or a per-visitor surface (admin, account,
 * auth, orders, customer).
 */
const DENIED_SEGMENT = /(^|\/)(stock|stocks|inventory|availability|prices?|pricing|catalog|cart|carts|checkout|feeds?|admin|account|accounts|auth|orders?|customers?)(?=[/.\-_]|$)/i;
/** Sample denied paths a RegExp entry must not match. */
const DENIED_PROBES: readonly string[] = [
  '/v1/shop/catalog', '/v1/shop/catalog/products', '/v1/shop/catalog/products/x', '/v1/shop/catalog/products/x/stock',
  '/v1/shop/catalog/search', '/v1/shop/cart', '/v1/shop/cart/abc', '/v1/shop/checkout', '/v1/checkout', '/v1/checkout/x',
  '/v1/shop/feeds/google', '/v1/shop/feeds/google.csv', '/v1/stock', '/v1/shop/stock/x', '/v1/shop/seo/jsonld/products/x',
  '/v1/admin/apps/releases', '/v1/account/me', '/v1/auth/login', '/v1/orders/1',
];

function isDeniedPath(path: string): boolean {
  return DENIED_SEGMENT.test(path);
}

function assertNotDenied(e: CacheableException): void {
  const label = String(e.path);
  if (typeof e.path === 'string') {
    if (isDeniedPath(e.path)) throw new Error(`cacheable exception ${label} is on the hard deny list (stock, catalog, cart, checkout, feeds or per-visitor paths can never be cacheable)`);
    return;
  }
  if (isDeniedPath(e.path.source.replace(/\\\//g, '/'))) throw new Error(`cacheable exception ${label} targets a hard-denied path`);
  for (const probe of DENIED_PROBES) {
    // Fresh RegExp: a global/sticky flag would make .test() stateful.
    if (new RegExp(e.path.source, e.path.flags.replace(/[gy]/g, '')).test(probe)) throw new Error(`cacheable exception ${label} matches hard-denied path ${probe}`);
  }
}

function sameKey(a: CacheableException['path'], b: CacheableException['path']): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (typeof a !== 'string' && typeof b !== 'string') return a.source === b.source && a.flags === b.flags;
  return false;
}

/**
 * Append plugin-owned stock-free routes to the cacheable set. All-or-nothing: any invalid entry throws and nothing is
 * registered. Call before `createApp()` (the policy reads the set per request, so earlier is simply safer).
 */
export function registerCacheableExceptions(entries: readonly CacheableException[]): void {
  const staged: CacheableException[] = [];
  for (const e of entries) {
    const label = String(e?.path);
    if (typeof e?.source !== 'string' || e.source.trim() === '') throw new Error(`cacheable exception ${label} requires a non-empty source`);
    if (typeof e.reason !== 'string' || e.reason.trim() === '') throw new Error(`cacheable exception ${label} requires a non-empty reason`);
    if (typeof e.path === 'string') {
      if (!e.path.startsWith('/')) throw new Error(`cacheable exception ${label} must be an absolute path starting with "/"`);
    } else if (e.path instanceof RegExp) {
      if (!e.path.source.startsWith('^') || !e.path.source.endsWith('$')) throw new Error(`cacheable exception ${label} must be an anchored RegExp (^...$)`);
    } else {
      throw new Error('cacheable exception path must be a string or RegExp');
    }
    assertNotDenied(e);
    const existing = [...CACHEABLE_EXCEPTIONS, ...registeredExceptions, ...staged];
    if (existing.some((x) => sameKey(x.path, e.path))) throw new Error(`cacheable exception ${label} is already registered`);
    if (typeof e.path === 'string' && existing.some((x) => matches(x, e.path as string))) throw new Error(`cacheable exception ${label} overlaps an existing exception`);
    staged.push({ path: e.path, source: e.source, reason: e.reason });
  }
  registeredExceptions.push(...staged);
}

const CACHE_HEADERS_TO_STRIP = ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'surrogate-control', 'expires'];

/** Run `edit` on the response headers; if they are immutable (a Response straight from fetch/redirect), rebuild the response first. */
function editHeaders(c: Context, edit: (h: Headers) => void): void {
  try {
    edit(c.res.headers);
  } catch {
    const headers = new Headers(c.res.headers);
    edit(headers);
    c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
    // Hono's `c.res` setter copies the previous response's headers onto the replacement, which would bring the
    // upstream headers back: apply the edit again on the (now mutable) response.
    edit(c.res.headers);
  }
}

function applyNoStore(c: Context): void {
  editHeaders(c, (h) => {
    h.set('cache-control', NO_STORE);
    for (const name of CACHE_HEADERS_TO_STRIP) h.delete(name);
    h.delete('cache-tag');
  });
}

export function cachePolicy(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const safeRead = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (safeRead && c.res.status === 200 && isCacheableException(c.req.path)) {
      // A cacheable exception keeps its own Cache-Control, but never a Cache-Tag (P0-c: no tag on any response).
      editHeaders(c, (h) => h.delete('cache-tag'));
      return;
    }
    applyNoStore(c);
  };
}
