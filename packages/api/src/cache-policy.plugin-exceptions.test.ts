import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  validateCacheableExceptions, isDeniedCachePath,
  CACHEABLE_EXCEPTIONS, NO_STORE, type CacheableException, cachePolicy, isCacheableException, listRegisteredCacheableExceptions,
  registerCacheableExceptions, _clearRegisteredCacheableExceptionsForTest,
} from './cache-policy.js';
import { _clearApiPluginsForTest, registerApiPlugin } from './plugins.js';
import { buildHttpApp } from './app.js';
import type { CacheableException as PublicCacheableException, EngineContext, EnginePlugin } from './sdk/index.js'; // the package entry's public types

afterEach(() => {
  _clearApiPluginsForTest();
  _clearRegisteredCacheableExceptionsForTest();
});

const STATUS = { path: /^\/v1\/apps\/[A-Za-z0-9_-]+\/releases\/status\.json$/, source: 'rightsites-plugin/release-routes.ts', reason: 'public release status: latest published version numbers only, same for every visitor, no stock' };
const PATCHES = { path: '/releases/patches.json', source: 'rightsites-plugin/release-routes.ts', reason: 'signed security-patch manifest, same for every visitor, no stock' };

function app() {
  const a = new Hono();
  a.use('*', cachePolicy());
  const pub = (c: import('hono').Context) => c.json({ ok: true }, 200, { 'cache-control': 'public, max-age=300', 'cache-tag': 't' });
  a.get('/releases/patches.json', pub);
  a.post('/releases/patches.json', pub);
  a.get('/v1/apps/viewright/releases/status.json', pub);
  a.get('/v1/apps/viewright/releases/other.json', pub);
  a.get('/releases/fails.json', (c) => c.json({ error: 'x' }, 500, { 'cache-control': 'public, max-age=300' }));
  a.get('/v1/shop/catalog/products', pub);
  return a;
}

