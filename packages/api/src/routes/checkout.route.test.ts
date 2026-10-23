/**
 * TEST-1: DB integration tests for POST /v1/shop/checkout — the highest-value
 * revenue path. Drives the real Hono handler through app.request() with a
 * seeded store, mirroring checkout-migration.test.ts's conventions (withStore
 * seeds, x-store-slug header, TRUNCATE store CASCADE wipe). No Stripe involved
 * (checkout only creates a PendingPayment order; payment is a separate step),
 * so nothing needs mocking here.
 *
 * Runs against sellright_test ONLY (these wipe data). vitest runs files
 * serially (fileParallelism: false).
 *
 * Covers:
 *   1. server recomputes price — a tampered client unit price is ignored
 *   2. stock is reserved atomically — oversell returns 409 with blocked SKUs
 *   3. Idempotency-Key double-submit returns the SAME order (one order created)
 *   4. a valid coupon is applied and the usage limit is enforced
 *   5. an empty cart (converted/invalid cartToken) returns 409
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { checkoutIpRetryAfter, clearLoginAttempts } from '../auth/rate-limit.js';
import { rateLimitBackend } from '../auth/rate-limit-backend.js';
import * as customerSessions from '../auth/session.js';
import { checkout } from './checkout.js';
import { cart } from './cart.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'checkout.route.test.ts');

const STORE = 'aaaaaaaa-1111-1111-1111-111111111111';
const SLUG = 'checkout-route-test-store';
const OTHER_STORE = 'aaaaaaaa-1111-1111-1111-222222222222';
const OTHER_SLUG = 'checkout-route-other-store';
const CUSTOMER_A = 'aaaaaaaa-1111-1111-1111-1111111111c1';
const CUSTOMER_B = 'aaaaaaaa-1111-1111-1111-1111111111c2';
const PRODUCT = 'aaaaaaaa-1111-1111-1111-1111111111a1';
const VARIANT = 'aaaaaaaa-1111-1111-1111-1111111111b1';
const SKU = 'CKR-SKU-1';
const PRICE = 5000; // cents — the true server price; a tampered client price must be ignored
const SHIPPING_CODE = 'test-standard';

const app = new OpenAPIHono();
app.route('/', checkout);
app.route('/', cart);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

/** Seed store + one DIGITAL variant with stock. Most route tests exercise
 * pricing/idempotency/coupon/tax, not physical-shipping selection. The two
 * explicit stock-reservation cases opt the fixture into a physical variant
 * below so we preserve real inventory-allocation coverage as well. */
async function seed(opts: { onHand?: number } = {}): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, tax_rate) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', 0) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PRODUCT}, ${STORE}, 'ckr-prod', 'CKR Product', 'active') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type) VALUES (${VARIANT}, ${STORE}, ${PRODUCT}, ${SKU}, 'CKR Variant', ${PRICE}, 'digital_download') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, ${opts.onHand ?? 10}, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = ${opts.onHand ?? 10}, allocated = 0`);
  });
}

/** Switch the seeded variant to physical and add a valid zero-cost shipping
 * method. Stock reservation is intentionally only meaningful for shippable
 * inventory; the server-authoritative shipping rule still remains exercised. */
async function makePhysical(onHand: number): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.update(s.productVariant).set({ fulfillmentType: 'physical' }).where(eq(s.productVariant.id, VARIANT));
    await tx.update(s.stock).set({ onHand, allocated: 0 }).where(eq(s.stock.variantId, VARIANT));
    await tx.insert(s.shippingMethod).values({
      storeId: STORE,
      code: SHIPPING_CODE,
      name: 'Test Standard',
      calculator: { flat: 0 },
      enabled: true,
    });
  });
}

