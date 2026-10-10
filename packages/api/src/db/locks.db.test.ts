// withLockedSet (STOREKIT §5.3) against a real database. DB-gated: *_test only.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from './client.js';
import { LockSetUnstable, withLockedSet } from './locks.js';
import { env } from '../env.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
const isTestDb = /_test(\b|$|\?)/.test(DB);
const STORE = '77777777-7777-7777-7777-777777777777';
const CUSTOMER = '66666666-6666-6666-6666-666666666666';
const ORDER = '55555555-5555-5555-5555-555555555555';
const LIC_A = '44444444-4444-4444-4444-44444444444a';
const LIC_B = '44444444-4444-4444-4444-44444444444b';

async function wipe(): Promise<void> {
  await pool.query('TRUNCATE store CASCADE');
}

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'lock-test', 'Lock Test', 'USD', '{}'::jsonb)`,
    [STORE],
  );
  // RLS: rows of a store are written inside withStore (sets app.current_store).
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (${CUSTOMER}, ${STORE}, 'lock@x.test')`);
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, customer_id) VALUES (${ORDER}, ${STORE}, 'LOCK-1', ${CUSTOMER})`);
    await tx.execute(sql`INSERT INTO license (id, store_id, app_key, license_key, order_id, customer_id) VALUES
      (${LIC_A}, ${STORE}, 'app', 'k-a', ${ORDER}, ${CUSTOMER}), (${LIC_B}, ${STORE}, 'app', 'k-b', ${ORDER}, ${CUSTOMER})`);
  });
}

describe.skipIf(!isTestDb)('withLockedSet', () => {
  beforeEach(async () => {
    await wipe();
    await seed();
  });
  afterAll(wipe);

  it('plans the order licences and runs fn with the planned sets under the locks', async () => {
    const plan = await withLockedSet(STORE, { kind: 'order', orderId: ORDER }, async (_tx, _held, p) => p);
    expect([...plan.licenseIds].sort()).toEqual([LIC_A, LIC_B].sort());
    expect(plan.orderIds).toEqual([ORDER]);
  });

  it('a list of subjects is planned as the union of its members', async () => {
    const plan = await withLockedSet(
      STORE,
      [{ kind: 'order', orderId: ORDER }, { kind: 'customer', customerId: CUSTOMER, scope: 'orders' }],
      async (_tx, _held, p) => p,
    );
    expect(plan.orderIds).toEqual([ORDER]);
    expect([...plan.licenseIds].sort()).toEqual([LIC_A, LIC_B].sort());
  });

  it('an empty plan (order with no licences) acquires nothing extra and still runs fn', async () => {
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE license SET order_id = NULL`));
    const r = await withLockedSet(STORE, { kind: 'order', orderId: ORDER }, async () => 'ran');
    expect(r).toBe('ran');
  });

  it('a lock held by another session past lock_timeout (5s) maps to LockSetUnstable', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.current_store', $1, true)`, [STORE]);
      await holder.query(`SELECT 1 FROM "order" WHERE id = $1 FOR UPDATE`, [ORDER]);
      await expect(
        withLockedSet(STORE, { kind: 'order', orderId: ORDER }, async () => 'never', { maxRestarts: 0 }),
      ).rejects.toBeInstanceOf(LockSetUnstable);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }, 20000);

  it('fn sees rows it can update inside the set (no outer lock needed)', async () => {
    await withLockedSet(STORE, { kind: 'order', orderId: ORDER }, async (tx) => {
      await tx.execute(sql`UPDATE "order" SET code = 'LOCK-2' WHERE id = ${ORDER}`);
    });
    const rows = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT code FROM "order" WHERE id = ${ORDER}`)).rows);
    expect((rows[0] as { code: string }).code).toBe('LOCK-2');
  });
});