describe('registerCacheableExceptions', () => {
  it('a registered path keeps its header on GET 200 (and loses cache-tag)', async () => {
    registerCacheableExceptions([PATCHES, STATUS]);
    for (const path of ['/releases/patches.json', '/v1/apps/viewright/releases/status.json']) {
      const res = await app().request(path);
      expect(res.headers.get('cache-control'), path).toBe('public, max-age=300');
      expect(res.headers.get('cache-tag'), path).toBeNull();
    }
    expect(isCacheableException('/releases/patches.json')).toBe(true);
  });

  it('is a no-op for paths that are not registered, and before registration', async () => {
    expect((await app().request('/releases/patches.json')).headers.get('cache-control')).toBe(NO_STORE);
    registerCacheableExceptions([PATCHES]);
    expect((await app().request('/v1/apps/viewright/releases/other.json')).headers.get('cache-control')).toBe(NO_STORE);
    expect((await app().request('/v1/shop/catalog/products')).headers.get('cache-control')).toBe(NO_STORE);
  });

  it('a registered path is forced to no-store on POST and on a 500', async () => {
    registerCacheableExceptions([PATCHES, { path: '/releases/fails.json', source: 'x.ts', reason: 'registered but handler errors' }]);
    expect((await app().request('/releases/patches.json', { method: 'POST' })).headers.get('cache-control')).toBe(NO_STORE);
    const fail = await app().request('/releases/fails.json');
    expect(fail.status).toBe(500);
    expect(fail.headers.get('cache-control')).toBe(NO_STORE);
  });

  it('throws for hard-denied paths, strings and RegExps, and registers nothing', () => {
    const mk = (path: string | RegExp) => ({ path, source: 's.ts', reason: 'r' });
    for (const p of [
      '/v1/shop/catalog/products', '/v1/shop/catalog', '/v1/shop/cart/abc', '/v1/checkout', '/v1/checkout/x', '/v1/shop/checkout',
      '/v1/shop/feeds/google', '/v1/shop/feeds/google.csv', '/v1/shop/catalog/products/x/stock', '/v1/stock', '/v1/shop/stock-levels',
      '/v1/admin/apps/releases', '/v1/account/me', '/v1/orders/1', '/v1/shop/pricing',
    ]) {
      expect(() => registerCacheableExceptions([mk(p)]), p).toThrow(/deny list/);
    }
    for (const r of [/^\/v1\/shop\/catalog\/.*$/, /^\/v1\/shop\/[a-z]+\/.*$/, /^\/v1\/.*$/, /^\/v1\/shop\/cart\/[a-z]+$/, /^\/v1\/shop\/feeds\/google(\.csv)?$/]) {
      expect(() => registerCacheableExceptions([mk(r)]), String(r)).toThrow(/hard-denied/);
    }
    expect(listRegisteredCacheableExceptions()).toEqual([]);
  });

  it('throws for a duplicate: of the static list, an earlier registration, or within one batch', () => {
    expect(() => registerCacheableExceptions([{ path: '/v1/pro/revocations', source: 's.ts', reason: 'r' }])).toThrow(/already registered or overlaps/);
    expect(() => registerCacheableExceptions([{ path: '/v1/shop/seo/robots.txt', source: 's.ts', reason: 'r' }])).toThrow(/deny list/); // static shop paths are denied for plugins outright
    registerCacheableExceptions([PATCHES]);
    expect(() => registerCacheableExceptions([PATCHES])).toThrow(/already registered/);
    registerCacheableExceptions([STATUS]);
    expect(() => registerCacheableExceptions([{ path: new RegExp(STATUS.path.source), source: 's.ts', reason: 'r' }])).toThrow(/already registered/);
    expect(() => registerCacheableExceptions([{ path: '/v1/apps/viewright/releases/status.json', source: 's.ts', reason: 'r' }])).toThrow(/overlaps/);
    _clearRegisteredCacheableExceptionsForTest();
    const dup = { path: '/dup.json', source: 's.ts', reason: 'r' };
    expect(() => registerCacheableExceptions([dup, dup])).toThrow(/already registered/);
    expect(listRegisteredCacheableExceptions()).toEqual([]);
  });

  it('requires a non-empty source and reason, an absolute path, and an anchored RegExp', () => {
    expect(() => registerCacheableExceptions([{ path: '/a.json', source: '', reason: 'r' }])).toThrow(/source/);
    expect(() => registerCacheableExceptions([{ path: '/a.json', source: '  ', reason: 'r' }])).toThrow(/source/);
    expect(() => registerCacheableExceptions([{ path: '/a.json', source: 's.ts', reason: '' }])).toThrow(/reason/);
    expect(() => registerCacheableExceptions([{ path: 'a.json', source: 's.ts', reason: 'r' }])).toThrow(/absolute/);
    expect(() => registerCacheableExceptions([{ path: /\/a\.json/, source: 's.ts', reason: 'r' }])).toThrow(/anchored/);
    expect(listRegisteredCacheableExceptions()).toEqual([]);
  });

  it('is all-or-nothing: one bad entry in a batch registers none', () => {
    expect(() => registerCacheableExceptions([PATCHES, { path: '/v1/shop/cart/x', source: 's.ts', reason: 'r' }])).toThrow();
    expect(isCacheableException('/releases/patches.json')).toBe(false);
  });

  it('leaves the static list untouched', () => {
    const before = CACHEABLE_EXCEPTIONS.length;
    registerCacheableExceptions([PATCHES]);
    expect(CACHEABLE_EXCEPTIONS.length).toBe(before);
    expect(isCacheableException('/v1/pro/revocations')).toBe(true);
  });

  it('registerApiPlugin applies cacheableExceptions atomically with the plugin', () => {
    registerApiPlugin({ name: 'rs', routes: new OpenAPIHono(), cacheableExceptions: [PATCHES, STATUS] });
    expect(isCacheableException('/v1/apps/viewright/releases/status.json')).toBe(true);
    expect(() => registerApiPlugin({ name: 'bad', cacheableExceptions: [{ path: '/v1/shop/cart/1', source: 's.ts', reason: 'r' }] })).toThrow();
    expect(() => registerApiPlugin({ name: 'rs', cacheableExceptions: [{ path: '/x.json', source: 's.ts', reason: 'r' }] })).toThrow(/already registered/);
    _clearApiPluginsForTest();
    expect(isCacheableException('/releases/patches.json')).toBe(false);
  });
});

