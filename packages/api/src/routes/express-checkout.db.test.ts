/**
 * Express checkout (Apple Pay / Google Pay) server contract, DB integration. Synthetic disposable fixtures.
 *   POST /v1/shop/cart/{token}/express-quote — server total for a wallet-supplied country before any order exists
 *   POST /v1/shop/checkout                   — the same order path; acceptedQuoteHash rejects a changed total
 *   POST /v1/shop/orders/{code}/payment-intent with x-expected-amount — refuses to mint for a total the wallet never showed
 * Stripe is mocked at the seam (mint only); no live Stripe call is made.
 */
import { requireDisposablePostgresUrl } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mints: Array<{ amount: number; orderCode: string }> = [];
vi.mock('../payments/stripe.js', async (orig) => {
  const actual = await orig<typeof import('../payments/stripe.js')>();
  return {
    ...actual,
    resolveStripeUsable: async () => true,
    stripeModeFromConfig: () => 'test' as const,
    createPaymentIntent: vi.fn(async (o: { orderCode: string; amount: number; idempotencyKey?: string }) => {
      mints.push({ amount: o.amount, orderCode: o.orderCode });
      return { clientSecret: `pi_${o.idempotencyKey}_secret`, intentId: `pi_${o.idempotencyKey}` };
    }),
  };
});
vi.mock('../payments/provider.js', async (orig) => {
  const actual = await orig<typeof import('../payments/provider.js')>();
  return { ...actual, isPaymentMethodEnabled: () => true };
});
vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: () => undefined }));

import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { _setRateLimitBackendForTest, createMemoryRateLimitBackend } from '../auth/rate-limit-backend.js';
import { invalidateStoreCache } from '../store-context.js';
import { cart } from './cart.js';
import { checkout } from './checkout.js';
import { pay } from './pay.js';

requireDisposablePostgresUrl(process.env.DATABASE_URL ?? env.DATABASE_URL, 'express-checkout.db.test.ts');
const STORE = 'e7e7e7e7-0000-4000-8000-000000000001';
const PRODUCT = 'e7e7e7e7-0000-4000-8000-000000000002';
const VARIANT = 'e7e7e7e7-0000-4000-8000-000000000003';
const SLUG = 'synthetic-express-checkout';
const SKU = 'EXPRESS-SYNTHETIC';
const app = new OpenAPIHono(); app.route('/', cart); app.route('/', checkout); app.route('/', pay);
const headers = { 'content-type': 'application/json', 'x-store-slug': SLUG };

type Quote = { requiresShipping: boolean; shippingMethodCode: string | null; methods: Array<{ code: string; name: string; rate: number }>;
  cart: { token: string; revision: number; grandTotal: number; shippingTotal: number; taxTotal: number; quoteHash: string; shippingMethodCode: string | null; unavailable: string[] } };

beforeEach(async () => {
  _setRateLimitBackendForTest(createMemoryRateLimitBackend());
  mints.length = 0;
  await pool.query('TRUNCATE store CASCADE');
  await withStore(STORE, async (tx) => {
    await tx.insert(s.store).values({ id: STORE, slug: SLUG, name: 'Synthetic express', currency: 'USD', taxRate: 0, shippingTaxable: true,
      config: { payments: { stripe: true }, stripe: { mode: 'test' } } });
    await tx.insert(s.product).values({ id: PRODUCT, storeId: STORE, slug: 'synthetic-express', name: 'Synthetic', status: 'active' });
    await tx.insert(s.productVariant).values({ id: VARIANT, storeId: STORE, productId: PRODUCT, sku: SKU, name: 'Synthetic', price: 2500, fulfillmentType: 'physical' });
    await tx.insert(s.stock).values({ variantId: VARIANT, storeId: STORE, onHand: 5, allocated: 0 });
    await tx.insert(s.shippingMethod).values([
      { storeId: STORE, code: 'standard', name: 'Standard', calculator: { flat: 500, countries: ['US', 'CA'] } },
      { storeId: STORE, code: 'express', name: 'Express', calculator: { flat: 1500, countries: ['US'] } },
    ]);
    // Destination tax: the wallet's country decides the rate, exactly as checkout does.
    await tx.insert(s.taxZone).values({ storeId: STORE, name: 'US', countries: ['US'], rate: 1000 });
  });
  invalidateStoreCache();
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); await pool.end(); });

async function newCart(quantity = 1) {
  const res = await app.request('/v1/shop/cart', { method: 'POST', headers, body: JSON.stringify({ items: [{ sku: SKU, quantity }] }) });
  expect(res.status).toBe(200);
  return await res.json() as { token: string; revision: number };
}
const quote = (token: string, body: Record<string, unknown>) =>
  app.request(`/v1/shop/cart/${token}/express-quote`, { method: 'POST', headers, body: JSON.stringify(body) });
const place = (token: string, revision: number, body: Record<string, unknown>) => app.request('/v1/shop/checkout', { method: 'POST',
  headers: { ...headers, 'idempotency-key': `express-${token}-${String(body.acceptedQuoteHash).slice(0, 8)}` },
  body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }], cartToken: token, expectedRevision: revision, email: 'wallet@example.invalid',
    shippingAddress: { fullName: 'Wallet Buyer', line1: '1 Test St', city: 'Testville', province: 'CA', postalCode: '94000', country: 'US' }, ...body }) });

