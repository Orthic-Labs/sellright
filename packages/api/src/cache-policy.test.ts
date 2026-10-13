import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { CACHEABLE_EXCEPTIONS, NO_STORE, cachePolicy, isCacheableException, isNoStoreOnly } from './cache-policy.js';

function appWithPolicy() {
  const app = new Hono();
  app.use('*', cachePolicy());
  app.get('/v1/plain', (c) => c.json({ ok: true }));
  app.get('/v1/sets-public', (c) => c.json({ ok: true }, 200, { 'cache-control': 'public, max-age=300' }));
  app.get('/v1/sets-cdn', (c) => c.json({ ok: true }, 200, { 'cdn-cache-control': 'max-age=300', 'cloudflare-cdn-cache-control': 'max-age=300', 'surrogate-control': 'max-age=300', 'cache-tag': 'product-1,stock', expires: 'Wed, 21 Oct 2037 07:28:00 GMT' }));
  app.get('/v1/sets-no-store', (c) => c.json({ ok: true }, 200, { 'cache-control': 'no-store' }));
  app.get('/v1/boom', () => { throw new Error('boom'); });
  app.get('/v1/shop/seo/robots.txt', (c) => c.text('User-agent: *', 200, { 'cache-control': 'public, max-age=300', 'cache-tag': 'robots' }));
  app.get('/v1/pro/revocations', () => new Response('{}', { status: 200, headers: { 'cache-control': 'public, max-age=60', 'cache-tag': 'revocations' } })); // listed exception returning a fetch-style Response
  app.get('/v1/boom-tagged', () => { throw new Error('boom'); });
  app.get('/v1/shop/seo/sitemap-products.xml', (c) => c.json({ error: 'siteUrl not configured' }, 503, { 'cache-control': 'public, max-age=300' }));
  app.post('/v1/shop/seo/robots.txt', (c) => c.text('x', 200, { 'cache-control': 'public, max-age=300' }));
  app.get('/v1/shop/seo/jsonld/products/some-slug', (c) => c.json({}, 200, { 'cache-control': 'public, max-age=300' }));
  app.get('/v1/redirect', () => Response.redirect('http://localhost/elsewhere', 302)); // immutable headers
  // An upstream response passed straight through (as a preRoute plugin returning fetch() would): its headers are
  // immutable AND it carries cacheable headers that must not survive.
  app.get('/v1/upstream', () => {
    const res = new Response('{"inStock":true}', { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=600', 'cdn-cache-control': 'max-age=600', 'cache-tag': 'product-1', expires: 'Thu, 01 Jan 2099 00:00:00 GMT' } });
    const frozen = new Proxy(res.headers, {
      get(target, prop) {
        if (prop === 'set' || prop === 'delete' || prop === 'append') return () => { throw new TypeError('immutable'); };
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    Object.defineProperty(res, 'headers', { get: () => frozen });
    return res;
  });
  app.onError((_err, c) => c.json({ error: 'internal' }, 500, { 'cache-control': 'public, max-age=300', 'cache-tag': 'errors' }));
  return app;
}

describe('cachePolicy middleware', () => {
  it('an immutable upstream response loses its cacheable headers (the rebuilt response is re-checked)', async () => {
    const res = await appWithPolicy().request('/v1/upstream');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('cdn-cache-control')).toBeNull();
    expect(res.headers.get('expires')).toBeNull();
    expect(res.headers.get('cache-tag')).toBeNull();
    expect(await res.text()).toBe('{"inStock":true}');
  });

  it('defaults every response, including 404, thrown errors and redirects, to private, no-store', async () => {
    const app = appWithPolicy();
    for (const path of ['/v1/plain', '/v1/missing', '/v1/boom', '/v1/redirect']) {
      const res = await app.request(path);
      expect(res.headers.get('cache-control'), path).toBe(NO_STORE);
    }
  });

  it('overrides a cacheable header set by a route that is not on the exception list', async () => {
    const app = appWithPolicy();
    const res = await app.request('/v1/sets-public');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    const cdn = await app.request('/v1/sets-cdn');
    expect(cdn.headers.get('cache-control')).toBe(NO_STORE);
    for (const h of ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'surrogate-control', 'expires', 'cache-tag']) expect(cdn.headers.get(h), h).toBeNull();
    expect((await app.request('/v1/sets-no-store')).headers.get('cache-control')).toBe('no-store'); // already forbids storing: kept verbatim
  });

  it('a cacheable exception keeps its Cache-Control but never a Cache-Tag', async () => {
    const app = appWithPolicy();
    const robots = await app.request('/v1/shop/seo/robots.txt');
    expect(robots.headers.get('cache-control')).toBe('public, max-age=300');
    expect(robots.headers.get('cache-tag')).toBeNull();
    const rev = await app.request('/v1/pro/revocations');
    expect(rev.headers.get('cache-control')).toBe('public, max-age=60');
    expect(rev.headers.get('cache-tag')).toBeNull();
  });

  it('error responses carry no Cache-Tag from the error handler', async () => {
    const res = await appWithPolicy().request('/v1/boom-tagged');
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-tag')).toBeNull();
  });

  it('error responses are no-store even when the error handler sets a cacheable header', async () => {
    const res = await appWithPolicy().request('/v1/boom');
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
  });

  it('keeps the route header only for a listed path on a 200 GET', async () => {
    const app = appWithPolicy();
    expect((await app.request('/v1/shop/seo/robots.txt')).headers.get('cache-control')).toBe('public, max-age=300');
    expect((await app.request('/v1/shop/seo/sitemap-products.xml')).headers.get('cache-control'), 'listed path but 503').toBe(NO_STORE);
    expect((await app.request('/v1/shop/seo/robots.txt', { method: 'POST' })).headers.get('cache-control'), 'listed path but POST').toBe(NO_STORE);
    expect((await app.request('/v1/shop/seo/jsonld/products/some-slug')).headers.get('cache-control'), 'product JSON-LD carries live stock').toBe(NO_STORE);
  });

  it('never lists a path that carries stock, price, cart or customer state', () => {
    for (const path of [
      '/v1/shop/catalog/products', '/v1/shop/catalog/products/x', '/v1/shop/catalog/products/x/stock', '/v1/shop/catalog/search',
      '/v1/shop/collections/x', '/v1/shop/cart/abc', '/v1/shop/checkout', '/v1/shop/config', '/v1/shop/feeds/google',
      '/v1/shop/feeds/google.csv', '/v1/shop/seo/jsonld/products/x', '/v1/shop/cache-version', '/v1/openapi.json',
    ]) {
      expect(isCacheableException(path), path).toBe(false);
    }
  });
});

/** Every non-test source file under packages/api/src, relative to it. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== 'node_modules') sourceFiles(full, out); continue; }
    if (name.endsWith('.ts') && !/\.test\.ts$|\.d\.ts$/.test(name)) out.push(relative(__SRC, full));
  }
  return out;
}
const __SRC = new URL('.', import.meta.url).pathname;

const CACHEABLE_VALUE = /public|max-age=[1-9]|s-maxage|stale-while-revalidate|stale-if-error|immutable/i;

describe('cache header inventory', () => {
  it('fails when a source file sets a cacheable Cache-Control without a CACHEABLE_EXCEPTIONS entry', () => {
    const allowedSources = new Set(CACHEABLE_EXCEPTIONS.map((e) => e.source));
    const offenders: string[] = [];
    for (const file of sourceFiles(__SRC)) {
      const text = readFileSync(join(__SRC, file), 'utf8');
      // any string literal that appears on a cache-control / cdn-cache-control / surrogate-control line
      for (const line of text.split('\n')) {
        if (!/cache-control|surrogate-control/i.test(line) || /^\s*(\/\/|\*)/.test(line)) continue;
        if (CACHEABLE_VALUE.test(line.replace(/cdn-cache-control|cloudflare-cdn-cache-control/gi, '')) && !allowedSources.has(file)) offenders.push(`${file}: ${line.trim()}`);
        if (/cdn-cache-control|surrogate-control/i.test(line) && !/cache-policy\.ts/.test(file)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every exception names a source file that really sets that cacheable header', () => {
    for (const e of CACHEABLE_EXCEPTIONS) {
      const text = readFileSync(join(__SRC, e.source), 'utf8');
      expect(text, e.source).toMatch(/cache-control['"]?\s*[:,]\s*['"]public, max-age=\d+/i);
      expect(e.reason.length, e.source).toBeGreaterThan(20);
    }
  });

  it('feeds.ts, catalog.ts and cart.ts set no cacheable header themselves', () => {
    for (const file of ['routes/feeds.ts', 'routes/catalog.ts', 'routes/cart.ts']) {
      expect(readFileSync(join(__SRC, file), 'utf8'), file).not.toMatch(/public, max-age|s-maxage/);
    }
  });
});

describe('cachePolicy keeps a handler-set no-store-only Cache-Control verbatim', () => {
  const FROZEN = 'no-cache, no-store, must-revalidate';
  function app() {
    const a = new Hono();
    a.use('*', cachePolicy());
    const set = (path: string, value: string, extra: Record<string, string> = {}) => a.get(path, (c) => c.json({ ok: true }, 200, { 'cache-control': value, ...extra }));
    set('/v1/frozen', FROZEN);
    set('/v1/private-no-store', 'private, no-store');
    set('/v1/frozen-tagged', FROZEN, { 'cache-tag': 't', 'cdn-cache-control': 'max-age=300', 'surrogate-control': 'max-age=300', expires: 'Wed, 21 Oct 2037 07:28:00 GMT' });
    set('/v1/no-store-public', 'no-store, public');
    set('/v1/no-store-max-age', 'no-store, max-age=300');
    set('/v1/no-store-s-maxage', 'no-store, s-maxage=60');
    set('/v1/no-store-swr', 'no-store, stale-while-revalidate=60');
    set('/v1/no-store-max-age-0', 'no-store, max-age=0');
    set('/v1/no-cache-only', 'no-cache');
    set('/v1/private-only', 'private');
    set('/v1/max-age-0', 'max-age=0');
    a.get('/v1/unset', (c) => c.json({ ok: true }));
    a.post('/v1/post-frozen', (c) => c.json({ ok: true }, 200, { 'cache-control': FROZEN }));
    a.get('/v1/error-frozen', (c) => c.json({ error: 'x' }, 500, { 'cache-control': FROZEN }));
    a.get('/v1/redirect-frozen', () => new Response(null, { status: 302, headers: { location: '/x', 'cache-control': FROZEN } }));
    a.get('/v1/immutable-frozen', () => {
      const res = new Response('{}', { status: 200, headers: { 'cache-control': FROZEN, 'cache-tag': 't', 'cdn-cache-control': 'max-age=300' } });
      const frozen = new Proxy(res.headers, {
        get(target, prop) {
          if (prop === 'set' || prop === 'delete' || prop === 'append') return () => { throw new TypeError('immutable'); };
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      Object.defineProperty(res, 'headers', { get: () => frozen });
      return res;
    });
    return a;
  }
  const cc = async (path: string, init?: RequestInit) => (await app().request(path, init)).headers.get('cache-control');

  it('keeps no-cache, no-store, must-revalidate and private, no-store exactly, on any route', async () => {
    expect(await cc('/v1/frozen')).toBe(FROZEN);
    expect(await cc('/v1/private-no-store')).toBe('private, no-store');
  });

  it('keeps it on a non-GET, an error status and a redirect too', async () => {
    expect(await cc('/v1/post-frozen', { method: 'POST' })).toBe(FROZEN);
    expect(await cc('/v1/error-frozen')).toBe(FROZEN);
    expect(await cc('/v1/redirect-frozen')).toBe(FROZEN);
  });

  it('still strips cache-tag and every CDN/surrogate header', async () => {
    const res = await app().request('/v1/frozen-tagged');
    expect(res.headers.get('cache-control')).toBe(FROZEN);
    for (const h of ['cache-tag', 'cdn-cache-control', 'cloudflare-cdn-cache-control', 'surrogate-control', 'expires']) expect(res.headers.get(h), h).toBeNull();
  });

  it('strips them on an immutable upstream response as well, keeping the value', async () => {
    const res = await app().request('/v1/immutable-frozen');
    expect(res.headers.get('cache-control')).toBe(FROZEN);
    expect(res.headers.get('cache-tag')).toBeNull();
    expect(res.headers.get('cdn-cache-control')).toBeNull();
    expect(await res.text()).toBe('{}');
  });

  it('never keeps a value that grants any caching: it becomes private, no-store', async () => {
    for (const path of ['/v1/no-store-public', '/v1/no-store-max-age', '/v1/no-store-s-maxage', '/v1/no-store-swr']) {
      expect(await cc(path), path).toBe(NO_STORE);
    }
  });

  it('only a value containing no-store is kept: no-cache, private, max-age=0 or none are unchanged behaviour (private, no-store)', async () => {
    for (const path of ['/v1/no-cache-only', '/v1/private-only', '/v1/max-age-0', '/v1/unset']) {
      expect(await cc(path), path).toBe(NO_STORE);
    }
    expect(await cc('/v1/no-store-max-age-0')).toBe('no-store, max-age=0');
  });

  it('isNoStoreOnly', () => {
    for (const v of ['no-store', 'private, no-store', 'no-cache, no-store, must-revalidate', 'No-Store', 'NO-STORE, No-Cache', 'no-store, max-age=0', 'no-store, max-age=00', 'no-store, s-maxage=0, proxy-revalidate']) expect(isNoStoreOnly(v), v).toBe(true);
    for (const v of [null, '', 'public', 'private', 'no-cache', 'max-age=0', 'public, max-age=300', 'no-store, public', 'no-store, max-age=1', 'no-store, max-age = 30', 'x-no-store', 'example="no-store"', 'no-store="x"', ',no-store', 'no-store,,private', 'no-store, max-age=01', 'no-store, max-age=1', 'no-store, max-age="0"', 'no-store, foo', 'no-store, no-transform', 'no-store, max-age', 'no-store, max-age=-1', 'no-store x', 'no-store, s-maxage=5', 'no-store, immutable', 'no-store, stale-if-error=5']) expect(isNoStoreOnly(v), String(v)).toBe(false);
  });

  it('a registered or static exception behaves as before (kept only when cacheable; a no-store handler value stays no-store)', async () => {
    const a = new Hono();
    a.use('*', cachePolicy());
    a.get('/v1/pro/revocations', (c) => c.json({}, 200, { 'cache-control': 'public, max-age=60', 'cache-tag': 'x' }));
    const res = await a.request('/v1/pro/revocations');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.headers.get('cache-tag')).toBeNull();
  });
});

describe('cachePolicy strict no-store parse, at middleware level', () => {
  const FROZEN = 'no-cache, no-store, must-revalidate';
  const run = async (value: string | string[], path = '/v1/x', init: RequestInit = {}, status = 200) => {
    const a = new Hono();
    a.use('*', cachePolicy());
    a.all(path, (c) => {
      const headers = new Headers();
      for (const v of Array.isArray(value) ? value : [value]) headers.append('cache-control', v);
      headers.set('cache-tag', 't');
      headers.set('cdn-cache-control', 'max-age=300');
      return new Response('{}', { status, headers });
    });
    return a.request(path, init);
  };
  const cc = async (value: string | string[], path?: string, init?: RequestInit, status?: number) => (await run(value, path, init, status)).headers.get('cache-control');

  it('rewrites look-alikes, quoted values and malformed lists to private, no-store', async () => {
    for (const v of ['x-no-store', 'example="no-store"', 'no-store="x"', 'no-store, public', ',no-store', 'no-store,,private', 'no-store, max-age=01', 'no-store, max-age=1', 'no-store, max-age="0"', 'no-store, foo', 'no-store, stale-if-error=0', 'no-cache', 'private']) {
      expect(await cc(v), v).toBe(NO_STORE);
    }
  });

  it('keeps zero-valued max-age and any-case names verbatim', async () => {
    expect(await cc('no-store, max-age=00')).toBe('no-store, max-age=00');
    expect(await cc('no-store, max-age=0, s-maxage=0')).toBe('no-store, max-age=0, s-maxage=0');
    expect(await cc('NO-STORE, No-Cache')).toBe('NO-STORE, No-Cache');
    expect(await cc(FROZEN)).toBe(FROZEN);
  });

  it('combines duplicate Cache-Control headers: one that grants caching rewrites the whole thing', async () => {
    expect(await cc(['no-store', 'public, max-age=300'])).toBe(NO_STORE);
    expect(await cc(['no-store', 'max-age=1'])).toBe(NO_STORE);
    expect(await cc(['no-cache', 'no-store'])).toBe('no-cache, no-store');
  });

  it('applies on a stock route path, HEAD and non-200 statuses, always stripping cache-tag and CDN headers', async () => {
    const stock = await run(FROZEN, '/v1/shop/catalog/products/x/stock');
    expect(stock.headers.get('cache-control')).toBe(FROZEN);
    expect((await run('no-store, public', '/v1/shop/catalog/products/x/stock')).headers.get('cache-control')).toBe(NO_STORE);
    const head = await run(FROZEN, '/v1/x', { method: 'HEAD' });
    expect(head.headers.get('cache-control')).toBe(FROZEN);
    for (const status of [404, 500]) {
      const res = await run(FROZEN, '/v1/x', {}, status);
      expect(res.status).toBe(status);
      expect(res.headers.get('cache-control')).toBe(FROZEN);
      expect(res.headers.get('cache-tag')).toBeNull();
      expect(res.headers.get('cdn-cache-control')).toBeNull();
      expect((await run('public, max-age=300', '/v1/x', {}, status)).headers.get('cache-control')).toBe(NO_STORE);
    }
  });

  // Header values above U+00FF cannot be set on a real Headers object, so the value is presented through a headers view; the policy
  // reads exactly what a handler could have produced.
  const viewed = async (value: string) => {
    const a = new Hono();
    a.use('*', cachePolicy());
    a.get('/v1/x', () => {
      const res = new Response('{}', { status: 200 });
      let overridden = true;
      const view = new Proxy(res.headers, {
        get(target, prop) {
          if (prop === 'set') return (name: string, v: string) => { if (name.toLowerCase() === 'cache-control') overridden = false; target.set(name, v); };
          if (prop === 'get') return (name: string) => (overridden && name.toLowerCase() === 'cache-control' ? value : target.get(name));
          if (prop === 'has') return (name: string) => (overridden && name.toLowerCase() === 'cache-control') || target.has(name);
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      Object.defineProperty(res, 'headers', { get: () => view });
      return res;
    });
    const out = await a.request('/v1/x');
    return out.headers.get('cache-control');
  };

  it('trims only HTTP optional whitespace: any other leading/trailing character fails closed', async () => {
    for (const ws of ['\u00a0', '\u2003', '\ufeff', '\v', '\f', '\u0085', '\u1680', '\u2028']) {
      for (const v of [`${ws}no-store`, `no-store${ws}`, `no-store,${ws}no-cache`, `no-store${ws}, no-cache`, `no-store, no-cache${ws}`]) {
        expect(isNoStoreOnly(v), JSON.stringify(v)).toBe(false);
        expect(await viewed(v), JSON.stringify(v)).toBe(NO_STORE);
      }
    }
  });

  it('a real header carrying U+00A0 or \v around a directive is rewritten at middleware level', async () => {
    for (const v of ['\u00a0no-store', 'no-store\u00a0', 'no-store,\u00a0no-cache', 'no-store, no-cache\u00a0']) {
      expect(await cc(v), JSON.stringify(v)).toBe(NO_STORE);
    }
  });

  it('space and tab around directives are still fine', async () => {
    expect(isNoStoreOnly(' no-store ')).toBe(true);
    expect(isNoStoreOnly('\tno-store,\tno-cache\t')).toBe(true);
    expect(await viewed('no-store,\tno-cache')).toBe('no-store,\tno-cache');
    expect(await viewed('no-cache, no-store')).toBe('no-cache, no-store');
    expect(await cc('no-store, no-cache')).toBe('no-store, no-cache');
  });
});