describe('runtime deny enforcement (registered entries cannot reach protected routes)', () => {
  // Passes source inspection and every fixed probe, but matches /v1/shop/cart/123 and the product JSON-LD route at request time.
  const LOOSE = /^\/v1\/[a-z]+\/[a-z]+\/[0-9]+$/;
  const LOOSE2 = /^\/v1\/[a-z]+\/[a-z]+\/[a-z]+\/[a-z]+\/[0-9]+$/;

  function adversarialApp() {
    const a = new Hono();
    a.use('*', cachePolicy());
    const pub = (c: import('hono').Context) => c.json({ price: 1, stock: 2 }, 200, { 'cache-control': 'public, max-age=300' });
    for (const p of ['/v1/shop/cart/123', '/v1/shop/catalog/products/1', '/v1/orders/9', '/v1/apps/viewright/123', '/v1/shop/seo/jsonld/products/1', '/v1/shop/seo/jsonld/products/x/1']) a.get(p, pub);
    return a;
  }

  it('a loose RegExp registers but never makes a protected path cacheable', async () => {
    registerCacheableExceptions([{ path: LOOSE, source: 's.ts', reason: 'loose' }, { path: LOOSE2, source: 's.ts', reason: 'loose2' }]);
    const a = adversarialApp();
    for (const p of ['/v1/shop/cart/123', '/v1/shop/catalog/products/1', '/v1/orders/9', '/v1/shop/seo/jsonld/products/1']) {
      expect((await a.request(p)).headers.get('cache-control'), p).toBe(NO_STORE);
    }
    expect((await a.request('/v1/shop/seo/jsonld/products/x/1')).headers.get('cache-control')).toBe(NO_STORE);
    expect((await a.request('/v1/apps/viewright/123')).headers.get('cache-control'), 'a non-denied match still keeps its header').toBe('public, max-age=300');
  });

  it('the deny check sees encoded, upper-cased and slash-doubled forms', () => {
    for (const p of ['/v1/shop/%63art/1', '/V1/Shop/Cart/1', '//v1//shop//cart/1', '/v1/x/%2573tock', '/v1/x/stock.json', '/v1/x/products']) expect(isDeniedCachePath(p), p).toBe(true);
    for (const p of ['/v1/apps/viewright/releases/status.json', '/releases/patches.json', '/v1/pro/revocations']) expect(isDeniedCachePath(p), p).toBe(false);
  });

  it('exact and regex registration of every protected family throws, including product JSON-LD and products', () => {
    const mk = (path: string | RegExp) => ({ path, source: 's.ts', reason: 'r' });
    for (const p of ['/v1/shop/seo/jsonld/products/x', '/v1/shop/seo/jsonld/products', '/v1/x/products', '/v1/x/jsonld/y', '/v1/shop/collections/x', '/v1/shop/config', '/v1/shop/cache-version', '/v1/openapi.json']) {
      expect(() => registerCacheableExceptions([mk(p)]), p).toThrow(/deny list/);
    }
    for (const r of [/^\/v1\/shop\/seo\/jsonld\/products\/[^/]+$/, /^\/v1\/x\/products\/[^/]+$/, /^\/v1\/x\/jsonld\/[^/]+$/]) {
      expect(() => registerCacheableExceptions([mk(r)]), String(r)).toThrow(/hard-denied/);
    }
    expect(listRegisteredCacheableExceptions()).toEqual([]);
  });

  it('the shared policy also guards entries validated for an SDK plugin', () => {
    expect(() => validateCacheableExceptions([{ path: '/v1/shop/seo/jsonld/products/x', source: 's.ts', reason: 'r' }], CACHEABLE_EXCEPTIONS)).toThrow(/deny list/);
  });
});

