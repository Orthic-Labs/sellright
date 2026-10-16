/**
 * T-L2 (PAYMENT-TIMING.md §8): account erasure vs a refund on one of the customer's
 * orders, interleaved on the same customer. Both run under the lock set (erasure:
 * {customer}; refund: {order}, which plans the order's licences first). Invariants:
 * no deadlock (40P01), both calls complete, the erasure result is consistent.
 * DB-gated: *_test database only.
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { withLockedSet } from '../db/locks.js';
import { createSession } from '../auth/session.js';
import { hashPassword } from '../auth/password.js';
import { account } from './account.js';
import { auth as nativeAuth } from './auth.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'account-erasure-lock.db.test.ts');

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeee2222';
const SLUG = 'account-erasure-lock-test-store';
const CUSTOMER = 'eeeeeeee-eeee-eeee-eeee-0000000000e2';
const ORDER = 'eeeeeeee-eeee-eeee-eeee-0000000000a2';
const ROUNDS = 12;

const app = new OpenAPIHono();
app.route('/', account);
app.route('/', nativeAuth);

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

/** Observe an actual database wait, rather than infer progress from elapsed time. */
async function waitForBlockedQuery(blockerPid: number, queryPart: string): Promise<number> {
  const deadline = Date.now() + 3500;
  do {
    const { rows } = await pool.query<{ pid: number }>(`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
        AND strpos(lower(query), $2) > 0 AND wait_event_type = 'Lock'`, [blockerPid, queryPart]);
    if (rows[0]) return rows[0].pid;
    await wait(15);
  } while (Date.now() < deadline);
  throw new Error(`expected ${queryPart} query waiting on backend ${blockerPid}`);
}

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
  it('serializes native login behind erasure after sessions are deleted', async () => {
    const password = 'erase-login-customer-lock';
    await pool.query('UPDATE customer SET password_hash = $1 WHERE id = $2', [await hashPassword(password), CUSTOMER]);
    const { rows: outbox } = await pool.query<{ id: string }>(`
      INSERT INTO email_outbox (store_id, kind, recipient, payload)
      VALUES ($1, 'email_verify', 'erase-lock@acct.test', '{"subject":"fixture"}'::jsonb) RETURNING id`, [STORE]);
    const blocker = await pool.connect();
    let erase: Promise<Response> | undefined;
    let login: Promise<Response> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query("SET LOCAL statement_timeout = '10s'");
      await blocker.query("SELECT set_config('app.current_store', $1, true)", [STORE]);
      const { rows } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await blocker.query('SELECT id FROM email_outbox WHERE id = $1 FOR UPDATE', [outbox[0]!.id]);

      erase = Promise.resolve(app.request('/v1/shop/account', { method: 'DELETE', headers: auth() }));
      // Scrubbing is after DELETE session, immediately before deleting customer.
      const erasurePid = await waitForBlockedQuery(rows[0]!.pid, 'email_outbox');
      login = Promise.resolve(app.request('/v1/shop/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-store-slug': SLUG },
        body: JSON.stringify({ email: 'erase-lock@acct.test', password }),
      }));
      const loginPid = await waitForBlockedQuery(erasurePid, 'customer');
      const waiting = await pool.query<{ query: string }>('SELECT query FROM pg_stat_activity WHERE pid = $1', [loginPid]);
      expect(waiting.rows[0]!.query.toLowerCase()).toContain('for update');

      await blocker.query('ROLLBACK');
      expect((await erase).status).toBe(200);
      expect((await login).status).toBe(401);
      expect((await pool.query('SELECT id FROM customer WHERE id = $1', [CUSTOMER])).rowCount).toBe(0);
      expect((await pool.query('SELECT id FROM "session" WHERE customer_id = $1', [CUSTOMER])).rowCount).toBe(0);
    } finally {
      try {
        await blocker.query('ROLLBACK');
      } finally {
        blocker.release();
        await Promise.allSettled([erase, login].filter((request): request is Promise<Response> => request !== undefined));
      }
    }
  }, 30000);

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
