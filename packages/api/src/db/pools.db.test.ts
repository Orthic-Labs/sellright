import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { schedulerLeaseAccess, checkConnectionBudget, closePools, currentLeaseSignal, inJobScope, LeaseLostError, LOCKS_QUERY_TIMEOUT_MS, locksPool, pool, poolGauges, runInJobScope, withAdvisoryLocks, withStore } from './client.js';
import { afterCommit } from './after-commit.js';
import { emailWakeIdleForTests, setEmailWakeEnabledForTests, wakeEmailDelivery } from '../email/wake.js';
import { deliverWebhooks } from '../webhooks/emit.js';
import { log, err as logErr } from '../lib/logger.js';
import { vi } from 'vitest';
import { createApp } from '../app.js';
import { env } from '../env.js';
import { _setLeaseTimingForTest, legacyAdvisoryKey, withLeaderLock } from '../jobs/leader-lock.js';

// #358 / #360: jobs and shoppers draw from separate pools, and job leadership holds no connection.
if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Pool isolation fixture requires a *_test database');
afterAll(async () => {
  await locksPool.query("DELETE FROM scheduler_lease WHERE name LIKE 'auto-deliver%' OR name LIKE 'fence-probe%' OR name = 'webhooks'");
  await closePools();
});
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

describe('detached work escapes the pass (#360 H1)', () => {
  const STORE = randomUUID();
  const seedProbe = () => locksPool.query("INSERT INTO scheduler_lease (name, token, holder, expires_at) VALUES ('fence-probe', $1, 'probe', now() + interval '1 hour') ON CONFLICT (name) DO UPDATE SET holder = 'probe'", [randomUUID()]);

  it('after-commit callbacks run outside the job scope and the lease fence', async () => {
    let seen: { job: boolean; signal: AbortSignal | undefined } | undefined;
    await runInJobScope(() => withLeaderLock('auto-deliver', () => withStore(STORE, async (tx) => {
      expect(inJobScope()).toBe(true);
      expect(currentLeaseSignal()).toBeDefined();
      afterCommit(tx, () => { seen = { job: inJobScope(), signal: currentLeaseSignal() }; });
    })));
    expect(seen).toEqual({ job: false, signal: undefined });
  });

  it('work a pass started but did not await still commits after the pass released its lease', async () => {
    await seedProbe();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let late!: Promise<unknown>;
    await withLeaderLock('auto-deliver', async () => {
      late = (async () => {
        await gate;
        return withStore(STORE, (tx) => tx.execute(sql`UPDATE scheduler_lease SET holder = 'late-commit' WHERE name = 'fence-probe'`));
      })();
    });
    const warn = vi.spyOn(log, 'warn');
    open(); // the lease row is gone by now
    await expect(late).resolves.toBeDefined();
    // The leak detector names the escaped work (re-review item 5).
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('escaped detachFromPass'))).toBe(true);
    warn.mockRestore();
    const probe = await locksPool.query<{ holder: string }>("SELECT holder FROM scheduler_lease WHERE name = 'fence-probe'");
    expect(probe.rows[0]!.holder).toBe('late-commit');
  });

  it('wakeEmailDelivery from inside a pass drains after the pass ended, without lease errors', async () => {
    const errors = vi.spyOn(logErr, 'error');
    setEmailWakeEnabledForTests(() => true);
    try {
      await withLeaderLock('auto-deliver', async () => { wakeEmailDelivery(); });
      await emailWakeIdleForTests();
      expect(errors.mock.calls.filter(([msg]) => String(msg).includes('email wake drain failed'))).toEqual([]);
    } finally {
      setEmailWakeEnabledForTests(null);
      errors.mockRestore();
    }
  });
});