describe('overlap detection is order independent', () => {
  const mk = (path: string | RegExp) => ({ path, source: 's.ts', reason: 'r' });
  it('string after a matching regex, and regex after a matching string, both throw', () => {
    registerCacheableExceptions([mk(/^\/v1\/apps\/[a-z]+\/releases\/status\.json$/)]);
    expect(() => registerCacheableExceptions([mk('/v1/apps/viewright/releases/status.json')])).toThrow(/overlaps/);
    _clearRegisteredCacheableExceptionsForTest();
    registerCacheableExceptions([mk('/v1/apps/viewright/releases/status.json')]);
    expect(() => registerCacheableExceptions([mk(/^\/v1\/apps\/[a-z]+\/releases\/status\.json$/)])).toThrow(/overlaps/);
  });
  it('a regex that matches a static exception throws, and a string matched by a static regex throws', () => {
    expect(() => registerCacheableExceptions([mk(/^\/v1\/pro\/[a-z]+$/)])).toThrow(/overlaps/);
    expect(() => validateCacheableExceptions([mk('/v1/pro/revocations')], CACHEABLE_EXCEPTIONS)).toThrow(/overlaps/);
  });
  it('overlap inside one batch, either order', () => {
    expect(() => registerCacheableExceptions([mk('/v1/apps/a/releases/status.json'), mk(/^\/v1\/apps\/[a-z]+\/releases\/status\.json$/)])).toThrow(/overlaps/);
    expect(() => registerCacheableExceptions([mk(/^\/v1\/apps\/[a-z]+\/releases\/status\.json$/), mk('/v1/apps/a/releases/status.json')])).toThrow(/overlaps/);
    expect(listRegisteredCacheableExceptions()).toEqual([]);
  });
});

describe('RegExp flags', () => {
  it('rejects g and y flags', () => {
    for (const flags of ['g', 'y', 'gi']) {
      expect(() => registerCacheableExceptions([{ path: new RegExp('^/a\\.json$', flags), source: 's.ts', reason: 'r' }]), flags).toThrow(/g or y flag/);
    }
  });
  it('repeated identical requests behave identically (no lastIndex state)', async () => {
    registerCacheableExceptions([{ path: /^\/rel\/[a-z]+\.json$/i, source: 's.ts', reason: 'r' }]);
    const a = new Hono();
    a.use('*', cachePolicy());
    a.get('/rel/x.json', (c) => c.json({}, 200, { 'cache-control': 'public, max-age=300' }));
    for (let i = 0; i < 6; i += 1) expect((await a.request('/rel/x.json')).headers.get('cache-control'), `request ${i}`).toBe('public, max-age=300');
    for (let i = 0; i < 3; i += 1) expect(isCacheableException('/rel/x.json')).toBe(true);
  });
});

