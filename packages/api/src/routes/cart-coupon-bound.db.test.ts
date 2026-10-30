// G4: a public request may name at most MAX_COUPON_CODES_PER_REQUEST coupon codes (was 100), bounding the
// per-request promotion resolution work. Stored carts keep working; only new request input is bounded.
import { beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool } from '../db/client.js';
import { env } from '../env.js';
import { requireDisposablePostgresUrl } from '../db/test-database-url.js';
import { _setRateLimitBackendForTest, createMemoryRateLimitBackend } from '../auth/rate-limit-backend.js';
import { invalidateStoreCache } from '../store-context.js';
import { seedImportedCartSeams } from '../import/cart-stack.testkit.js';
import { cart, MAX_COUPON_CODES_PER_REQUEST } from './cart.js';
import { checkout } from './checkout.js';

requireDisposablePostgresUrl(process.env.DATABASE_URL ?? env.DATABASE_URL, 'cart-coupon-bound.db.test.ts');
const STORE = 'cccccccc-abcf-4000-8000-000000000001';
const PRODUCT = 'cccccccc-abcf-4000-8000-000000000002';
const VARIANT = 'cccccccc-abcf-4000-8000-000000000003';
const CUSTOMER = 'cccccccc-abcf-4000-8000-000000000004';
const app = new OpenAPIHono(); app.route('/', cart); app.route('/', checkout);
const headers = { 'content-type': 'application/json', 'x-store-slug': 'synthetic-cart-seams' };
beforeEach(async () => {
  _setRateLimitBackendForTest(createMemoryRateLimitBackend());
  await pool.query('TRUNCATE store CASCADE');
  await seedImportedCartSeams(STORE, PRODUCT, VARIANT, CUSTOMER);
  invalidateStoreCache();
});
const codes = (n: number) => Array.from({ length: n }, (_, i) => `NOPE-${i}`);
const post = (path: string, body: unknown, method = 'POST') => app.request(path, { method, headers, body: JSON.stringify(body) });

describe('G4 coupon code bound per request', () => {
  it('is 20', () => expect(MAX_COUPON_CODES_PER_REQUEST).toBe(20));

  it('estimate admits the bound and rejects one more', async () => {
    const items = [{ sku: 'UNKNOWN-1', quantity: 1 }];
    expect((await post('/v1/shop/cart/estimate', { items, couponCodes: codes(20) })).status).toBe(200);
    expect((await post('/v1/shop/cart/estimate', { items, couponCodes: codes(21) })).status).toBe(400);
  });

  it('cart create, line update and GET query reject more than the bound', async () => {
    expect((await post('/v1/shop/cart', { items: [], couponCodes: codes(21) })).status).toBe(400);
    const created = await post('/v1/shop/cart', { items: [], couponCodes: codes(2) });
    expect(created.status).toBe(200);
    const { token } = await created.json() as { token: string };
    expect((await post('/v1/shop/cart/' + token + '/lines', { lines: [], couponCodes: codes(21) }, 'PATCH')).status).toBe(400);
    const q = encodeURIComponent(JSON.stringify(codes(21)));
    expect((await app.request('/v1/shop/cart/' + token + '?couponCodes=' + q, { headers })).status).toBe(400);
    const ok = encodeURIComponent(JSON.stringify(codes(20)));
    expect((await app.request('/v1/shop/cart/' + token + '?couponCodes=' + ok, { headers })).status).toBe(200);
  });
});
