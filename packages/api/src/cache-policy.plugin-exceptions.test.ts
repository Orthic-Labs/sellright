import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  CACHEABLE_EXCEPTIONS, NO_STORE, cachePolicy, isCacheableException, listRegisteredCacheableExceptions,
  registerCacheableExceptions, _clearRegisteredCacheableExceptionsForTest,
} from './cache-policy.js';
import { _clearApiPluginsForTest, registerApiPlugin } from './plugins.js';

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
    expect(() => registerCacheableExceptions([{ path: '/v1/pro/revocations', source: 's.ts', reason: 'r' }])).toThrow(/already registered|overlaps/);
    expect(() => registerCacheableExceptions([{ path: '/v1/shop/seo/robots.txt', source: 's.ts', reason: 'r' }])).toThrow(/already registered/);
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