describe('SDK EnginePlugin.cacheableExceptions (consumed through buildHttpApp)', () => {
  const ctx = {} as EngineContext;
  const entry: PublicCacheableException = { path: '/rs/patches.json', source: 'rs/release-routes.ts', reason: 'signed patch manifest, same for every visitor, no stock' };
  function plugin(name: string, extra: Partial<EnginePlugin> = {}): EnginePlugin {
    const routes = new OpenAPIHono();
    routes.get('/rs/patches.json', (c) => c.json({ ok: true }, 200, { 'cache-control': 'public, max-age=300', 'cache-tag': 't' }));
    routes.post('/rs/patches.json', (c) => c.json({ ok: true }, 200, { 'cache-control': 'public, max-age=300' }));
    routes.get('/rs/other.json', (c) => c.json({ ok: true }, 200, { 'cache-control': 'public, max-age=300' }));
    return { name, routes, cacheableExceptions: [entry], ...extra };
  }

  it('a plugin-declared path keeps its header on GET 200, is no-store on POST, and unlisted paths stay no-store', async () => {
    const app = buildHttpApp({ plugins: [plugin('rs')], ctx });
    const ok = await app.request('/rs/patches.json');
    expect(ok.headers.get('cache-control')).toBe('public, max-age=300');
    expect(ok.headers.get('cache-tag')).toBeNull();
    expect((await app.request('/rs/patches.json', { method: 'POST' })).headers.get('cache-control')).toBe(NO_STORE);
    expect((await app.request('/rs/other.json')).headers.get('cache-control')).toBe(NO_STORE);
  });

  it('is scoped to the app instance: another app without the plugin, and a rebuild, are unaffected', async () => {
    const withPlugin = buildHttpApp({ plugins: [plugin('rs')], ctx });
    const rebuilt = buildHttpApp({ plugins: [plugin('rs')], ctx }); // same entry again: no global duplicate error
    const without = buildHttpApp({ plugins: [{ name: 'plain', routes: plugin('x').routes }], ctx });
    expect((await withPlugin.request('/rs/patches.json')).headers.get('cache-control')).toBe('public, max-age=300');
    expect((await rebuilt.request('/rs/patches.json')).headers.get('cache-control')).toBe('public, max-age=300');
    expect((await without.request('/rs/patches.json')).headers.get('cache-control')).toBe(NO_STORE);
    expect(isCacheableException('/rs/patches.json')).toBe(false);
  });

  it('startup throws for a denied path, a missing source/reason, a duplicate across plugins, and a static duplicate', () => {
    const bad = (e: CacheableException) => () => buildHttpApp({ plugins: [plugin('rs', { cacheableExceptions: [e] })], ctx });
    expect(bad({ path: '/v1/shop/seo/jsonld/products/x', source: 's.ts', reason: 'r' })).toThrow(/deny list/);
    expect(bad({ path: '/v1/shop/cart/1', source: 's.ts', reason: 'r' })).toThrow(/deny list/);
    expect(bad({ path: '/a.json', source: '', reason: 'r' })).toThrow(/source/);
    expect(bad({ path: '/a.json', source: 's.ts', reason: ' ' })).toThrow(/reason/);
    expect(bad({ path: '/v1/pro/revocations', source: 's.ts', reason: 'r' })).toThrow(/overlaps/);
    expect(() => buildHttpApp({ plugins: [plugin('a'), plugin('b')], ctx })).toThrow(/overlaps/);
  });

  it('a loose SDK RegExp still cannot cache a protected route', async () => {
    const routes = new OpenAPIHono();
    routes.get('/v1/shop/cart/123', (c) => c.json({ stock: 1 }, 200, { 'cache-control': 'public, max-age=300' }));
    routes.get('/v1/apps/viewright/123', (c) => c.json({ ok: 1 }, 200, { 'cache-control': 'public, max-age=300' }));
    const app = buildHttpApp({ plugins: [{ name: 'loose', routes, cacheableExceptions: [{ path: /^\/v1\/[a-z]+\/[a-z]+\/[0-9]+$/, source: 's.ts', reason: 'loose' }] }], ctx });
    expect((await app.request('/v1/shop/cart/123')).headers.get('cache-control')).toBe(NO_STORE);
    expect((await app.request('/v1/apps/viewright/123')).headers.get('cache-control')).toBe('public, max-age=300');
  });
});

