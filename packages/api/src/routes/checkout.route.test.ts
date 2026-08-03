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
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { checkout } from './checkout.js';
import { cart } from './cart.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`checkout.route test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'aaaaaaaa-1111-1111-1111-111111111111';
const SLUG = 'checkout-route-test-store';
const PRODUCT = 'aaaaaaaa-1111-1111-1111-1111111111a1';
const VARIANT = 'aaaaaaaa-1111-1111-1111-1111111111b1';
const SKU = 'CKR-SKU-1';
const PRICE = 5000; // cents — the true server price; a tampered client price must be ignored

const app = new OpenAPIHono();
app.route('/', checkout);
app.route('/', cart);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

/** Seed store + one variant with stock. Fresh promo/variant ids per test via suffix
 *  keeps assertions independent even though wipe() runs beforeEach. */
async function seed(opts: { onHand?: number } = {}): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, tax_rate) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', 0) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PRODUCT}, ${STORE}, 'ckr-prod', 'CKR Product', 'active') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT}, ${STORE}, ${PRODUCT}, ${SKU}, 'CKR Variant', ${PRICE}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, ${opts.onHand ?? 10}, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = ${opts.onHand ?? 10}, allocated = 0`);
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

beforeEach(async () => { await wipe(); await seed(); });
afterAll(async () => { await wipe(); await pool.end(); });

const hdr = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-store-slug': SLUG, ...extra });

async function orderByCode(code: string) {
  return withStore(STORE, async (tx) => {
    const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
    return o ?? null;
  });
}

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
    await seed({ onHand: 1 });
    const res = await app.request('/v1/shop/checkout', {
      method: 'POST',
      headers: hdr(),
      body: JSON.stringify({ items: [{ sku: SKU, quantity: 5 }] }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; skus?: string[] };
    expect(body.skus).toContain(SKU);

    // no order was created, and stock allocation is untouched (still 0 allocated)
    const allocated = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT allocated FROM stock WHERE variant_id = ${VARIANT}`);
      return Number((r.rows[0] as { allocated: number }).allocated);
    });
    expect(allocated).toBe(0);
  });

  it('a successful checkout reserves (allocates) the purchased quantity', async () => {
    const res = await app.request('/v1/shop/checkout', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ items: [{ sku: SKU, quantity: 3 }] }),
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
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/cart is empty|invalid|already checked out/i);
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
