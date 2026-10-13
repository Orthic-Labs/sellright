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
 * the `cacheableExceptions` field on `EnginePlugin` (validated and applied by `buildHttpApp` per app) or, for a legacy
 * `ApiPlugin`, `registerCacheableExceptions(entries)` / its `cacheableExceptions` field (applied by `registerApiPlugin`). Registered entries are appended to the live set and follow the same rule
 * as the static list: kept only on a 200 GET/HEAD, forced to `private, no-store` on any other method or status, and
 * `cache-tag` is always stripped. Registered entries are stricter in two ways: the response is kept only when the handler
 * ITSELF set a cacheable Cache-Control (public / s-maxage / max-age>0; none, no-store, no-cache or private gets no-store),
 * and never when the request carries a credential (Authorization, Cookie, licence/activation token headers). Registration is fail-closed and all-or-nothing: every entry needs a non-empty
 * `source` and `reason`; an absolute path (or an anchored RegExp without g/y flags); no duplicate or overlap (string/regex in
 * both directions, regex/regex by identity) with the static list, an earlier registration or another plugin; and it must
 * not fall under the hard deny list (`isDeniedCachePath`: all of /v1/shop, product JSON-LD, products, catalog, cart,
 * checkout, stock, feeds, per-visitor paths). The deny list is ALSO checked against the real request path before a
 * registered exception is honoured, so a loose RegExp cannot make a protected route cacheable; static entries are exempt. The static list and its
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

/** Entries added by legacy `ApiPlugin`s at boot (registerCacheableExceptions); read live by every request. */
const registeredExceptions: CacheableException[] = [];

function matches(e: CacheableException, path: string): boolean {
  return typeof e.path === 'string' ? e.path === path : e.path.test(path);
}

/**
 * Hard deny policy for PLUGIN-registered exceptions, applied at registration AND to every request path before a
 * registered exception is honoured (so a loose RegExp can never make a protected route cacheable). Static entries are
 * exempt: they are reviewed in this file. Denied: everything under `/v1/shop/` (catalog, products, product JSON-LD with
 * live price + stock, collections, cart, checkout, config, feeds, cache-version), `/v1/openapi.json`, and any path
 * segment naming stock, inventory, availability, price, product(s), catalog, cart, checkout, feed(s), collections,
 * jsonld, `latest` (licensed update manifests: /releases/latest.json, /v1/apps/x/updates/latest, /v1/apps/x/releases/latest.json),
 * everything under /v1/apps/x/updates/, or a per-visitor surface (admin, account, auth, orders, customer, session, me).
 */
const DENIED_PREFIX = /^\/v1\/(shop|checkout)(\/|$)|^\/v1\/openapi\.json$|^\/v1\/apps\/[^/]*\/updates(\/|$)/;
const DENIED_SEGMENT = /(^|\/)(stock|stocks|inventory|availability|prices?|pricing|products?|catalog|cart|carts|checkout|feeds?|collections?|jsonld|latest|admin|account|accounts|auth|orders?|customers?|sessions?|me)(?=[/.\-_]|$)/;

function decodeLoose(path: string): string {
  let out = path;
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch { break; }
  }
  return out;
}

/** True when `path` may never be cacheable by a plugin exception. Checks the raw and the decoded, lower-cased, slash-collapsed forms. */
export function isDeniedCachePath(path: string): boolean {
  const forms = new Set([path, decodeLoose(path)].map((p) => p.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/\.(?=\/|$)/g, '')));
  return [...forms].some((p) => DENIED_PREFIX.test(p) || DENIED_SEGMENT.test(p));
}