async function insertPromo(opts: { code: string; usageLimit?: number | null; usedCount?: number }): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO promotion (id, store_id, code, type, value, enabled, usage_limit, used_count)
      VALUES (gen_random_uuid(), ${STORE}, ${opts.code}, 'percentage', 10, true, ${opts.usageLimit ?? null}, ${opts.usedCount ?? 0})
    `);
  });
}

beforeEach(async () => {
  // Preserve real attempt-counting while isolating the fixtures' shared IP.
  for (const storeId of [STORE, OTHER_STORE]) {
    await rateLimitBackend().clear('checkout-ip', `unknown|${storeId}`);
    for (const identity of ['guest', CUSTOMER_A, CUSTOMER_B]) {
      await clearLoginAttempts('unknown', `checkout:${storeId}:${identity}`);
    }
  }
  await wipe();
  await seed();
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await wipe(); await pool.end(); });

const hdr = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-store-slug': SLUG, ...extra });

async function orderByCode(code: string) {
  return withStore(STORE, async (tx) => {
    const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
    return o ?? null;
  });
}

/** Real sessions ensure invalid, revoked & customer identities follow DB truth. */
async function customerSession(customerId: string): Promise<string> {
  return withStore(STORE, async (tx) => {
    await tx.insert(s.customer).values({ id: customerId, storeId: STORE, email: `${customerId}@example.test` }).onConflictDoNothing();
    return customerSessions.createSession(tx, STORE, customerId);
  });
}

function place(headers: Record<string, string> = {}, cartToken?: string) {
  return app.request('/v1/shop/checkout', {
    method: 'POST', headers: hdr(headers),
    body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }], ...(cartToken ? { cartToken } : {}) }),
  });
}

describe('POST /v1/shop/checkout — stable layered attempt budgets', () => {
  it.each(['bearer', 'cookie'] as const)('rotating invalid %s values cannot reset the guest budget', async (carrier) => {
    for (let i = 0; i < 8; i++) {
      const credential: Record<string, string> = carrier === 'bearer'
        ? { authorization: `Bearer invalid-${i}` }
        : { cookie: `sr_cust=invalid-${i}` };
      const res = await place(credential);
      expect(res.status).toBe(200);
      const body = await res.json() as { code: string };
      expect((await orderByCode(body.code))?.customerId).toBeNull();
    }
    const refusedCredentials: Record<string, string>[] = [
      { authorization: 'Bearer another-invalid-value' },
      { cookie: 'sr_cust=another-invalid-value' },
      {},
    ];
    for (const headers of refusedCredentials) {
      const refused = await place(headers);
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    }
  });

  it('a revoked previously-valid session shares the exhausted guest budget', async () => {
    const token = await customerSession(CUSTOMER_A);
    const signedIn = await place({ authorization: `Bearer ${token}` });
    expect(signedIn.status).toBe(200);
    const order = await signedIn.json() as { code: string };
    expect((await orderByCode(order.code))?.customerId).toBe(CUSTOMER_A);
    await withStore(STORE, tx => customerSessions.deleteSession(tx, token));
    for (let i = 0; i < 8; i++) expect((await place({}, 'missing-cart')).status).toBe(409);
    expect((await place({ authorization: `Bearer ${token}` })).status).toBe(429);
    expect((await place({ cookie: `sr_cust=${token}` })).status).toBe(429);
  });

  it('distinct validated customers share a NAT without sharing their fine budget; session rotation does not reset it', async () => {
    const first = await customerSession(CUSTOMER_A);
    const rotated = await customerSession(CUSTOMER_A);
    const other = await customerSession(CUSTOMER_B);
    for (let i = 0; i < 8; i++) {
      expect((await place({ authorization: `Bearer ${i % 2 ? first : rotated}` }, 'missing-cart')).status).toBe(409);
    }
    expect((await place({ authorization: `Bearer ${rotated}` })).status).toBe(429);
    const allowed = await place({ cookie: `sr_cust=${other}` });
    expect(allowed.status).toBe(200);
    const body = await allowed.json() as { code: string };
    expect((await orderByCode(body.code))?.customerId).toBe(CUSTOMER_B);
  });

  it('isolates guest budgets by the resolved store on the same IP', async () => {
    await withStore(OTHER_STORE, async tx => {
      await tx.insert(s.store).values({ id: OTHER_STORE, slug: OTHER_SLUG, name: OTHER_SLUG, currency: 'USD' });
    });
    for (let i = 0; i < 8; i++) expect((await place({}, 'missing-cart')).status).toBe(409);
    expect((await place()).status).toBe(429);
    expect((await place({ 'x-store-slug': OTHER_SLUG }, 'missing-cart')).status).toBe(409);
  });

  it('atomically caps tenant/IP work at 50 before session lookup, with a separate tenant ceiling', async () => {
    for (let i = 0; i < 50; i++) expect(await checkoutIpRetryAfter('unknown', STORE)).toBe(0);
    const resolve = vi.spyOn(customerSessions, 'resolveCustomer');
    expect((await place({ authorization: 'Bearer invalid-after-coarse-cap' })).status).toBe(429);
    expect(resolve).not.toHaveBeenCalled();
    await withStore(OTHER_STORE, async tx => {
      await tx.insert(s.store).values({ id: OTHER_STORE, slug: OTHER_SLUG, name: OTHER_SLUG, currency: 'USD' });
    });
    expect((await place({ 'x-store-slug': OTHER_SLUG, authorization: 'Bearer invalid-other-store' }, 'missing-cart')).status).toBe(409);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe('POST /v1/shop/checkout — server pricing', () => {
  it('ignores a client-supplied unit price and recomputes server-side', async () => {
    // The request schema doesn't even accept a client unit price — items are
    // {sku, quantity} only — so the strongest proof is that the resulting
    // grandTotal always equals PRICE * qty regardless of any extra fields sent.
    const res = await app.request('/v1/shop/checkout', {
      method: 'POST',
      headers: hdr(),
      body: JSON.stringify({ items: [{ sku: SKU, quantity: 2, unitPrice: 1 }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { code: string; grandTotal: number };
    expect(body.grandTotal).toBe(PRICE * 2); // NOT 1 * 2 — the attempted client price is ignored
    const order = await orderByCode(body.code);
    expect(order!.grandTotal).toBe(PRICE * 2);
  });
});

describe('POST /v1/shop/checkout — stock reservation', () => {
  it('oversell returns 409 with the blocked SKU and reserves nothing', async () => {
    await makePhysical(1);
    const res = await app.request('/v1/shop/checkout', {
      method: 'POST',
      headers: hdr(),
      body: JSON.stringify({ items: [{ sku: SKU, quantity: 5 }], shippingMethodCode: SHIPPING_CODE }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string; message: string }; skus?: string[] };
    expect(body.skus).toContain(SKU);

    // no order was created, and stock allocation is untouched (still 0 allocated)
    const allocated = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT allocated FROM stock WHERE variant_id = ${VARIANT}`);
      return Number((r.rows[0] as { allocated: number }).allocated);
    });
    expect(allocated).toBe(0);
  });

  it('a successful checkout reserves (allocates) the purchased quantity', async () => {
    await makePhysical(10);
    const res = await app.request('/v1/shop/checkout', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ items: [{ sku: SKU, quantity: 3 }], shippingMethodCode: SHIPPING_CODE }),
    });
    expect(res.status).toBe(200);
    const allocated = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT allocated FROM stock WHERE variant_id = ${VARIANT}`);
      return Number((r.rows[0] as { allocated: number }).allocated);
    });
    expect(allocated).toBe(3);
  });
});

describe('POST /v1/shop/checkout — idempotency', () => {
  it('a retry with the same Idempotency-Key returns the SAME order (no duplicate order)', async () => {
    const key = 'idem-key-checkout-1';
    const first = await app.request('/v1/shop/checkout', {
      method: 'POST', headers: hdr({ 'idempotency-key': key }), body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }] }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { code: string };

    const second = await app.request('/v1/shop/checkout', {
      method: 'POST', headers: hdr({ 'idempotency-key': key }), body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }] }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { code: string };

    expect(secondBody.code).toBe(firstBody.code);
    const changed = await app.request('/v1/shop/checkout', {
      method: 'POST', headers: hdr({ 'idempotency-key': key }), body: JSON.stringify({ items: [{ sku: SKU, quantity: 2 }] }),
    });
    expect(changed.status).toBe(409);

    const count = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT count(*)::int n FROM "order" WHERE idempotency_key = ${key}`);
      return (r.rows[0] as { n: number }).n;
    });
    expect(count).toBe(1);
  });
});

