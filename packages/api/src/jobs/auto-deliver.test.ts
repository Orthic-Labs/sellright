/**
 * DB tests for PERF-12: the auto-deliver job must not double-transition
 * fulfillments when two scheduler instances (or two overlapping manual runs)
 * fire the same pass concurrently. Mirrors release-stale-allocations.test.ts
 * (OPS-2): the FOR UPDATE SKIP LOCKED claim must let two concurrent passes
 * split the backlog without overlap, and the batched UPDATE + audit insert
 * must commit exactly once per claimed row.
 *
 * Runs against sellright_test ONLY. Same conventions as
 * release-stale-allocations.test.ts: _test-DB guard + TRUNCATE store CASCADE
 * wipe + seed helpers under withStore(). vitest runs files serially
 * (fileParallelism: false), so the shared DB is safe between files.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { autoDeliver } from './auto-deliver.js';
import { withLeaderLock } from './leader-lock.js';

// Safety: refuse to run against anything but a *_test database.
const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `auto-deliver test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`,
  );
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const SLUG = 'auto-deliver-test-store';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

/** Seed a single store; auto-deliver walks every store, so the test store is the only one present. */
async function seedStore(): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
  });
}

/** Seed one Shipped fulfillment updated `daysAgo` days ago (so it falls past the cutoff). */
async function seedShippedFulfillment(code: string, daysAgo: number): Promise<{ fulfillmentId: string; orderId: string }> {
  return withStore(STORE, async (tx) => {
    const oldUpdated = new Date(Date.now() - daysAgo * 86_400_000);
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, 'Paid', 'USD', 1000)
      RETURNING id`);
    const orderId = (r.rows[0] as { id: string }).id;
    const fr = await tx.execute(sql`
      INSERT INTO fulfillment (id, store_id, order_id, state, tracking_code, carrier, created_at, updated_at)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, 'Shipped', ${sql.param(`TRK-${code}`)}, 'ups', ${oldUpdated}, ${oldUpdated})
      RETURNING id`);
    return { fulfillmentId: (fr.rows[0] as { id: string }).id, orderId };
  });
}

async function fulfillmentStates(): Promise<Array<{ id: string; state: string; orderId: string }>> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id, state, order_id FROM fulfillment WHERE store_id = ${STORE} ORDER BY id`);
    return (r.rows as Array<{ id: string; state: string; order_id: string }>).map((row) => ({
      id: row.id,
      state: row.state,
      orderId: row.order_id,
    }));
  });
}

