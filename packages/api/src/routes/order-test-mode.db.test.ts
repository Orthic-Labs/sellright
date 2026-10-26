// #373: the shop order read says whether the order was paid only in test mode, so the storefront never reports a
// test purchase as an ad conversion. Runs against a dedicated *_test DB ONLY (wipes data).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { orders } from './orders.js';

assertTestDatabase(env.DATABASE_URL, 'order testMode read');

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeee3733';
const SLUG = 'order-test-mode';
const app = new OpenAPIHono();
app.route('/', orders);

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

async function order(code: string, attempts: Array<{ mode: string; status: string }>) {
  await withStore(STORE, async (tx) => {
    const r = await tx.execute<{ id: string }>(sql`INSERT INTO "order" (store_id, code, state, receipt_token, grand_total)
      VALUES (${STORE}, ${code}, 'Paid', ${'rt-' + code}, 7500) RETURNING id`);
    const id = r.rows[0]!.id;
    for (const [i, a] of attempts.entries()) {
      await tx.execute(sql`INSERT INTO payment_attempt (store_id, order_id, operation, method, account_id, mode, amount, currency, idempotency_key, fingerprint, status)
        VALUES (${STORE}, ${id}, 'intent', 'stripe', 'acct', ${a.mode}, 7500, 'USD', ${code + i}, 'fp', ${a.status})`);
    }
  });
}

const read = async (code: string) => {
  const res = await app.request(`/v1/shop/orders/${code}?rt=rt-${code}`, { headers: { 'x-store-slug': SLUG } });
  expect(res.status).toBe(200);
  return (await res.json() as { testMode: boolean }).testMode;
};

beforeEach(async () => {
  await wipe();
  await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, 'test')`));
});
afterAll(async () => {
  await wipe();
  await pool.end();
});

describe('#373 order read: testMode', () => {
  it('true only when every settled gateway payment ran in test mode', async () => {
    await order('T-ONLY', [{ mode: 'test', status: 'settled' }]);
    await order('LIVE', [{ mode: 'live', status: 'settled' }]);
    await order('MIXED', [{ mode: 'test', status: 'settled' }, { mode: 'live', status: 'settled' }]);
    await order('UNSETTLED-TEST', [{ mode: 'test', status: 'failed' }]);
    await order('NONE', []);
    expect(await read('T-ONLY')).toBe(true);
    expect(await read('LIVE')).toBe(false);
    expect(await read('MIXED')).toBe(false);
    expect(await read('UNSETTLED-TEST')).toBe(false);
    expect(await read('NONE')).toBe(false);
  });
});