describe('POST /v1/shop/checkout — coupon', () => {
  it('applies a valid coupon and discounts the total', async () => {
    await insertPromo({ code: 'TENOFF' });
    const res = await app.request('/v1/shop/checkout', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }], couponCode: 'TENOFF' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { grandTotal: number; discountTotal: number; couponApplied: boolean };
    expect(body.couponApplied).toBe(true);
    expect(body.discountTotal).toBeGreaterThan(0);
    expect(body.grandTotal).toBeLessThan(PRICE);
  });

  it('enforces the promotion usage limit — a fully-used coupon is not applied', async () => {
    await insertPromo({ code: 'MAXEDOUT', usageLimit: 1, usedCount: 1 });
    const res = await app.request('/v1/shop/checkout', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }], couponCode: 'MAXEDOUT' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { grandTotal: number; couponApplied: boolean };
    // Server proceeds at full price rather than failing the whole checkout.
    expect(body.couponApplied).toBe(false);
    expect(body.grandTotal).toBe(PRICE);
  });
});

describe('POST /v1/shop/checkout — empty/invalid cart', () => {
  it('an unknown cartToken returns 409', async () => {
    const res = await app.request('/v1/shop/checkout', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }], cartToken: 'does-not-exist' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.message).toMatch(/cart is empty|invalid|already checked out/i);
  });

  it('an already-converted cart returns 409', async () => {
    const token = 'ckr-cart-converted-1';
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO cart (id, store_id, token, status) VALUES (gen_random_uuid(), ${STORE}, ${token}, 'converted')`);
    });
    const res = await app.request('/v1/shop/checkout', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }], cartToken: token }),
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /v1/shop/checkout — landing attribution', () => {
  const post = (extra: Record<string, unknown>, headers: Record<string, string> = {}) => app.request('/v1/shop/checkout', {
    method: 'POST', headers: hdr(headers), body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }], ...extra }),
  });

  it('stores allowlisted UTM + oppref values on order.metadata.attribution (trimmed, empties dropped)', async () => {
    const res = await post({ attribution: { utm_source: ' chatgpt ', utm_medium: 'cpc', utm_campaign: 'rh_us_shirts_202610', utm_content: 'test', utm_term: '', oppref: 'abc123' } });
    expect(res.status).toBe(200);
    const { code } = await res.json() as { code: string };
    const order = await orderByCode(code);
    expect((order?.metadata as { attribution?: unknown }).attribution).toEqual({ utm_source: 'chatgpt', utm_medium: 'cpc', utm_campaign: 'rh_us_shirts_202610', utm_content: 'test', oppref: 'abc123' });
  });

  it('an order without attribution stores none', async () => {
    const res = await post({});
    const { code } = await res.json() as { code: string };
    expect((await orderByCode(code))?.metadata).not.toHaveProperty('attribution');
  });

  it.each([
    ['an unknown key', { utm_source: 'x', gclid: 'y' }],
    ['an over-long value', { utm_campaign: 'c'.repeat(257) }],
    ['a control character', { oppref: 'a\nb' }],
    ['a non-string value', { utm_source: 5 }],
  ])('refuses %s with 400 and creates no order', async (_label, attribution) => {
    const res = await post({ attribution });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('INVALID_CHECKOUT_REQUEST');
    const n = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT count(*)::int n FROM "order"`)).rows[0] as { n: number });
    expect(n.n).toBe(0);
  });

  it('is not part of the idempotency fingerprint: a retry with a different claim replays the same order unchanged', async () => {
    const key = 'idem-key-attribution-1';
    const first = await post({ attribution: { utm_source: 'chatgpt' } }, { 'idempotency-key': key });
    const second = await post({ attribution: { utm_source: 'other' } }, { 'idempotency-key': key });
    expect(second.status).toBe(200);
    const a = await first.json() as { code: string };
    const b = await second.json() as { code: string };
    expect(b.code).toBe(a.code);
    expect(((await orderByCode(a.code))?.metadata as { attribution?: unknown }).attribution).toEqual({ utm_source: 'chatgpt' });
  });
});

