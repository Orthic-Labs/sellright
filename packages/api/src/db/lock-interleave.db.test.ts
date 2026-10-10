// T-L2: concurrent transactions that take the same rows through withLockedSet serialize
// in the global class order and never deadlock. DB-gated: *_test only.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from './client.js';
import { withLockedSet } from './locks.js';
import { env } from '../env.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
const isTestDb = /_test(\b|$|\?)/.test(DB);
const STORE = '78787878-7878-7878-7878-787878787878';
const CUSTOMER = '68686868-6868-6868-6868-686868686868';
const ORDER_A = '58585858-5858-5858-5858-585858585858';
const ORDER_B = '59595959-5959-5959-5959-595959595959';
const LIC_A = '48484848-4848-4848-4848-48484848484a';
const LIC_B = '48484848-4848-4848-4848-48484848484b';

async function wipe(): Promise<void> {
  await pool.query('TRUNCATE store CASCADE');
}

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'interleave-test', 'Interleave Test', 'USD', '{}'::jsonb)`,
    [STORE],
  );
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (${CUSTOMER}, ${STORE}, 'interleave@x.test')`);
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, customer_id) VALUES
      (${ORDER_A}, ${STORE}, 'IL-1', ${CUSTOMER}), (${ORDER_B}, ${STORE}, 'IL-2', ${CUSTOMER})`);
    await tx.execute(sql`INSERT INTO license (id, store_id, app_key, license_key, order_id, customer_id) VALUES
      (${LIC_A}, ${STORE}, 'app', 'il-a', ${ORDER_A}, ${CUSTOMER}), (${LIC_B}, ${STORE}, 'app', 'il-b', ${ORDER_A}, ${CUSTOMER})`);
  });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!isTestDb)('T-L2 interleaving under withLockedSet', () => {
  beforeEach(async () => {
    await wipe();
    await seed();
  });
  afterAll(wipe);

  it('two sets on the same order serialize: the second starts only after the first commits', async () => {
    const events: string[] = [];
    const run = (name: string) => withLockedSet(STORE, { kind: 'order', orderId: ORDER_A }, async () => {
      events.push(`${name}:start`);
      await pause(250);
      events.push(`${name}:end`);
      return name;
    });
    const results = await Promise.all([run('x'), run('y')]);
    expect(results.sort()).toEqual(['x', 'y']);
    // Each start is immediately preceded by the other's end (no overlap).
    expect(events[1]).toMatch(/:end$/);
    expect(events[0]!.split(':')[0]).toBe(events[1]!.split(':')[0]);
    expect(events[2]!.split(':')[1]).toBe('start');
  }, 20000);

  it('opposite subject orders in concurrent sets never deadlock (planned as one sorted union)', async () => {
    const a = withLockedSet(STORE, [{ kind: 'order', orderId: ORDER_A }, { kind: 'order', orderId: ORDER_B }],
      async () => { await pause(150); return 'a'; });
    const b = withLockedSet(STORE, [{ kind: 'order', orderId: ORDER_B }, { kind: 'order', orderId: ORDER_A }],
      async () => { await pause(150); return 'b'; });
    await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b']);
  }, 20000);

  it('an order set and a licence-touching set on the same licence serialize without deadlock', async () => {
    const order = withLockedSet(STORE, { kind: 'order', orderId: ORDER_A }, async (tx) => {
      await pause(150);
      await tx.execute(sql`UPDATE license SET status = status WHERE id = ${LIC_B}`);
      return 'order';
    });
    const licence = withLockedSet(STORE, { kind: 'customer', customerId: CUSTOMER, scope: 'all' }, async (tx) => {
      await tx.execute(sql`UPDATE license SET status = status WHERE id = ${LIC_A}`);
      return 'customer';
    });
    await expect(Promise.all([order, licence])).resolves.toEqual(['order', 'customer']);
  }, 20000);

  // Checkout's subject shape ({checkout} + the session customer's {loyalty}, the set
  // routes/checkout.ts takes when points are redeemed) against an admin cancel of one
  // of that customer's orders ({order}). Both plan ORDER_A; the checkout set also plans
  // ORDER_B (all of the customer's orders), so the union is acquired in one sorted order.
  it('checkout set and admin-cancel set on the same order serialize in both orders, no deadlock', async () => {
    // The loyalty subject locks only deferred-earn orders (X-46), so ORDER_A carries one.
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET metadata = '{"loyalty":{"deferredEarn":{"editId":"t"}}}'::jsonb WHERE id = ${ORDER_A}`));
    for (let round = 0; round < 5; round++) {
      const events: string[] = [];
      const checkout = withLockedSet(STORE, [{ kind: 'checkout' }, { kind: 'loyalty', customerId: CUSTOMER }], async (tx) => {
        events.push('checkout:start');
        await pause(60);
        await tx.execute(sql`UPDATE "order" SET state = state WHERE id = ${ORDER_A}`);
        events.push('checkout:end');
        return 'checkout';
      });
      const cancel = withLockedSet(STORE, { kind: 'order', orderId: ORDER_A }, async (tx) => {
        events.push('cancel:start');
        await tx.execute(sql`UPDATE "order" SET state = state WHERE id = ${ORDER_A}`);
        await pause(60);
        events.push('cancel:end');
        return 'cancel';
      });
      await expect(Promise.all([checkout, cancel])).resolves.toEqual(['checkout', 'cancel']);
      // No overlap: each start is preceded by the other set's end.
      expect(events).toHaveLength(4);
      expect(events[1]!.endsWith(':end')).toBe(true);
      expect(events[2]!.endsWith(':start')).toBe(true);
    }
  }, 30000);
});
