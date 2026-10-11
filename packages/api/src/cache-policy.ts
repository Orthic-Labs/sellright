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

export function isCacheableException(path: string): boolean {
  return CACHEABLE_EXCEPTIONS.some((e) => (typeof e.path === 'string' ? e.path === path : e.path.test(path)));
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