describe('POST /v1/shop/checkout — malformed request uses the structured error envelope', () => {
  // Before this fix, a validation failure fell through to
  // `@hono/zod-openapi`'s default `{ success: false, error: <ZodError> }`
  // response instead of this API's `{ error: { code, message } }` envelope
  // (see the per-route hook added to checkout.ts, mirroring gateway-payments.ts).
  it('an empty items array (body schema violation) returns 400 INVALID_CHECKOUT_REQUEST in the envelope shape', async () => {
    const res = await app.request('/v1/shop/checkout', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ items: [] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_CHECKOUT_REQUEST');
    expect(typeof body.error.message).toBe('string');
    expect(body).not.toHaveProperty('success');
  });

  it('a negative-quantity line (body schema violation) also returns the structured envelope, not a bare ZodError', async () => {
    const res = await app.request('/v1/shop/checkout', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ items: [{ sku: SKU, quantity: -1 }] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_CHECKOUT_REQUEST');
    expect(body).not.toHaveProperty('success');
  });
});

// MONEY-5: cart.ts priced tax with the store's flat rate only; checkout.ts
// additionally resolves a destination tax_zone (money/tax.ts::resolveTaxRate).
// Cart never consulted tax zones, so the price shown pre-checkout disagreed
// with what checkout actually charged whenever a tax zone existed. Fixed by
// threading an optional shipCountry into cart.ts::priceCart.
describe('MONEY-5: cart estimate tax matches checkout tax for the same destination', () => {
  const ZONE_RATE = 1300; // 13% — deliberately different from the store's flat rate (0, per seed())

  async function seedZone(): Promise<void> {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO tax_zone (id, store_id, name, countries, rate, priority, enabled) VALUES (gen_random_uuid(), ${STORE}, 'Canada', ARRAY['CA'], ${ZONE_RATE}, 0, true)`);
    });
  }

  it('without a shipCountry, cart falls back to the store flat rate (documented, unchanged behaviour)', async () => {
    await seedZone();
    const res = await app.request('/v1/shop/cart/estimate', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taxTotal: number };
    expect(body.taxTotal).toBe(0); // seed() sets tax_rate=0
  });

  it('with a shipCountry matching a zone, cart resolves the zone rate — and agrees EXACTLY with checkout for the same destination', async () => {
    await seedZone();
    const estRes = await app.request('/v1/shop/cart/estimate', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }], shipCountry: 'CA' }),
    });
    expect(estRes.status).toBe(200);
    const est = await estRes.json() as { taxTotal: number; grandTotal: number };
    // The bug this guards against: before the fix this would be 0 (the flat
    // rate), identical to the no-shipCountry case above, regardless of country.
    expect(est.taxTotal).toBe(Math.round((PRICE * ZONE_RATE) / 10000));

    const checkoutRes = await app.request('/v1/shop/checkout', {
      method: 'POST',
      headers: hdr(),
      body: JSON.stringify({
        items: [{ sku: SKU, quantity: 1 }],
        shippingAddress: { line1: '1 Test St', city: 'Toronto', country: 'CA', postalCode: 'M5H2N2' },
        email: 'tax-parity@example.com',
      }),
    });
    expect(checkoutRes.status).toBe(200);
    const order = await checkoutRes.json() as { grandTotal: number };
    // The actual parity assertion: what the shopper saw in the cart estimate
    // is EXACTLY what checkout charged for the identical destination.
    expect(order.grandTotal).toBe(est.grandTotal);
  });

  it('a shipCountry with no matching zone falls back to the flat rate, same as checkout', async () => {
    await seedZone();
    const res = await app.request('/v1/shop/cart/estimate', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }], shipCountry: 'FR' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taxTotal: number };
    expect(body.taxTotal).toBe(0);
  });
});
