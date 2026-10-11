import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { CACHEABLE_EXCEPTIONS, NO_STORE, cachePolicy, isCacheableException } from './cache-policy.js';

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
    expect((await app.request('/v1/sets-no-store')).headers.get('cache-control')).toBe(NO_STORE);
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