describe('lease mechanics', () => {
  afterEach(() => _setLeaseTimingForTest(null));

  it('concurrent claims from separate connections: exactly one wins', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const claims = Array.from({ length: 4 }, () => withLeaderLock('auto-deliver', async () => { await gate; return 'ran'; }));
    await new Promise((r) => setTimeout(r, 200));
    open();
    const results = await Promise.all(claims);
    expect(results.filter((r) => r === 'ran')).toHaveLength(1);
  });

  it('a pass longer than the lease term keeps its lease by renewing', async () => {
    _setLeaseTimingForTest({ ttlMs: 600, renewMs: 150 });
    const out = await withLeaderLock('auto-deliver', async () => {
      await new Promise((r) => setTimeout(r, 1_500));
      expect(currentLeaseSignal()!.aborted).toBe(false);
      return withStore(randomUUID(), async () => 'committed');
    });
    expect(out).toBe('committed');
  });

  it('a renewal that finds the lease gone aborts the signal and refuses further commits', async () => {
    _setLeaseTimingForTest({ ttlMs: 600, renewMs: 100 });
    const out = await withLeaderLock('auto-deliver', async () => {
      const signal = currentLeaseSignal()!;
      await locksPool.query("UPDATE scheduler_lease SET token = $1, holder = 'other:3' WHERE name = 'auto-deliver'", [randomUUID()]);
      await expect.poll(() => signal.aborted, { timeout: 2_000 }).toBe(true);
      return withStore(randomUUID(), async () => 'committed').catch((e: unknown) => e);
    });
    expect(out).toBeInstanceOf(LeaseLostError);
  });

  it('the webhook pass\'s own delivery pool is fenced too', async () => {
    const STORE = randomUUID();
    await pool.query("INSERT INTO store (id, slug, name, currency) VALUES ($1, $2, 'Fence', 'USD')", [STORE, `fence-${STORE.slice(0, 8)}`]);
    try {
      const out = await withLeaderLock('webhooks', async () => {
        await locksPool.query("UPDATE scheduler_lease SET expires_at = now() - interval '1 second' WHERE name = 'webhooks'");
        return deliverWebhooks({ limit: 1 }).catch((e: unknown) => e);
      });
      expect(out).toBeInstanceOf(AggregateError);
      expect((out as AggregateError).errors.some((e) => e instanceof LeaseLostError)).toBe(true);
    } finally {
      await pool.query('DELETE FROM store WHERE id = $1', [STORE]);
    }
  });
});

describe('bounded failure modes', () => {
  it('a real pool acquire timeout answers 503; Retry-After only on GET', async () => {
    const app = createApp();
    app.get('/__fixture/db', async (c) => { await pool.query('SELECT 1'); return c.text('ok'); });
    app.post('/__fixture/db', async (c) => { await pool.query('SELECT 1'); return c.text('ok'); });
    const held = await holdAll(env.PGPOOL_MAX, () => pool.connect());
    try {
      const [get, post] = await Promise.all([app.request('/__fixture/db'), app.request('/__fixture/db', { method: 'POST' })]);
      expect([get.status, post.status]).toEqual([503, 503]);
      expect(get.headers.get('retry-after')).toBe('2');
      expect(post.headers.get('retry-after')).toBeNull();
    } finally {
      for (const c of held) c.release();
    }
  }, 30_000);

  it('a hung statement on the locks pool is abandoned at the client-side ceiling', async () => {
    const started = Date.now();
    await expect(locksPool.query('SELECT pg_sleep(30)')).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(LOCKS_QUERY_TIMEOUT_MS + 2_000);
    await expect.poll(() => poolGauges().locks!.waiting).toBe(0);
  }, 30_000);

  it('the connection budget check warns past PG_CONNECTION_BUDGET', async () => {
    const warn = vi.spyOn(log, 'warn');
    try {
      await checkConnectionBudget({ ...env, PG_CONNECTION_BUDGET: 5 });
      expect(warn.mock.calls.some(([msg]) => String(msg).includes('db connection budget exceeded'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('scheduler_lease grants (#360 L5)', () => {
  it('requires ALL of SELECT, INSERT, UPDATE and DELETE: a SELECT-only role is denied', async () => {
    const role = `sr_probe_select_${randomUUID().slice(0, 8)}`;
    await pool.query(`CREATE ROLE ${role} NOLOGIN`);
    try {
      await pool.query(`GRANT SELECT ON scheduler_lease TO ${role}`);
      expect(await schedulerLeaseAccess(role)).toBe('denied');
      await pool.query(`GRANT INSERT, UPDATE, DELETE ON scheduler_lease TO ${role}`);
      expect(await schedulerLeaseAccess(role)).toBe('ok');
    } finally {
      await pool.query(`REVOKE ALL ON scheduler_lease FROM ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    }
  });
});
