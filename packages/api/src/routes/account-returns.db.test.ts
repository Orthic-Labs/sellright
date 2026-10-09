/**
 * DB tests for the customer-side return request routes (GET/POST /v1/shop/account/orders/{code}/returns).
 * The merchant side (admin approve -> refund) is covered by admin-orders.refund*.test.ts; here: who may ask,
 * for what, how many units, and what the shopper reads back.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createSession } from '../auth/session.js';
import { accountReturns } from './account-returns.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`account-returns test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeee3333';
const SLUG = 'account-returns-test-store';
const ME = 'eeeeeeee-eeee-eeee-eeee-0000000000f1';
const OTHER = 'eeeeeeee-eeee-eeee-eeee-0000000000f2';
const ORDER = '22222222-2222-2222-2222-222222222201';
const ORDER_OTHER = '22222222-2222-2222-2222-222222222202';
const ORDER_UNPAID = '22222222-2222-2222-2222-222222222203';
const L_SHIPPED = '33333333-3333-3333-3333-333333333301'; // 3 bought, 2 shipped
const L_UNSHIPPED = '33333333-3333-3333-3333-333333333302'; // 1 bought, 0 shipped
const L_OTHER = '33333333-3333-3333-3333-333333333303';
const L_UNPAID = '33333333-3333-3333-3333-333333333304';

const app = new OpenAPIHono();
app.route('/', accountReturns);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

async function seed(): Promise<{ token: string; otherToken: string }> {
  return withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    for (const [id, email] of [[ME, 'me@returns.test'], [OTHER, 'other@returns.test']] as const) {
      await tx.execute(sql`INSERT INTO customer (id, store_id, email, email_verified) VALUES (${id}, ${STORE}, ${email}, true)`);
    }
    const token = await createSession(tx, STORE, ME);
    const otherToken = await createSession(tx, STORE, OTHER);
    const order = (id: string, code: string, customer: string, state: string) =>
      tx.execute(sql`INSERT INTO "order" (id, store_id, code, customer_id, state, currency, subtotal, shipping_total, tax_total, discount_total, grand_total, placed_at)
        VALUES (${id}, ${STORE}, ${code}, ${customer}, ${state}::order_state, 'USD', 5000, 0, 0, 0, 5000, now())`);
    await order(ORDER, 'RET-MINE', ME, 'Paid');
    await order(ORDER_OTHER, 'RET-THEIRS', OTHER, 'Paid');
    await order(ORDER_UNPAID, 'RET-UNPAID', ME, 'PendingPayment');
    const line = (id: string, orderId: string, sku: string, name: string, qty: number, fulfilled: number) =>
      tx.execute(sql`INSERT INTO order_line (id, store_id, order_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
        VALUES (${id}, ${STORE}, ${orderId}, ${sku}, ${name}, ${qty}, 1000, ${qty * 1000}, ${qty * 1000}, ${fulfilled})`);
    await line(L_SHIPPED, ORDER, 'SKU-A', 'Alpha', 3, 2);
    await line(L_UNSHIPPED, ORDER, 'SKU-B', 'Beta', 1, 0);
    await line(L_OTHER, ORDER_OTHER, 'SKU-A', 'Alpha', 1, 1);
    await line(L_UNPAID, ORDER_UNPAID, 'SKU-A', 'Alpha', 1, 1);
    return { token, otherToken };
  });
}

let token = '';
let otherToken = '';
beforeEach(async () => {
  await wipe();
  ({ token, otherToken } = await seed());
});
afterAll(async () => { await wipe(); });

const hdr = (t = token) => ({ 'content-type': 'application/json', 'x-store-slug': SLUG, authorization: `Bearer ${t}` });
const get = (code: string, t = token) => app.request(`/v1/shop/account/orders/${code}/returns`, { headers: hdr(t) });
const post = (code: string, body: unknown, t = token) => app.request(`/v1/shop/account/orders/${code}/returns`, { method: 'POST', headers: hdr(t), body: JSON.stringify(body) });

describe('GET /v1/shop/account/orders/{code}/returns', () => {
  it('offers only shipped units, per SKU', async () => {
    const res = await get('RET-MINE');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ returnable: [{ sku: 'SKU-A', name: 'Alpha', quantity: 2 }], items: [] });
  });

  it('is 401 without a session and 404 for an order that is not yours (no existence leak)', async () => {
    expect((await app.request('/v1/shop/account/orders/RET-MINE/returns', { headers: { 'x-store-slug': SLUG } })).status).toBe(401);
    expect((await get('RET-THEIRS')).status).toBe(404);
    expect((await get('NOPE')).status).toBe(404);
  });

  it('offers nothing on an order that is not paid', async () => {
    const body = await (await get('RET-UNPAID')).json() as { returnable: unknown[] };
    expect(body.returnable).toEqual([]);
  });
});

describe('POST /v1/shop/account/orders/{code}/returns', () => {
  it('records a requested return, reads it back with its status, and stops offering those units', async () => {
    const res = await post('RET-MINE', { lines: [{ sku: 'SKU-A', quantity: 1 }], reason: 'arrived with a cracked handle' });
    expect(res.status).toBe(201);
    const { id, status } = await res.json() as { id: string; status: string };
    expect(status).toBe('requested');

    const after = await (await get('RET-MINE')).json() as { returnable: Array<{ quantity: number }>; items: Array<{ id: string; status: string; reason: string; lines: unknown[] }> };
    expect(after.returnable).toEqual([{ sku: 'SKU-A', name: 'Alpha', quantity: 1 }]);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({ id, status: 'requested', reason: 'arrived with a cracked handle', lines: [{ sku: 'SKU-A', name: 'Alpha', quantity: 1 }] });

    // The merchant's queue sees it, never pre-restocked (the shopper does not decide that).
    const rows = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT restock, quantity FROM return_line`) as unknown as { rows: unknown[] }).rows);
    expect(rows).toEqual([{ restock: false, quantity: 1 }]);
  });

  it('refuses more units than shipped-and-not-yet-requested, including across two requests', async () => {
    expect((await post('RET-MINE', { lines: [{ sku: 'SKU-A', quantity: 3 }], reason: 'too many' })).status).toBe(409);
    expect((await post('RET-MINE', { lines: [{ sku: 'SKU-A', quantity: 2 }], reason: 'both' })).status).toBe(201);
    expect((await post('RET-MINE', { lines: [{ sku: 'SKU-A', quantity: 1 }], reason: 'a third' })).status).toBe(409);
  });

  it('refuses unshipped lines, unknown SKUs, unpaid orders and other customers\' orders', async () => {
    expect((await post('RET-MINE', { lines: [{ sku: 'SKU-B', quantity: 1 }], reason: 'not shipped yet' })).status).toBe(409);
    expect((await post('RET-MINE', { lines: [{ sku: 'SKU-Z', quantity: 1 }], reason: 'no such line' })).status).toBe(409);
    expect((await post('RET-UNPAID', { lines: [{ sku: 'SKU-A', quantity: 1 }], reason: 'unpaid' })).status).toBe(409);
    expect((await post('RET-THEIRS', { lines: [{ sku: 'SKU-A', quantity: 1 }], reason: 'not mine' })).status).toBe(404);
    expect((await post('RET-MINE', { lines: [{ sku: 'SKU-A', quantity: 1 }], reason: 'not mine either' }, otherToken)).status).toBe(404);
    const n = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT 1 FROM return_request`) as unknown as { rows: unknown[] }).rows.length);
    expect(n).toBe(0);
  });

  it('a rejected request frees its units again; a refunded one does not', async () => {
    const { id } = await (await post('RET-MINE', { lines: [{ sku: 'SKU-A', quantity: 2 }], reason: 'return both' })).json() as { id: string };
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE return_request SET status = 'rejected' WHERE id = ${id}`));
    expect((await (await get('RET-MINE')).json() as { returnable: Array<{ quantity: number }> }).returnable[0]!.quantity).toBe(2);
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`UPDATE return_request SET status = 'refunded' WHERE id = ${id}`);
      await tx.execute(sql`UPDATE order_line SET refunded_qty = 2 WHERE id = ${L_SHIPPED}`);
    });
    expect((await (await get('RET-MINE')).json() as { returnable: unknown[] }).returnable).toEqual([]);
  });

  it('validates the body (reason and at least one line are required)', async () => {
    expect((await post('RET-MINE', { lines: [], reason: 'nothing' })).status).toBe(400);
    expect((await post('RET-MINE', { lines: [{ sku: 'SKU-A', quantity: 1 }] })).status).toBe(400);
  });
});
