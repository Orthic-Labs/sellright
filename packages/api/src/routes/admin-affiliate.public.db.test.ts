/**
 * SellRight storefront-port follow-up: GET /v1/shop/affiliate (the public,
 * token-gated self-serve dashboard) used to return only totals — the
 * storefront's affiliate page (packages/storefront src/routes/affiliate)
 * expects the richer AffiliateStatsResult shape the old Vendure
 * affiliateStatsByToken GraphQL query returned (orders list, settles list,
 * totals.*Usd). This proves the REST route now matches that contract.
 *
 * DB test (vs sellright_test ONLY — TRUNCATEs). Same conventions as
 * catalog-collection-sql.db.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { invalidateStoreCache } from '../store-context.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`admin-affiliate public db test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE_ID = '11111111-2222-3333-4444-555555550003';
const SLUG = 'affiliate-public-store';
const PROMOTION_ID = '66666666-6666-6666-6666-666666660001';
const AFFILIATE_ID = '77777777-7777-7777-7777-777777770001';
const ACCESS_TOKEN = 'aabbccddeeff00112233445566778899';
const ORDER_ID = '88888888-8888-8888-8888-888888880001';
const ORDER_LINE_ID = '99999999-9999-9999-9999-999999990001';
const VARIANT_ID = '44444444-4444-4444-4444-444444440009';
const PRODUCT_ID = '33333333-3333-3333-3333-333333330009';
const SETTLE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seed() {
  await withStore(STORE_ID, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE_ID}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING`);

    await tx.execute(sql`INSERT INTO promotion (id, store_id, code, type, value, enabled)
      VALUES (${PROMOTION_ID}, ${STORE_ID}, 'PARITYAFF10', 'percentage', 10, true)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO affiliate (id, store_id, promotion_id, email, access_token, onboarded_at)
      VALUES (${AFFILIATE_ID}, ${STORE_ID}, ${PROMOTION_ID}, 'affiliate@example.com', ${ACCESS_TOKEN}, now())
      ON CONFLICT (id) DO NOTHING`);

    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status)
      VALUES (${PRODUCT_ID}, ${STORE_ID}, 'aff-product', 'Aff Product', 'active')
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price)
      VALUES (${VARIANT_ID}, ${STORE_ID}, ${PRODUCT_ID}, 'AFF-SKU', 'Aff Product', 5000)
      ON CONFLICT (id) DO NOTHING`);

    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, subtotal, promotion_id, placed_at)
      VALUES (${ORDER_ID}, ${STORE_ID}, 'ORDPARITY12345', 'Paid', 10000, ${PROMOTION_ID}, now())
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total)
      VALUES (${ORDER_LINE_ID}, ${STORE_ID}, ${ORDER_ID}, ${VARIANT_ID}, 'AFF-SKU', 'Aff Product', 2, 5000, 10000, 10000)
      ON CONFLICT (id) DO NOTHING`);

    // A discounted order (commission on the discounted subtotal) and a fully
    // refunded one (earns nothing, not listed).
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, subtotal, discount_total, promotion_id, placed_at)
      VALUES ('88888888-8888-8888-8888-888888880002', ${STORE_ID}, 'ORDDISC00002', 'Paid', 4000, 600, ${PROMOTION_ID}, now())
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, subtotal, promotion_id, placed_at)
      VALUES ('88888888-8888-8888-8888-888888880003', ${STORE_ID}, 'ORDREFD00003', 'Refunded', 9000, ${PROMOTION_ID}, now() - interval '1 day')
      ON CONFLICT (id) DO NOTHING`);

    await tx.execute(sql`INSERT INTO affiliate_settle (id, store_id, promotion_id, amount_cents, period_end_at, settled_at, tx_ref)
      VALUES (${SETTLE_ID}, ${STORE_ID}, ${PROMOTION_ID}, 500, now(), now(), 'REF-1')
      ON CONFLICT (id) DO NOTHING`);
  });
}

beforeEach(async () => {
  invalidateStoreCache();
  await wipe();
  await seed();
});

afterAll(async () => {
  await pool.end();
});

describe('GET /v1/shop/affiliate — public self-serve dashboard contract', () => {
  it('returns totals, orders (redacted code + itemCount), and settles matching the storefront contract', async () => {
    const app = createApp();
    const res = await app.request(`/v1/shop/affiliate?t=${ACCESS_TOKEN}`, { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.success).toBe(true);
    expect(body.email).toBe('affiliate@example.com');
    expect(body.couponCode).toBe('PARITYAFF10');
    expect(body.rate).toBeCloseTo(0.1);

    // (10000c + (4000c - 600c discount)) * 10% = 1340c earned; the refunded
    // order earns nothing. Settled 500c → owed 840c.
    expect(body.totals.earnedUsd).toBeCloseTo(13.4);
    expect(body.totals.paidUsd).toBeCloseTo(5);
    expect(body.totals.owedUsd).toBeCloseTo(8.4);
    expect(body.totals.orderCount).toBe(2);

    expect(body.orders).toHaveLength(2);
    const full = body.orders.find((o: any) => o.redactedCode === '2345'); // last 4 chars of ORDPARITY12345
    expect(full.code).toBeUndefined(); // never leak the full code
    expect(full.itemCount).toBe(2);
    expect(full.subtotalUsd).toBeCloseTo(100);
    expect(full.commissionUsd).toBeCloseTo(10);
    expect(full.state).toBe('Paid');
    const discounted = body.orders.find((o: any) => o.redactedCode === '0002');
    expect(discounted.subtotalUsd).toBeCloseTo(34);
    expect(discounted.commissionUsd).toBeCloseTo(3.4);
    expect(body.orders.some((o: any) => o.redactedCode === '0003')).toBe(false);

    expect(Array.isArray(body.topProducts)).toBe(true);

    expect(body.settles).toHaveLength(1);
    expect(body.settles[0].amountUsd).toBeCloseTo(5);
    expect(body.settles[0].txRef).toBe('REF-1');
  });

  it('404s for an unknown token', async () => {
    const app = createApp();
    const res = await app.request('/v1/shop/affiliate?t=0000000000000000invalidtoken', { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(404);
  });
});