describe('express checkout quote', () => {
  it('prices a wallet country server-side, cheapest eligible method first, identical to the checkout cart read', async () => {
    const c = await newCart();
    const res = await quote(c.token, { country: 'us' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const q = await res.json() as Quote;
    expect(q.requiresShipping).toBe(true);
    expect(q.methods).toEqual([{ code: 'standard', name: 'Standard', rate: 500 }, { code: 'express', name: 'Express', rate: 1500 }]);
    expect(q.shippingMethodCode).toBe('standard');
    expect(q.cart).toMatchObject({ token: c.token, shippingMethodCode: 'standard', shippingTotal: 500, taxTotal: 300, grandTotal: 3300, unavailable: [] });
    // The same quote the storefront's pre-submit live read gets, so its hash is what checkout re-verifies.
    const read = await app.request(`/v1/shop/cart/${c.token}?${new URLSearchParams({ pricingIntent: 'checkout', shipCountry: 'US', shippingMethodCode: 'standard' })}`, { headers });
    expect((await read.json() as { quoteHash: string }).quoteHash).toBe(q.cart.quoteHash);
  });

  it('follows a wallet shipping-rate change and a destination with no tax zone', async () => {
    const c = await newCart();
    const express = await (await quote(c.token, { country: 'US', shippingMethodCode: 'express' })).json() as Quote;
    expect(express.shippingMethodCode).toBe('express');
    expect(express.methods[0]!.code).toBe('standard');
    expect(express.cart.grandTotal).toBe(4400);
    const ca = await (await quote(c.token, { country: 'CA', shippingMethodCode: 'express' })).json() as Quote;
    // Express does not ship to CA: the requested method is replaced by the cheapest eligible one.
    expect(ca.methods.map((m) => m.code)).toEqual(['standard']);
    expect(ca.cart).toMatchObject({ shippingMethodCode: 'standard', taxTotal: 0, grandTotal: 3000 });
  });

  it('fails closed: unserviceable country, sold-out line, unknown and converted carts', async () => {
    const c = await newCart();
    const fr = await quote(c.token, { country: 'FR' });
    expect(fr.status).toBe(409);
    expect(await fr.json()).toMatchObject({ error: { code: 'SHIPPING_UNAVAILABLE' }, reason: 'not_eligible' });
    await withStore(STORE, (tx) => tx.update(s.stock).set({ onHand: 0 }).where(eq(s.stock.variantId, VARIANT)));
    const sold = await quote(c.token, { country: 'US' });
    expect(sold.status).toBe(409);
    expect(await sold.json()).toMatchObject({ error: { code: 'OUT_OF_STOCK' }, skus: [SKU] });
    expect((await quote('no-such-cart', { country: 'US' })).status).toBe(404);
    expect((await quote(c.token, { country: 'USA' })).status).toBe(400);
    await withStore(STORE, (tx) => tx.update(s.cart).set({ status: 'converted' }).where(eq(s.cart.token, c.token)));
    const converted = await quote(c.token, { country: 'US' });
    expect(converted.status).toBe(409);
    expect(await converted.json()).toMatchObject({ error: { code: 'CART_INVALID' } });
  });
});

describe('express checkout order + payment', () => {
  it('creates the order through checkout at the wallet total and mints only for that amount', async () => {
    const c = await newCart();
    const q = await (await quote(c.token, { country: 'US', shippingMethodCode: 'express' })).json() as Quote;
    const placed = await place(c.token, q.cart.revision, { shippingMethodCode: 'express', acceptedQuoteHash: q.cart.quoteHash });
    expect(placed.status).toBe(200);
    const order = await placed.json() as { code: string; grandTotal: number; receiptToken: string; state: string };
    expect(order).toMatchObject({ grandTotal: q.cart.grandTotal, state: 'PendingPayment' });
    const mint = (expected: number) => app.request(`/v1/shop/orders/${order.code}/payment-intent`, { method: 'POST',
      headers: { ...headers, 'x-receipt-token': order.receiptToken, 'x-expected-amount': String(expected) } });
    const mismatch = await mint(q.cart.grandTotal - 1);
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ error: { code: 'AMOUNT_MISMATCH' }, amountDue: q.cart.grandTotal });
    expect(mints).toEqual([]);
    const ok = await mint(q.cart.grandTotal);
    expect(ok.status).toBe(200);
    expect(mints).toEqual([{ amount: q.cart.grandTotal, orderCode: order.code }]);
  });

  it('rejects an order whose server total differs from the wallet quote (no order, no stock taken)', async () => {
    const c = await newCart();
    const standard = await (await quote(c.token, { country: 'US' })).json() as Quote;
    // The wallet showed the standard-shipping total, but the confirm carries another method: the server reprices and refuses.
    const placed = await place(c.token, standard.cart.revision, { shippingMethodCode: 'express', acceptedQuoteHash: standard.cart.quoteHash });
    expect(placed.status).toBe(409);
    expect(await placed.json()).toMatchObject({ error: { code: 'QUOTE_CHANGED' } });
    const orders = await withStore(STORE, (tx) => tx.select({ id: s.order.id }).from(s.order));
    expect(orders).toEqual([]);
    const [stock] = await withStore(STORE, (tx) => tx.select({ allocated: s.stock.allocated }).from(s.stock).where(eq(s.stock.variantId, VARIANT)));
    expect(stock!.allocated).toBe(0);
  });
});
