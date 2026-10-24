import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { closePools, locksPool, pool, poolGauges, runInJobScope } from './client.js';
import { env } from '../env.js';
import { withLeaderLock } from '../jobs/leader-lock.js';

// #358 / #360: jobs and shoppers draw from separate pools, and job leadership holds no connection.
if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Pool isolation fixture requires a *_test database');
afterAll(() => closePools());
afterEach(() => locksPool.query("DELETE FROM scheduler_lease WHERE name LIKE 'auto-deliver%'"));

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
