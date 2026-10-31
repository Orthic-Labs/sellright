/**
 * #412: GET /v1/shop/cart/{token}?includeShippingMethods=1 — the cart read also returns the shipping quote for the cart and
 * `shipCountry` (the same quote POST /v1/shop/shipping-methods gives for the cart's lines and coupons), and the cart priced with
 * the selected method (the requested one while eligible, else the cheapest). Without the flag the read is unchanged.
 * Synthetic disposable fixtures; runs against a *_test database only.
 */
import { requireDisposablePostgresUrl } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: () => undefined }));

import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { _setRateLimitBackendForTest, createMemoryRateLimitBackend } from '../auth/rate-limit-backend.js';
import { invalidateStoreCache } from '../store-context.js';
import { cart } from './cart.js';
import { shopExtra } from './shop-extra.js';

requireDisposablePostgresUrl(process.env.DATABASE_URL ?? env.DATABASE_URL, 'cart-shipping-quote.db.test.ts');
const STORE = 'f4120000-0000-4000-8000-000000000001';
const PRODUCT = 'f4120000-0000-4000-8000-000000000002';
const VARIANT = 'f4120000-0000-4000-8000-000000000003';
const SLUG = 'synthetic-cart-shipping-quote';
const SKU = 'SHIPQUOTE-SYNTHETIC';
const app = new OpenAPIHono(); app.route('/', cart); app.route('/', shopExtra);
const headers = { 'content-type': 'application/json', 'x-store-slug': SLUG };

type Read = { revision: number; shippingMethodCode: string | null; shippingTotal: number; grandTotal: number; quoteHash: string;
  shippingQuote?: { country: string; methods: Array<{ code: string; name: string; rate: number; price: number }>; freeShipping: { threshold: number; remaining: number } | null } };

beforeEach(async () => {
  _setRateLimitBackendForTest(createMemoryRateLimitBackend());
  await pool.query('TRUNCATE store CASCADE');
  await withStore(STORE, async (tx) => {
    await tx.insert(s.store).values({ id: STORE, slug: SLUG, name: 'Synthetic ship quote', currency: 'USD', taxRate: 0, shippingTaxable: true });
    await tx.insert(s.product).values({ id: PRODUCT, storeId: STORE, slug: 'synthetic-ship-quote', name: 'Synthetic', status: 'active' });
    await tx.insert(s.productVariant).values({ id: VARIANT, storeId: STORE, productId: PRODUCT, sku: SKU, name: 'Synthetic', price: 2500, fulfillmentType: 'physical' });
    await tx.insert(s.stock).values({ variantId: VARIANT, storeId: STORE, onHand: 5, allocated: 0 });
    await tx.insert(s.shippingMethod).values([
      { storeId: STORE, code: 'express', name: 'Express', calculator: { flat: 1500, countries: ['US'] } },
      { storeId: STORE, code: 'standard', name: 'Standard', calculator: { flat: 500, countries: ['US', 'CA'] } },
      { storeId: STORE, code: 'free', name: 'Free', calculator: { flat: 0, min: 10000, countries: ['US'] } },
    ]);
    await tx.insert(s.taxZone).values({ storeId: STORE, name: 'US', countries: ['US'], rate: 1000 });
  });
  invalidateStoreCache();
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); await pool.end(); });

async function newCart(quantity = 1) {
  const res = await app.request('/v1/shop/cart', { method: 'POST', headers, body: JSON.stringify({ items: [{ sku: SKU, quantity }] }) });
  expect(res.status).toBe(200);
  return await res.json() as { token: string };
}
const read = async (token: string, query: Record<string, string>) => {
  const res = await app.request(`/v1/shop/cart/${token}?${new URLSearchParams(query)}`, { headers });
  expect(res.status).toBe(200);
  return await res.json() as Read;
};
const postQuote = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const res = await app.request('/v1/shop/shipping-methods', { method: 'POST', headers, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return await res.json() as Record<string, unknown>;
};

describe('cart read with includeShippingMethods', () => {
  it('returns the POST /v1/shop/shipping-methods quote and the cart priced with the cheapest method: the entry waterfall in one read', async () => {
    const c = await newCart();
    const one = await read(c.token, { pricingIntent: 'checkout', shipCountry: 'us', includeShippingMethods: '1' });
    const { country, ...quote } = one.shippingQuote!;
    expect(country).toBe('US');
    expect(quote).toEqual(await postQuote({ country: 'US', items: [{ sku: SKU, quantity: 1 }] }));
    expect(quote.freeShipping).toEqual({ threshold: 10000, remaining: expect.any(Number) });
    expect(one).toMatchObject({ shippingMethodCode: 'standard', shippingTotal: 500 });
    // Identical to the method-priced read it replaces.
    const priced = await read(c.token, { pricingIntent: 'checkout', shipCountry: 'us', shippingMethodCode: 'standard' });
    expect(priced.shippingQuote).toBeUndefined();
    expect(priced.quoteHash).toBe(one.quoteHash);
    expect(priced.grandTotal).toBe(one.grandTotal);
  });

  it("keeps the shopper's method while it is eligible, else the cheapest", async () => {
    const c = await newCart();
    expect(await read(c.token, { pricingIntent: 'checkout', shipCountry: 'US', shippingMethodCode: 'express', includeShippingMethods: '1' }))
      .toMatchObject({ shippingMethodCode: 'express', shippingTotal: 1500 });
    const ca = await read(c.token, { pricingIntent: 'checkout', shipCountry: 'CA', shippingMethodCode: 'express', includeShippingMethods: '1' });
    expect(ca.shippingQuote!.methods.map((m) => m.code)).toEqual(['standard']);
    expect(ca).toMatchObject({ shippingMethodCode: 'standard', shippingTotal: 500 });
  });

  it('crossing a free-shipping threshold is quoted exactly as the POST quotes it', async () => {
    const c = await newCart(4);
    const one = await read(c.token, { pricingIntent: 'checkout', shipCountry: 'US', includeShippingMethods: '1' });
    expect(one.shippingQuote).toEqual({ country: 'US', ...await postQuote({ country: 'US', items: [{ sku: SKU, quantity: 4 }] }) });
    expect(one).toMatchObject({ shippingMethodCode: 'free', shippingTotal: 0 });
  });

  it('no flag, an invalid country or no eligible method: the plain read, unchanged', async () => {
    const c = await newCart();
    const plain = await read(c.token, { pricingIntent: 'checkout', shipCountry: 'US' });
    expect(plain.shippingQuote).toBeUndefined();
    expect(plain.shippingMethodCode).toBeNull();
    expect((await read(c.token, { pricingIntent: 'checkout', shipCountry: 'US', includeShippingMethods: '0' })).shippingQuote).toBeUndefined();
    const bad = await read(c.token, { pricingIntent: 'checkout', shipCountry: 'USA', includeShippingMethods: '1' });
    expect(bad.shippingQuote).toBeUndefined();
    const fr = await read(c.token, { pricingIntent: 'checkout', shipCountry: 'FR', includeShippingMethods: '1' });
    expect(fr.shippingQuote!.methods).toEqual([]);
    expect(fr.shippingMethodCode).toBeNull();
  });

  it('a sold-out line has no methods, as the POST reports', async () => {
    const c = await newCart();
    await withStore(STORE, (tx) => tx.update(s.stock).set({ onHand: 0 }).where(eq(s.stock.variantId, VARIANT)));
    const one = await read(c.token, { pricingIntent: 'checkout', shipCountry: 'US', includeShippingMethods: '1' });
    expect(one.shippingQuote).toEqual({ country: 'US', methods: [], freeShipping: null });
  });
});