describe('registered exceptions: handler-set header, credentials, licensed update routes', () => {
  const mk = (path: string | RegExp) => ({ path, source: 's.ts', reason: 'r' });
  const FEEDS = [
    mk(/^\/v1\/apps\/[A-Za-z0-9_-]+\/releases\/status\.json$/),
    mk('/releases/patches.json'),
  ];

  function engineLikeApp() {
    const a = new Hono();
    a.use('*', cachePolicy());
    // The engine's licensed handlers: 200 with NO Cache-Control of their own (routes/apps.ts).
    a.get('/releases/latest.json', (c) => c.json({ manifest: { url: 'signed' } }, 200));
    a.get('/v1/apps/viewright/updates/latest', (c) => c.json({ eligible: true, manifest: {} }, 200));
    // The two intended RightSites feeds: handler-set public, max-age=300.
    a.get('/v1/apps/viewright/releases/status.json', (c) => c.json({ ok: true }, 200, { 'cache-control': 'public, max-age=300' }));
    a.get('/releases/patches.json', (c) => c.json({ ok: true }, 200, { 'cache-control': 'public, max-age=300' }));
    // Registered but the handler sets a non-cacheable or no value.
    a.get('/releases/none.json', (c) => c.json({}, 200));
    a.get('/releases/nostore.json', (c) => c.json({}, 200, { 'cache-control': 'private, no-store' }));
    a.get('/releases/nocache.json', (c) => c.json({}, 200, { 'cache-control': 'no-cache, max-age=300' }));
    return a;
  }

  it('an overlapping plugin regex or exact path cannot cache the licensed latest.json / updates/latest 200', async () => {
    // Registration itself rejects these (probe match); inject them into the live list as if a registration had slipped past
    // the probes, to prove the request-time guards (deny policy, handler-set rule, credential gate) hold on their own.
    for (const exceptions of [
      [mk(/^\/releases\/[a-z]+\.json$/)],
      [mk(/^\/v1\/apps\/[a-z]+\/[a-z]+\/[a-z]+$/)],
      [mk('/releases/latest.json'), mk('/v1/apps/viewright/updates/latest')],
    ]) {
      _clearRegisteredCacheableExceptionsForTest();
      (listRegisteredCacheableExceptions() as CacheableException[]).push(...exceptions);
      const a = engineLikeApp();
      for (const p of ['/releases/latest.json', '/v1/apps/viewright/updates/latest']) {
        const res = await a.request(p, { headers: { authorization: 'Bearer act-token' } });
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control'), p).toBe(NO_STORE);
      }
      // Even with no credentials the deny policy and the handler-set rule keep these no-store.
      expect((await a.request('/releases/latest.json')).headers.get('cache-control')).toBe(NO_STORE);
      expect((await a.request('/v1/apps/viewright/updates/latest')).headers.get('cache-control')).toBe(NO_STORE);
    }
  });

  it('exact registration of latest / updates paths throws; so do regexes that match them', () => {
    for (const p of ['/releases/latest.json', '/v1/apps/viewright/updates/latest', '/v1/apps/viewright/updates/x', '/v1/apps/viewright/releases/latest.json', '/x/latest']) {
      expect(() => registerCacheableExceptions([mk(p)]), p).toThrow(/deny list/);
    }
    for (const r of [/^\/releases\/[a-z]+\.json$/ /* matches /releases/latest.json via probe */, /^\/v1\/apps\/[a-z]+\/updates\/[a-z]+$/]) {
      expect(() => registerCacheableExceptions([mk(r)]), String(r)).toThrow(/hard-denied/);
    }
  });

  it('the two intended RightSites feeds stay cacheable (handler-set public, max-age=300)', async () => {
    registerCacheableExceptions(FEEDS);
    const a = engineLikeApp();
    expect((await a.request('/v1/apps/viewright/releases/status.json')).headers.get('cache-control')).toBe('public, max-age=300');
    expect((await a.request('/releases/patches.json', { headers: { 'x-viewright-app': 'viewright' } })).headers.get('cache-control'), 'an app-identifier header is not a credential').toBe('public, max-age=300');
  });

  it('the same feed path becomes no-store when the request carries a credential', async () => {
    registerCacheableExceptions(FEEDS);
    const a = engineLikeApp();
    for (const headers of [
      { authorization: 'Bearer x' }, { cookie: 'sr_admin=abc' }, { 'x-viewright-license': 'key' }, { 'x-api-key': 'k' }, { 'proxy-authorization': 'Basic x' },
    ]) {
      for (const p of ['/v1/apps/viewright/releases/status.json', '/releases/patches.json']) {
        expect((await a.request(p, { headers })).headers.get('cache-control'), `${p} ${Object.keys(headers)[0]}`).toBe(NO_STORE);
      }
    }
  });

  it('a registered path whose handler set no cacheable Cache-Control gets no-store', async () => {
    registerCacheableExceptions([mk('/releases/none.json'), mk('/releases/nostore.json'), mk('/releases/nocache.json')]);
    const a = engineLikeApp();
    for (const p of ['/releases/none.json', '/releases/nostore.json', '/releases/nocache.json']) {
      expect((await a.request(p)).headers.get('cache-control'), p).toBe(NO_STORE);
    }
  });

  it('static exceptions keep current behaviour: no credential gate, header kept as the handler set it', async () => {
    const a = new Hono();
    a.use('*', cachePolicy());
    a.get('/v1/pro/revocations', (c) => c.json({ ids: [] }, 200, { 'cache-control': 'public, max-age=60' }));
    expect((await a.request('/v1/pro/revocations', { headers: { authorization: 'Bearer x' } })).headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('the same rules hold for SDK plugin exceptions (buildHttpApp)', async () => {
    const routes = new OpenAPIHono();
    routes.get('/rs/manifest.json', (c) => c.json({ ok: true }, 200, { 'cache-control': 'public, max-age=300' }));
    routes.get('/rs/silent.json', (c) => c.json({ ok: true }, 200));
    const app = buildHttpApp({ ctx: {} as EngineContext, plugins: [{ name: 'rs', routes, cacheableExceptions: [mk('/rs/manifest.json'), mk('/rs/silent.json')] }] });
    expect((await app.request('/rs/manifest.json')).headers.get('cache-control')).toBe('public, max-age=300');
    expect((await app.request('/rs/manifest.json', { headers: { authorization: 'Bearer x' } })).headers.get('cache-control')).toBe(NO_STORE);
    expect((await app.request('/rs/silent.json')).headers.get('cache-control')).toBe(NO_STORE);
  });
});

describe('licence header name comes from the engine configuration, not only process.env', () => {
  const mk = (path: string) => ({ path, source: 's.ts', reason: 'r' });
  it('an SDK ctx env that differs from process.env still gates the custom licence header', async () => {
    const saved = process.env.APPS_LICENSE_HEADER;
    delete process.env.APPS_LICENSE_HEADER;
    try {
      const routes = new OpenAPIHono();
      routes.get('/rs/manifest.json', (c) => c.json({ ok: true }, 200, { 'cache-control': 'public, max-age=300' }));
      const ctx = { env: { APPS_LICENSE_HEADER: 'x-custom-license' } } as unknown as EngineContext;
      const app = buildHttpApp({ ctx, plugins: [{ name: 'rs', routes, cacheableExceptions: [mk('/rs/manifest.json')] }] });
      expect((await app.request('/rs/manifest.json')).headers.get('cache-control')).toBe('public, max-age=300');
      expect((await app.request('/rs/manifest.json', { headers: { 'x-custom-license': 'key' } })).headers.get('cache-control')).toBe(NO_STORE);
      // an app built with the default config does not treat that header as a credential
      const plain = buildHttpApp({ ctx: {} as EngineContext, plugins: [{ name: 'rs', routes, cacheableExceptions: [mk('/rs/manifest.json')] }] });
      expect((await plain.request('/rs/manifest.json', { headers: { 'x-custom-license': 'key' } })).headers.get('cache-control')).toBe('public, max-age=300');
    } finally {
      if (saved === undefined) delete process.env.APPS_LICENSE_HEADER; else process.env.APPS_LICENSE_HEADER = saved;
    }
  });

  it('the initialised engine env (peekEnv) is honoured by a standalone cachePolicy', async () => {
    const { initEnv, _resetEnvForTest } = await import('./env.js');
    const saved = process.env.APPS_LICENSE_HEADER;
    delete process.env.APPS_LICENSE_HEADER;
    _resetEnvForTest();
    try {
      initEnv({ ...process.env, NODE_ENV: 'test', APPS_LICENSE_HEADER: 'x-engine-license' });
      registerCacheableExceptions([mk('/rs/feedless.json')]);
      const a = new Hono();
      a.use('*', cachePolicy());
      a.get('/rs/feedless.json', (c) => c.json({}, 200, { 'cache-control': 'public, max-age=300' }));
      expect((await a.request('/rs/feedless.json')).headers.get('cache-control')).toBe('public, max-age=300');
      expect((await a.request('/rs/feedless.json', { headers: { 'x-engine-license': 'k' } })).headers.get('cache-control')).toBe(NO_STORE);
    } finally {
      _resetEnvForTest();
      if (saved !== undefined) process.env.APPS_LICENSE_HEADER = saved;
    }
  });
});