/** Sample denied paths a RegExp entry must not match at registration (defence in depth; the runtime check is the enforcement). */
const DENIED_PROBES: readonly string[] = [
  '/v1/shop/catalog', '/v1/shop/catalog/products', '/v1/shop/catalog/products/x', '/v1/shop/catalog/products/x/stock',
  '/v1/shop/catalog/search', '/v1/shop/cart', '/v1/shop/cart/abc', '/v1/shop/checkout', '/v1/checkout', '/v1/checkout/x',
  '/v1/shop/feeds/google', '/v1/shop/feeds/google.csv', '/v1/stock', '/v1/shop/stock/x', '/v1/shop/seo/jsonld/products/x',
  '/releases/latest.json', '/v1/apps/viewright/updates/latest', '/v1/apps/viewright/updates/x', '/v1/apps/viewright/releases/latest.json',
  '/v1/shop/collections/x', '/v1/shop/config', '/v1/admin/apps/releases', '/v1/account/me', '/v1/auth/login', '/v1/orders/1',
];

/** A fresh, stateless copy: a `g`/`y` flag would make `.test()` depend on `lastIndex`. */
function stateless(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.replace(/[gy]/g, ''));
}

function assertNotDenied(e: CacheableException): void {
  const label = String(e.path);
  if (typeof e.path === 'string') {
    if (isDeniedCachePath(e.path)) throw new Error(`cacheable exception ${label} is on the hard deny list (shop, catalog, products, product JSON-LD, cart, checkout, stock, feeds and per-visitor paths can never be cacheable)`);
    return;
  }
  if (isDeniedCachePath(e.path.source.replace(/\\\//g, '/'))) throw new Error(`cacheable exception ${label} targets a hard-denied path`);
  const re = stateless(e.path);
  for (const probe of DENIED_PROBES) {
    if (re.test(probe)) throw new Error(`cacheable exception ${label} matches hard-denied path ${probe}`);
  }
}

function sameKey(a: CacheableException['path'], b: CacheableException['path']): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (typeof a !== 'string' && typeof b !== 'string') return a.source === b.source && a.flags === b.flags;
  return false;
}

/** Whether two entries can both match some path. Decidable for string/string and string/regex (both directions); two regexes are compared by identity only. */
function overlaps(a: CacheableException, b: CacheableException): boolean {
  if (sameKey(a.path, b.path)) return true;
  if (typeof a.path === 'string') return matches(b, a.path);
  if (typeof b.path === 'string') return matches(a, b.path);
  return false;
}

/**
 * Validate `entries` against the hard deny policy and against `existing` (the static list plus anything already
 * registered); returns normalised copies (stateless RegExps). Throws on the first problem; nothing is stored here.
 */
export function validateCacheableExceptions(entries: readonly CacheableException[], existing: readonly CacheableException[]): CacheableException[] {
  const staged: CacheableException[] = [];
  for (const e of entries) {
    const label = String(e?.path);
    if (typeof e?.source !== 'string' || e.source.trim() === '') throw new Error(`cacheable exception ${label} requires a non-empty source`);
    if (typeof e.reason !== 'string' || e.reason.trim() === '') throw new Error(`cacheable exception ${label} requires a non-empty reason`);
    if (typeof e.path === 'string') {
      if (!e.path.startsWith('/')) throw new Error(`cacheable exception ${label} must be an absolute path starting with "/"`);
    } else if (e.path instanceof RegExp) {
      if (/[gy]/.test(e.path.flags)) throw new Error(`cacheable exception ${label} must not use the g or y flag (stateful matching)`);
      if (!e.path.source.startsWith('^') || !e.path.source.endsWith('$')) throw new Error(`cacheable exception ${label} must be an anchored RegExp (^...$)`);
    } else {
      throw new Error('cacheable exception path must be a string or RegExp');
    }
    assertNotDenied(e);
    const norm: CacheableException = { path: typeof e.path === 'string' ? e.path : stateless(e.path), source: e.source, reason: e.reason };
    const clash = [...existing, ...staged].find((x) => overlaps(x, norm));
    if (clash) throw new Error(`cacheable exception ${label} is already registered or overlaps ${String(clash.path)}`);
    staged.push(norm);
  }
  return staged;
}

/** A path an entry may keep its header for: matches, and (for non-static entries) is not hard-denied at request time. */
function matchesAny(list: readonly CacheableException[], path: string, enforceDeny: boolean): boolean {
  if (!list.some((e) => matches(e, path))) return false;
  return !(enforceDeny && isDeniedCachePath(path));
}

/** On the static, reviewed list. */
export function isStaticCacheableException(path: string): boolean {
  return matchesAny(CACHEABLE_EXCEPTIONS, path, false);
}

/** On a plugin-registered list (global legacy registrations or `extra`), and not hard-denied for this request path. */
export function isRegisteredCacheableException(path: string, extra: readonly CacheableException[] = []): boolean {
  return matchesAny(registeredExceptions, path, true) || matchesAny(extra, path, true);
}

export function isCacheableException(path: string, extra: readonly CacheableException[] = []): boolean {
  return isStaticCacheableException(path) || isRegisteredCacheableException(path, extra);
}

/** Request headers that carry a credential or an activation/license token; a response to such a request is never shared-cacheable via a registered exception. */
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-viewright-license', 'x-activation-token'];

function credentialHeaders(): string[] {
  // The licence header name is env-configurable (APPS_LICENSE_HEADER); read it raw so the policy never forces an env parse.
  const configured = process.env.APPS_LICENSE_HEADER?.trim().toLowerCase();
  return configured ? [...CREDENTIAL_HEADERS, configured] : CREDENTIAL_HEADERS;
}

function carriesCredentials(c: Context): boolean {
  return credentialHeaders().some((h) => Boolean(c.req.header(h)));
}

// Handler-set value counts as cacheable only when explicit and free of no-store / no-cache / private.
function handlerSetCacheable(value: string | null): boolean {
  if (!value) return false;
  if (/\b(no-store|no-cache|private)\b/i.test(value)) return false;
  return /\bpublic\b|\bs-maxage=[1-9]|\bmax-age=[1-9]/i.test(value);
}

/** Read-only view of the legacy-plugin-registered entries (diagnostics, tests). */
export function listRegisteredCacheableExceptions(): readonly CacheableException[] {
  return registeredExceptions;
}

/** Test-only: drop every plugin-registered exception (the static list is untouched). */
export function _clearRegisteredCacheableExceptionsForTest(): void {
  registeredExceptions.length = 0;
}

/**
 * Append plugin-owned stock-free routes to the cacheable set. All-or-nothing: any invalid entry throws and nothing is
 * registered. Call before `createApp()` (the policy reads the set per request, so earlier is simply safer).
 * SDK `EnginePlugin`s declare `cacheableExceptions` instead; `buildHttpApp` validates and applies them per app.
 */
export function registerCacheableExceptions(entries: readonly CacheableException[]): void {
  registeredExceptions.push(...validateCacheableExceptions(entries, [...CACHEABLE_EXCEPTIONS, ...registeredExceptions]));
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

export interface CachePolicyOptions {
  /** Already-validated per-app exceptions (SDK `EnginePlugin.cacheableExceptions`, from `validateCacheableExceptions`). */
  extraExceptions?: readonly CacheableException[];
}

export function cachePolicy(options: CachePolicyOptions = {}): MiddlewareHandler {
  const extra = options.extraExceptions ?? [];
  return async (c, next) => {
    await next();
    const safeRead = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (safeRead && c.res.status === 200) {
      // Static (reviewed) exceptions keep their own Cache-Control; so do registered (plugin) ones, but only when the handler itself set a
      // cacheable value (a handler that sets none, e.g. an authenticated licence check, gets no-store) and the request carried no credentials.
      const keep = isStaticCacheableException(c.req.path)
        || (isRegisteredCacheableException(c.req.path, extra) && !carriesCredentials(c) && handlerSetCacheable(c.res.headers.get('cache-control')));
      if (keep) {
        // Never a Cache-Tag (P0-c: no tag on any response).
        editHeaders(c, (h) => h.delete('cache-tag'));
        return;
      }
    }
    applyNoStore(c);
  };
}
