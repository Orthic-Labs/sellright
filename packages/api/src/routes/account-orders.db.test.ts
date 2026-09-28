/**
 * DB tests for GET /v1/shop/account/orders (+ /orders/{code}) — R20 parity.
 * The list must be paginated with a real total (not the returned array
 * length passed off as the total), and the detail must carry the full order
 * contract (currency/totals/addresses/payments/fulfillments/preorder), not
 * substitute zeros/nulls for fields nobody had asked the API for yet.
 * Mirrors account-licenses.db.test.ts's fixture pattern.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createSession } from '../auth/session.js';
import { account } from './account.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`account-orders test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

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
    expect(body.payments).toMatchObject([{ method: 'nmi', state: 'Settled' }]);
  });
});