async function auditLogCount(): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT count(*)::int AS c FROM audit_log WHERE store_id = ${STORE} AND action = 'auto_delivered'`);
    return (r.rows[0] as { c: number }).c;
  });
}

describe('autoDeliver concurrency (PERF-12)', () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await pool.end();
  });

  it('two concurrent passes transition each Shipped fulfillment exactly once (no double-transition)', async () => {
    await seedStore();
    // Three fulfillments each 30 days old (>10-day default threshold) — all
    // due. If either pass double-claimed a row, the audit_log would record
    // the auto_delivered event twice for the same order.
    const a = await seedShippedFulfillment('AD-A', 30);
    const b = await seedShippedFulfillment('AD-B', 30);
    const c = await seedShippedFulfillment('AD-C', 30);

    const opts = { apply: true, days: 10 } as const;
    // Fire two passes concurrently — FOR UPDATE SKIP LOCKED means the second
    // pass's SELECT simply skips any fulfillment the first pass already
    // claimed, so the two passes split the backlog instead of racing on it.
    const [r1, r2] = await Promise.all([autoDeliver(opts), autoDeliver(opts)]);

    // Combined, exactly 3 fulfillments were ever claimed — split however
    // SKIP LOCKED happened to race, never double-counted.
    expect(r1 + r2).toBe(3);

    // Every fulfillment is Delivered exactly once — and only once.
    const states = await fulfillmentStates();
    expect(states).toHaveLength(3);
    for (const f of states) {
      expect(f.state).toBe('Delivered');
    }
    // No fulfillment should appear twice (no double-update artefact).
    const ids = new Set(states.map((s) => s.id));
    expect(ids.size).toBe(3);

    // The audit log proves the per-row side-effect didn't double-fire either.
    // One auto_delivered row per claimed fulfillment — three total, not six.
    expect(await auditLogCount()).toBe(3);
    // Sanity: every seeded order has exactly one audit row keyed to it.
    const auditRows = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT entity_id FROM audit_log WHERE store_id = ${STORE} AND action = 'auto_delivered' ORDER BY entity_id`);
      return (r.rows as Array<{ entity_id: string }>).map((row) => row.entity_id);
    });
    expect(new Set(auditRows).size).toBe(3);
    expect(new Set(auditRows)).toEqual(new Set([a.orderId, b.orderId, c.orderId]));
  });

  it('SKIP LOCKED skips a row held by another transaction (does not block or double-claim)', async () => {
    await seedStore();
    await seedShippedFulfillment('AD-LOCKED', 30);
    await seedShippedFulfillment('AD-UNLOCKED', 30);

    // Open a dedicated pg.Client (NOT the shared pool) and hold a row-level
    // lock on 'AD-LOCKED' for the duration of the concurrent autoDeliver pass.
    // A dedicated client guarantees the lock lives on a SESSION that the
    // pool's other clients can see — so the autoDeliver's SELECT FOR UPDATE
    // SKIP LOCKED actually observes a held row to skip. Using a pool client
    // would risk the pool returning the SAME client to both the locker and
    // autoDeliver (the locker is just `BEGIN`/idle, the pool may reissue it).
    const { Client } = await import('pg');
    const locker = new Client({ connectionString: env.DATABASE_URL });
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query("SELECT set_config('app.current_store', $1, true)", [STORE]);
      const lockResult = await locker.query(
        "SELECT id FROM fulfillment WHERE store_id = $1 AND order_id = (SELECT id FROM \"order\" WHERE store_id = $1 AND code = $2) FOR UPDATE",
        [STORE, 'AD-LOCKED'],
      );
      expect(lockResult.rows.length).toBe(1);

      // Race the autoDeliver pass against the still-held lock. SKIP LOCKED
      // means the contended row is skipped, not waited on — the pass resolves
      // promptly and claims only the unlocked row.
      const delivered = await autoDeliver({ apply: true, days: 10, batchLimit: 10 });
      expect(delivered).toBe(1);

      // Fetch state joined to order code so the assertions are unambiguous.
      const coded = await withStore(STORE, async (tx) => {
        const r = await tx.execute(sql`
          SELECT o.code AS code, f.state AS state
          FROM fulfillment f JOIN "order" o ON o.id = f.order_id
          WHERE f.store_id = ${STORE}
          ORDER BY o.code`);
        return r.rows as Array<{ code: string; state: string }>;
      });
      const byCode = new Map(coded.map((row) => [row.code, row.state]));
      expect(byCode.get('AD-LOCKED')).toBe('Shipped');
      expect(byCode.get('AD-UNLOCKED')).toBe('Delivered');

      // Audit log recorded the one Delivered transition, not two.
      expect(await auditLogCount()).toBe(1);
    } finally {
      try { await locker.query('ROLLBACK'); } catch { /* already done */ }
      await locker.end();
    }

    // After releasing the lock, the next pass should pick up AD-LOCKED.
    const second = await autoDeliver({ apply: true, days: 10, batchLimit: 10 });
    expect(second).toBe(1);
    const finalCoded = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`
        SELECT o.code AS code, f.state AS state
        FROM fulfillment f JOIN "order" o ON o.id = f.order_id
        WHERE f.store_id = ${STORE}
        ORDER BY o.code`);
      return r.rows as Array<{ code: string; state: string }>;
    });
    const finalByCode = new Map(finalCoded.map((row) => [row.code, row.state]));
    expect(finalByCode.get('AD-LOCKED')).toBe('Delivered');
    expect(finalByCode.get('AD-UNLOCKED')).toBe('Delivered');
    // Total audit rows now 2 (one per delivery pass), not 3+.
    expect(await auditLogCount()).toBe(2);
  });

  it('advisory leader lock makes a second concurrent tick a no-op', async () => {
    await seedStore();
    await seedShippedFulfillment('AD-LEADER', 30);

    let innerRuns = 0;
    const tick = () => withLeaderLock('auto-deliver', async () => {
      innerRuns++;
      // Hold the lock for a moment so the second concurrent tick observes it
      // as already held (pg_try_advisory_lock is non-blocking).
      await autoDeliver({ apply: true, days: 10 });
      await new Promise((r) => setTimeout(r, 50));
      return 'ran'; // sentinel — withLeaderLock returns fn()'s value for the
      // leader, undefined for the skipped tick.
    });

    const [first, second] = await Promise.all([tick(), tick()]);
    const ran = [first, second].filter((r) => r !== undefined);
    expect(ran).toHaveLength(1);
    expect(innerRuns).toBe(1);

    // The single leader pass transitioned the one fulfillment — the skipped
    // tick did NOT also touch it.
    const coded = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`
        SELECT o.code AS code, f.state AS state
        FROM fulfillment f JOIN "order" o ON o.id = f.order_id
        WHERE f.store_id = ${STORE}`);
      return r.rows as Array<{ code: string; state: string }>;
    });
    expect(coded).toEqual([{ code: 'AD-LEADER', state: 'Delivered' }]);
    expect(await auditLogCount()).toBe(1);
  });

  it('dry-run default takes the same SELECT path but does NOT update or audit', async () => {
    await seedStore();
    await seedShippedFulfillment('AD-DRY', 30);

    const n = await autoDeliver({ apply: false, days: 10 });
    expect(n).toBe(1);

    // Fulfillment is still Shipped — dry-run never committed an UPDATE.
    const coded = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`
        SELECT o.code AS code, f.state AS state
        FROM fulfillment f JOIN "order" o ON o.id = f.order_id
        WHERE f.store_id = ${STORE}`);
      return r.rows as Array<{ code: string; state: string }>;
    });
    expect(coded).toEqual([{ code: 'AD-DRY', state: 'Shipped' }]);

    // No audit row from the dry-run.
    expect(await auditLogCount()).toBe(0);
  });
});