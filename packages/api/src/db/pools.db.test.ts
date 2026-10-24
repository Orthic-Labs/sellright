import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { closePools, LeaseLostError, locksPool, pool, poolGauges, runInJobScope, withAdvisoryLocks, withStore } from './client.js';
import { createApp } from '../app.js';
import { env } from '../env.js';
import { legacyAdvisoryKey, withLeaderLock } from '../jobs/leader-lock.js';

// #358 / #360: jobs and shoppers draw from separate pools, and job leadership holds no connection.
if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Pool isolation fixture requires a *_test database');
afterAll(() => closePools());
afterEach(() => locksPool.query("DELETE FROM scheduler_lease WHERE name LIKE 'auto-deliver%' OR name LIKE 'fence-probe%'"));

const busy = (name: string) => { const g = poolGauges()[name]!; return g.total - g.idle; };

async function holdAll(count: number, connect: () => Promise<PoolClient>): Promise<PoolClient[]> {
  return Promise.all(Array.from({ length: count }, connect));
}

describe('pool isolation', () => {
  it('a job still runs while every request connection is held', async () => {
    const held = await holdAll(env.PGPOOL_MAX, () => pool.connect());
    try {
      expect(busy('requests')).toBe(env.PGPOOL_MAX);
      const r = await runInJobScope(() => pool.query<{ ok: number }>('SELECT 1 AS ok'));
      expect(r.rows[0]!.ok).toBe(1);
      expect(poolGauges().requests!.waiting).toBe(0);
    } finally {
      for (const c of held) c.release();
    }
  });

  it('a request still runs while every job connection is held', async () => {
    const held = await runInJobScope(() => holdAll(env.PGJOBS_POOL_MAX, () => pool.connect()));
    try {
      expect(busy('jobs')).toBe(env.PGJOBS_POOL_MAX);
      const r = await pool.query<{ ok: number }>('SELECT 1 AS ok');
      expect(r.rows[0]!.ok).toBe(1);
      expect(poolGauges().jobs!.waiting).toBe(0);
    } finally {
      for (const c of held) c.release();
    }
  });

  it('job sessions carry the 120 s statement timeout; request sessions keep the role default', async () => {
    const job = await runInJobScope(() => pool.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t"));
    expect(job.rows[0]!.t).toBe('2min');
    const req = await pool.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t");
    expect(req.rows[0]!.t).not.toBe('2min');
  });
});

describe('leader lease', () => {
  it('holds no request or lock connection while the leader works', async () => {
    const seen = await withLeaderLock('auto-deliver', async () => ({ requests: busy('requests'), locks: busy('locks') }));
    expect(seen).toEqual({ requests: 0, locks: 0 });
    const rows = await locksPool.query("SELECT 1 FROM scheduler_lease WHERE name = 'auto-deliver'");
    expect(rows.rowCount).toBe(0); // released on exit
  });

  it('refuses a live lease held elsewhere and takes over an expired one', async () => {
    await locksPool.query(
      "INSERT INTO scheduler_lease (name, token, holder, expires_at) VALUES ('auto-deliver', $1, 'other:1', now() + interval '1 minute')",
      [randomUUID()],
    );
    expect(await withLeaderLock('auto-deliver', async () => 'ran')).toBeUndefined();
    await locksPool.query("UPDATE scheduler_lease SET expires_at = now() - interval '1 second' WHERE name = 'auto-deliver'");
    expect(await withLeaderLock('auto-deliver', async () => 'ran')).toBe('ran');
  });

  it('scopes per-store publishers independently and a nested claim of the same name is refused', async () => {
    await withLeaderLock('auto-deliver', async () => {
      expect(await withLeaderLock('auto-deliver', async () => 'nested')).toBeUndefined();
      expect(await withLeaderLock('auto-deliver', async () => 'scoped', 'store-a')).toBe('scoped');
    });
  });
});

describe('lease fencing (#360 N2)', () => {
  const STORE = randomUUID(); // runStoreTransaction only sets the RLS context; the probe row is global

  it('an expired lease cannot commit: the transaction is rolled back', async () => {
    await locksPool.query("INSERT INTO scheduler_lease (name, token, holder, expires_at) VALUES ('fence-probe', $1, 'probe', now() + interval '1 hour')", [randomUUID()]);
    const outcome = await withLeaderLock('auto-deliver', async () => {
      // Another worker's view: the lease expires (a stalled renewal) while this pass is mid-transaction.
      await locksPool.query("UPDATE scheduler_lease SET expires_at = now() - interval '1 second' WHERE name = 'auto-deliver'");
      return withStore(STORE, async (tx) => {
        await tx.execute(sql`UPDATE scheduler_lease SET holder = 'written-by-expired-worker' WHERE name = 'fence-probe'`);
        return 'committed';
      }).catch((e: unknown) => e);
    });
    expect(outcome).toBeInstanceOf(LeaseLostError);
    const probe = await locksPool.query<{ holder: string }>("SELECT holder FROM scheduler_lease WHERE name = 'fence-probe'");
    expect(probe.rows[0]!.holder).toBe('probe');
  });

  it('a lease taken over by another worker cannot commit either', async () => {
    const outcome = await withLeaderLock('auto-deliver', async () => {
      await locksPool.query("UPDATE scheduler_lease SET token = $1, holder = 'other:2' WHERE name = 'auto-deliver'", [randomUUID()]);
      return withStore(STORE, async () => 'committed').catch((e: unknown) => e);
    });
    expect(outcome).toBeInstanceOf(LeaseLostError);
  });

  it('a held lease commits normally', async () => {
    expect(await withLeaderLock('auto-deliver', () => withStore(STORE, async () => 'committed'))).toBe('committed');
  });
});

describe('rollout guard (#360 N11)', () => {
  it('never claims a lease while an old-protocol runner holds the job\'s advisory lock', async () => {
    const old = await pool.connect();
    try {
      for (const [job, scope] of [['auto-deliver', undefined], ['catalog-manifest', 'store-a']] as const) {
        const { key, hashed } = legacyAdvisoryKey(job, scope);
        await old.query(hashed ? 'SELECT pg_advisory_lock(hashtextextended($1, 0))' : 'SELECT pg_advisory_lock($1::bigint)', [key]);
        expect(await withLeaderLock(job, async () => 'ran', scope)).toBeUndefined();
        await old.query(hashed ? 'SELECT pg_advisory_unlock(hashtextextended($1, 0))' : 'SELECT pg_advisory_unlock($1::bigint)', [key]);
        expect(await withLeaderLock(job, async () => 'ran', scope)).toBe('ran');
      }
    } finally {
      old.release();
    }
  });
});

describe('readiness probe (#360 N6)', () => {
  it('timed-out probes share one in-flight query and leave no growing waiters', async () => {
    const app = createApp();
    expect((await app.request('/v1/readyz')).status).toBe(200); // the locks pool exists
    const held = await holdAll(env.PGLOCKS_POOL_MAX, () => locksPool.connect());
    try {
      const responses = await Promise.all(Array.from({ length: 6 }, () => app.request('/v1/readyz')));
      expect(responses.map((r) => r.status)).toEqual(Array(6).fill(503));
      expect(poolGauges().locks!.waiting).toBeLessThanOrEqual(1);
    } finally {
      for (const c of held) c.release();
    }
    await expect.poll(async () => (await app.request('/v1/readyz')).status, { timeout: 10_000 }).toBe(200);
    expect(poolGauges().locks!.waiting).toBe(0);
  });
});

describe('advisory workflow locks (#360 N1)', () => {
  it('bounds the wait for a held workflow lock instead of waiting forever', async () => {
    let releaseHolder!: () => void;
    const holding = new Promise<void>((resolve) => { releaseHolder = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const holder = withAdvisoryLocks(['pay:fence-probe'], async () => { entered(); await holding; });
    await inside;
    const started = Date.now();
    await expect(withAdvisoryLocks(['pay:fence-probe'], async () => 'second')).rejects.toThrow(/lock timeout/);
    expect(Date.now() - started).toBeLessThan(env.PGADVISORY_LOCK_WAIT_MS + 3_000);
    releaseHolder();
    await holder;
    expect(await withAdvisoryLocks(['pay:fence-probe'], async () => 'after')).toBe('after');
  }, 30_000);
});
