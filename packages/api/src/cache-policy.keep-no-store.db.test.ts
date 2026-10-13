/**
 * Through the real app (`buildHttpApp`, every built-in middleware, a plugin mounted via `registerApiPlugin`): a handler-set
 * Cache-Control that already forbids storing is kept verbatim, anything that grants caching still becomes `private, no-store`,
 * and the stock-bearing built-in routes are unchanged. DB-required (the app resolves stores through the pool); the pure policy
 * is covered by ./cache-policy.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { buildHttpApp } from './app.js';
import { pool } from './db/client.js';
import { assertTestDatabase } from './db/rls-test-utils.js';
import { env } from './env.js';
import { _clearApiPluginsForTest, registerApiPlugin } from './plugins.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'cache-policy.keep-no-store.db.test.ts');

const FROZEN = 'no-cache, no-store, must-revalidate';
const STORE = 'eeeeeee6-6666-6666-6666-666666666666';
const SLUG = 'keepnostore-a';
let app: OpenAPIHono;

beforeAll(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, 'Keep', 'USD', '{}'::jsonb)`, [STORE, SLUG]);
  const routes = new OpenAPIHono();
  const set = (path: string, value: string, extra: Record<string, string> = {}) => routes.get(path, (c) => c.json({ ok: true }, 200, { 'cache-control': value, ...extra }));
  set('/rs/frozen.json', FROZEN, { 'cache-tag': 't', 'cdn-cache-control': 'max-age=300' });
  set('/rs/bare-no-store.json', 'no-store');
  set('/rs/public.json', 'public, max-age=300');
  set('/rs/no-store-public.json', 'no-store, max-age=300');
  routes.post('/rs/frozen-post.json', (c) => c.json({ ok: true }, 200, { 'cache-control': FROZEN }));
  registerApiPlugin({ name: 'keep-no-store-test', routes });
  app = buildHttpApp();
});

afterAll(async () => {
  _clearApiPluginsForTest();
  await pool.query('TRUNCATE store CASCADE');
});

const req = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { 'x-store-slug': SLUG, ...(init.headers as Record<string, string> | undefined) } });

describe('handler-set no-store is kept verbatim through the real app', () => {
  it('keeps no-cache, no-store, must-revalidate and a bare no-store; drops cache-tag and CDN headers', async () => {
    const frozen = await req('/rs/frozen.json');
    expect(frozen.status).toBe(200);
    expect(frozen.headers.get('cache-control')).toBe(FROZEN);
    expect(frozen.headers.get('cache-tag')).toBeNull();
    expect(frozen.headers.get('cdn-cache-control')).toBeNull();
    expect((await req('/rs/bare-no-store.json')).headers.get('cache-control')).toBe('no-store');
    expect((await req('/rs/frozen-post.json', { method: 'POST' })).headers.get('cache-control')).toBe(FROZEN);
  });

  it('never makes anything more cacheable', async () => {
    expect((await req('/rs/public.json')).headers.get('cache-control')).toBe('private, no-store');
    expect((await req('/rs/no-store-public.json')).headers.get('cache-control')).toBe('private, no-store');
  });

  it('built-in stock-bearing routes and 404s stay private, no-store', async () => {
    for (const path of ['/v1/shop/catalog/products', '/v1/shop/catalog/products/nope/stock', '/v1/shop/cart/does-not-exist', '/v1/definitely/not/a/route']) {
      expect((await req(path)).headers.get('cache-control'), path).toBe('private, no-store');
    }
  });
});
