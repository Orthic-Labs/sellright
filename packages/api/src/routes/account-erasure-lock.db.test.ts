/**
 * T-L2 (PAYMENT-TIMING.md §8): account erasure vs a refund on one of the customer's
 * orders, interleaved on the same customer. Both run under the lock set (erasure:
 * {customer}; refund: {order}, which plans the order's licences first). Invariants:
 * no deadlock (40P01), both calls complete, the erasure result is consistent.
 * DB-gated: *_test database only.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { withLockedSet } from '../db/locks.js';
import { createSession } from '../auth/session.js';
import { account } from './account.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`account-erasure-lock test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeee2222';
const SLUG = 'account-erasure-lock-test-store';
const CUSTOMER = 'eeeeeeee-eeee-eeee-eeee-0000000000e2';
const ORDER = 'eeeeeeee-eeee-eeee-eeee-0000000000a2';
const ROUNDS = 12;

const app = new OpenAPIHono();
app.route('/', account);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

async function seed(): Promise<string> {
  let token = '';
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, email_verified) VALUES (${CUSTOMER}, ${STORE}, 'erase-lock@acct.test', true)`);
    token = await createSession(tx, STORE, CUSTOMER);
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, customer_id, state, grand_total)
      VALUES (${ORDER}, ${STORE}, 'ORD-LOCK-1', ${CUSTOMER}, 'Paid', 5000)`);
    await tx.execute(sql`INSERT INTO license (id, store_id, customer_id, order_id, app_key, license_key, status, seats)
      VALUES (gen_random_uuid(), ${STORE}, ${CUSTOMER}, ${ORDER}, 'someapp', 'SK-LOCK-1', 'active'::license_status, 1)`);
  });
  return token;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let token = '';
beforeEach(async () => {
  await wipe();
  token = await seed();
});
afterAll(async () => { await wipe(); });

const auth = () => ({ authorization: `Bearer ${token}`, 'x-store-slug': SLUG });

/** Refund-shaped transaction: finalize under the order set (licences planned first). */
const refundShape = (delayMs: number) => (async () => {
  await wait(delayMs);
  return withLockedSet(STORE, { kind: 'order', orderId: ORDER }, async (tx, _held, plan) => {
    await tx.execute(sql`UPDATE "order" SET state = 'PartiallyRefunded' WHERE id = ${ORDER} AND store_id = ${STORE}`);
    for (const id of plan.licenseIds) {
      await tx.execute(sql`UPDATE license SET metadata = coalesce(metadata, '{}'::jsonb) || '{"refund_seen":true}'::jsonb WHERE id = ${id} AND store_id = ${STORE}`);
    }
    return 'refunded' as const;
  });
})();

describe('T-L2: account erasure vs refund on one of the customer orders', () => {
  it(`${ROUNDS} randomized interleavings: no deadlock, both complete, erasure consistent`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await wipe();
      token = await seed();
      const erase = (async () => {
        await wait(Math.random() * 5);
        return app.request('/v1/shop/account', { method: 'DELETE', headers: auth() });
      })();
      const [res, refund] = await Promise.all([erase, refundShape(Math.random() * 5)]);
      expect(res.status).toBe(200);
      expect(refund).toBe('refunded');

      const state = await withStore(STORE, async (tx) => {
        const [cust] = await tx.execute(sql`SELECT id FROM customer WHERE id = ${CUSTOMER}`).then((r) => r.rows);
        const [ord] = (await tx.execute(sql`SELECT customer_id, state, shipping_address, metadata FROM "order" WHERE id = ${ORDER}`)).rows as Array<{
          customer_id: string | null; state: string; shipping_address: unknown; metadata: { anonymized_at?: string } | null;
        }>;
        const [lic] = (await tx.execute(sql`SELECT customer_id FROM license WHERE order_id = ${ORDER}`)).rows as Array<{ customer_id: string | null }>;
        return { cust, ord, lic };
      });
      expect(state.cust).toBeUndefined();
      expect(state.ord!.customer_id).toBeNull();
      expect(state.ord!.metadata?.anonymized_at).toBeTruthy();
      expect(state.lic!.customer_id).toBeNull();
      // Refund either ran before erasure (state PartiallyRefunded) or after (erasure keeps state).
      expect(['Paid', 'PartiallyRefunded']).toContain(state.ord!.state);
    }
  }, 120000);
});
