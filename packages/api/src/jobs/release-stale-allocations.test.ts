/**
 * DB tests for OPS-2: the stale-allocation release job must not double-release
 * stock when two scheduler instances (or two overlapping manual runs) fire the
 * same pass concurrently, and the scheduler's advisory leader-lock must make a
 * concurrent second tick a no-op.
 *
 * Runs against sellright_test ONLY. Mirrors admin-orders.bulk.test.ts / rls
 * suite conventions: _test-DB guard + TRUNCATE store CASCADE wipe + seed
 * helpers under withStore(). vitest runs files serially (fileParallelism:
 * false), so the shared DB is safe between files.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { releaseStaleAllocations } from './release-stale-allocations.js';
import { withLeaderLock } from './leader-lock.js';

// Safety: refuse to run against anything but a *_test database.
const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `release-stale test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`,
  );
}

const STORE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SLUG = 'release-stale-test-store';
const VARIANT = 'dddddddd-dddd-dddd-dddd-00000000000b';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

/** Seed store + one product/variant/stock row with `allocated` pre-reserved. */
async function seedStoreAndStock(allocated: number): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT}, ${STORE}, ${pid}, 'SKU1', 'V1', 1000) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 1000, ${allocated}) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 1000, allocated = ${allocated}`);
  });
}

/** Seed one stale PendingPayment order with a single line reserving `qty` units. */
async function seedStaleOrder(code: string, qty: number): Promise<string> {
  return withStore(STORE, async (tx) => {
    const staleCreatedAt = new Date(Date.now() - 2 * 3_600_000).toISOString(); // 2h ago
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total, created_at)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, 'PendingPayment', 'USD', 1000, ${staleCreatedAt}::timestamptz)
      RETURNING id`);
    const orderId = (r.rows[0] as { id: string }).id;
    await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${VARIANT}, 'SKU1', 'V1', ${qty}, 1000, 1000, 1000, 0)`);
    return orderId;
  });
}

async function stockAllocated(): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT allocated FROM stock WHERE variant_id = ${VARIANT}`);
    return (r.rows[0] as { allocated: number }).allocated;
  });
}

async function orderStates(): Promise<string[]> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT state FROM "order" WHERE store_id = ${STORE} ORDER BY code`);
    return (r.rows as { state: string }[]).map((row) => row.state);
  });
}

describe('releaseStaleAllocations concurrency (OPS-2)', () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await pool.end();
  });

  it('two concurrent passes release each stale allocation exactly once (no double-subtract)', async () => {
    // Seed enough allocated stock for THREE orders reserving 5 units each — if
    // either pass double-processed a claimed order, allocated would go too low
    // (or hit the greatest(...,0) floor and mask the bug), and the per-line
    // sum released would exceed 15.
    await seedStoreAndStock(15);
    await seedStaleOrder('STALE-A', 5);
    await seedStaleOrder('STALE-B', 5);
    await seedStaleOrder('STALE-C', 5);

    const opts = { apply: true, ttlMin: 60 } as const;
    // Fire two passes concurrently — FOR UPDATE SKIP LOCKED means the second
    // pass's SELECT simply skips any order the first pass already claimed,
    // rather than blocking and re-processing it.
    const [a, b] = await Promise.all([releaseStaleAllocations(opts), releaseStaleAllocations(opts)]);

    // Combined, exactly 3 orders / 15 units are ever claimed — split however
    // SKIP LOCKED happened to race, never double-counted.
    expect(a.orders + b.orders).toBe(3);
    expect(a.released + b.released).toBe(15);

    // The stock row proves it: allocated must land at exactly 0, not negative
    // (floored by greatest(...,0), which would silently hide a double-release)
    // and not left at a partial value (a skipped release).
    expect(await stockAllocated()).toBe(0);

    // All three orders transitioned to Cancelled exactly once each.
    expect(await orderStates()).toEqual(['Cancelled', 'Cancelled', 'Cancelled']);
  });

  it('advisory leader lock makes a second concurrent tick a no-op', async () => {
    await seedStoreAndStock(5);
    await seedStaleOrder('STALE-LEADER', 5);

    let innerRuns = 0;
    const tick = () => withLeaderLock('release-stale', async () => {
      innerRuns++;
      // Hold the lock for a moment so the second concurrent tick observes it
      // as already held (pg_try_advisory_lock is non-blocking — without this
      // overlap window the race would be too narrow to reliably exercise).
      await releaseStaleAllocations({ apply: true, ttlMin: 60 });
      await new Promise((r) => setTimeout(r, 50));
      return 'ran'; // sentinel: withLeaderLock returns fn()'s value for the leader,
      // undefined for the skipped tick — the fn must return something non-undefined
      // for the two to be distinguishable by return value.
    });

    const [first, second] = await Promise.all([tick(), tick()]);
    // Exactly one of the two ticks acquired the lock and ran; the other saw
    // pg_try_advisory_lock() fail and returned undefined without touching the DB.
    const ran = [first, second].filter((r) => r !== undefined);
    expect(ran).toHaveLength(1);
    expect(innerRuns).toBe(1);

    expect(await stockAllocated()).toBe(0);
    expect(await orderStates()).toEqual(['Cancelled']);
  });
});
