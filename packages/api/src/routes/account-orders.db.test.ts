/**
 * DB tests for GET /v1/shop/account/orders (+ /orders/{code}) — R20 parity.
 * The list must be paginated with a real total (not the returned array
 * length passed off as the total), and the detail must carry the full order
 * contract (currency/totals/addresses/payments/fulfillments/preorder), not
 * substitute zeros/nulls for fields nobody had asked the API for yet.
 * Mirrors account-licenses.db.test.ts's fixture pattern.
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createSession } from '../auth/session.js';
import { account } from './account.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'account-orders.db.test.ts');

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeee2222';
const SLUG = 'account-orders-test-store';
const CUSTOMER = 'eeeeeeee-eeee-eeee-eeee-0000000000e1';
const PROMO = 'eeeeeeee-eeee-eeee-eeee-0000000000e9';

const app = new OpenAPIHono();
app.route('/', account);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

async function seed(): Promise<{ token: string }> {
  return withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, email_verified) VALUES (${CUSTOMER}, ${STORE}, 'buyer@acct-orders.test', true) ON CONFLICT (id) DO NOTHING`);
    const token = await createSession(tx, STORE, CUSTOMER);
    await tx.execute(sql`INSERT INTO promotion (id, store_id, code, type, value, priority, enabled) VALUES (${PROMO}, ${STORE}, 'SAVE10', 'percentage', 10, 0, true)`);
    // 3 orders so pagination (limit=2) has something to page through.
    for (let i = 1; i <= 3; i++) {
      await tx.execute(sql`INSERT INTO "order" (id, store_id, code, customer_id, state, currency, subtotal, shipping_total, tax_total, discount_total, grand_total, shipping_address, billing_address, promotion_id, placed_at)
        VALUES (${`11111111-1111-1111-1111-11111111110${i}`}, ${STORE}, ${`ORD-PAGE-${i}`}, ${CUSTOMER}, 'Paid', 'USD', 5000, 500, 400, 500, 5400,
          '{"line1":"1 Main St","city":"Metropolis"}'::jsonb, '{"line1":"1 Main St","city":"Metropolis"}'::jsonb, ${PROMO}, now() - (${i} || ' hour')::interval)`);
    }
    return { token };
  });
}

let token = '';
beforeEach(async () => {
  await wipe();
  ({ token } = await seed());
});
afterAll(async () => { await wipe(); });

const hdr = () => ({ 'content-type': 'application/json', 'x-store-slug': SLUG, authorization: `Bearer ${token}` });

describe('GET /v1/shop/account/orders — pagination (R20)', () => {
  it('reports a real total independent of the page size', async () => {
    const res = await app.request('/v1/shop/account/orders?limit=2&offset=0', { headers: hdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; total: number; limit: number; offset: number };
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(3); // NOT items.length — the whole point of the fix
    expect(body).toMatchObject({ limit: 2, offset: 0 });
  });

  it('offset advances to the remaining page', async () => {
    const res = await app.request('/v1/shop/account/orders?limit=2&offset=2', { headers: hdr() });
    const body = await res.json() as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(3);
  });

  it('includes currency on each summary row', async () => {
    const res = await app.request('/v1/shop/account/orders', { headers: hdr() });
    const body = await res.json() as { items: Array<{ currency: string }> };
    expect(body.items[0]!.currency).toBe('USD');
  });
});

describe('GET /v1/shop/account/orders/{code} — full contract (R20)', () => {
  it('exposes currency, full totals, addresses, and the promotion code — not zeros/nulls', async () => {
    const res = await app.request('/v1/shop/account/orders/ORD-PAGE-1', { headers: hdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      currency: string; subtotal: number; shippingTotal: number; taxTotal: number; discountTotal: number; grandTotal: number;
      shippingAddress: { city: string } | null; billingAddress: { city: string } | null; promotionCode: string | null;
      payments: unknown[]; fulfillments: unknown[];
    };
    expect(body).toMatchObject({
      currency: 'USD', subtotal: 5000, shippingTotal: 500, taxTotal: 400, discountTotal: 500, grandTotal: 5400,
      promotionCode: 'SAVE10',
    });
    expect(body.shippingAddress).toMatchObject({ city: 'Metropolis' });
    expect(body.billingAddress).toMatchObject({ city: 'Metropolis' });
    expect(body.payments).toEqual([]);
    expect(body.fulfillments).toEqual([]);
  });

  it('includes real payment facts when a payment row exists', async () => {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO payment (store_id, order_id, amount, method, state) VALUES (${STORE}, '11111111-1111-1111-1111-111111111101', 5400, 'nmi', 'Settled')`);
    });
    const res = await app.request('/v1/shop/account/orders/ORD-PAGE-1', { headers: hdr() });
    const body = await res.json() as { payments: Array<{ method: string; state: string }> };
    // Wire-facing rename (orders/status.ts#wirePaymentState): the internal
    // 'Settled' payment_state reads as 'captured' on the wire — BREAKING,
    // pre-1.0, see CHANGELOG.md.
    expect(body.payments).toMatchObject([{ method: 'nmi', state: 'captured' }]);
  });
});

describe('GET /v1/shop/account/orders — history facts (#393)', () => {
  const ORDER = '11111111-1111-1111-1111-111111111101';
  type Row = {
    code: string; subtotal: number; shippingTotal: number; discountTotal: number; trackingCode: string | null; carrier: string | null;
    isPreOrder: boolean; shipDate: string | null; items: Array<{ sku: string; quantity: number; lineTotal: number; image: string | null; isPreOrder: boolean }>;
  };
  const row = async (code: string) => {
    const res = await app.request('/v1/shop/account/orders', { headers: hdr() });
    return ((await res.json()) as { items: Row[] }).items.find((o) => o.code === code)!;
  };

  it('carries the totals breakdown and line data, with empty tracking/pre-order state for a plain order', async () => {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total)
        VALUES (${STORE}, ${ORDER}, 'SKU-A', 'Thing A', 2, 2500, 5000, 5000)`);
    });
    expect(await row('ORD-PAGE-1')).toMatchObject({
      subtotal: 5000, shippingTotal: 500, discountTotal: 500, trackingCode: null, carrier: null, isPreOrder: false, shipDate: null,
      items: [{ sku: 'SKU-A', quantity: 2, lineTotal: 5000, image: null, isPreOrder: false }],
    });
  });

  it('reports the newest tracked fulfilment and the latest pre-order ship date', async () => {
    await withStore(STORE, async (tx) => {
      const product = (await tx.execute(sql`INSERT INTO product (store_id, slug, name) VALUES (${STORE}, 'hist-pre', 'Hist pre') RETURNING id`)).rows as Array<{ id: string }>;
      const variant = (await tx.execute(sql`INSERT INTO product_variant (store_id, product_id, sku, name, price, is_pre_order, ship_date)
        VALUES (${STORE}, ${product[0]!.id}, 'PRE-1', 'Pre one', 1000, true, '2027-03-01T00:00:00Z') RETURNING id`)).rows as Array<{ id: string }>;
      await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total)
        VALUES (${STORE}, ${ORDER}, ${variant[0]!.id}, 'PRE-1', 'Pre one', 1, 1000, 1000, 1000)`);
      await tx.execute(sql`INSERT INTO fulfillment (store_id, order_id, state, tracking_code, carrier) VALUES (${STORE}, ${ORDER}, 'Shipped', '1Z999AA10123456784', 'UPS')`);
    });
    expect(await row('ORD-PAGE-1')).toMatchObject({ trackingCode: '1Z999AA10123456784', carrier: 'UPS', isPreOrder: true, shipDate: '2027-03-01T00:00:00.000Z' });
  });
});

describe('order detail payments — card facts only (#393)', () => {
  it('exposes brand + last4 from payment metadata and nothing else from it', async () => {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO payment (store_id, order_id, amount, method, state, metadata)
        VALUES (${STORE}, '11111111-1111-1111-1111-111111111101', 5400, 'nmi', 'Settled',
          ${JSON.stringify({ card: { brand: 'Visa', last4: '4242' }, avs: 'Y', cvv: 'M', authCode: 'SECRET1' })}::jsonb)`);
    });
    const res = await app.request('/v1/shop/account/orders/ORD-PAGE-1', { headers: hdr() });
    const text = await res.text();
    expect(JSON.parse(text).payments).toMatchObject([{ method: 'nmi', cardBrand: 'Visa', cardLast4: '4242' }]);
    expect(text).not.toContain('SECRET1');
    expect(text).not.toContain('"avs"');
  });
});
