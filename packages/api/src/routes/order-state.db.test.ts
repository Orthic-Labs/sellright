// V29: compact order-state read for confirmation polling. Same receipt-token / owner scope as the full order read,
// same not-found for an unscoped read, no PII, and the full read stays available unchanged.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { orders } from './orders.js';

assertTestDatabase(env.DATABASE_URL, 'order state read');

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeee0291';
const SLUG = 'order-state-read';
const app = new OpenAPIHono();
app.route('/', orders);

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, 'test')`);
    await tx.execute(sql`INSERT INTO "order" (store_id, code, state, receipt_token, grand_total, shipping_address, metadata)
      VALUES (${STORE}, 'S-PAID', 'Paid', 'rt-paid', 7500, '{"line1":"secret street"}'::jsonb, '{"contact":{"email":"pii@example.test"}}'::jsonb),
             (${STORE}, 'S-PEND', 'PendingPayment', 'rt-pend', 1200, null, null)`);
    await tx.execute(sql`INSERT INTO payment (store_id, order_id, amount, method, state)
      SELECT ${STORE}, id, 7500, 'stripe', 'Settled' FROM "order" WHERE code = 'S-PAID'`);
  });
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); await pool.end(); });

const get = (path: string) => app.request(path, { headers: { 'x-store-slug': SLUG } });

describe('GET /v1/shop/orders/{code}/state', () => {
  it('returns only the state facts the confirmation poll needs', async () => {
    const res = await get('/v1/shop/orders/S-PAID/state?rt=rt-paid');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ code: 'S-PAID', state: 'Paid', status: expect.any(String), paymentStatus: 'paid', fulfillmentStatus: expect.any(String), grandTotal: 7500 });
    expect(JSON.stringify(body)).not.toMatch(/secret street|pii@example/);
  });

  it('agrees with the full read', async () => {
    const full = await (await get('/v1/shop/orders/S-PEND?rt=rt-pend')).json() as Record<string, unknown>;
    const compact = await (await get('/v1/shop/orders/S-PEND/state?rt=rt-pend')).json() as Record<string, unknown>;
    for (const key of ['code', 'state', 'status', 'paymentStatus', 'fulfillmentStatus', 'grandTotal']) expect(compact[key]).toEqual(full[key]);
  });

  it('is not-found without a matching receipt token or ownership', async () => {
    expect((await get('/v1/shop/orders/S-PAID/state')).status).toBe(404);
    expect((await get('/v1/shop/orders/S-PAID/state?rt=rt-pend')).status).toBe(404);
    expect((await get('/v1/shop/orders/NOPE/state?rt=rt-paid')).status).toBe(404);
  });
});
