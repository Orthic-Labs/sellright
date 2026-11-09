import { describe, expect, it, vi } from 'vitest';
import { explainMigrationError, MIGRATION_ADVISORY_LOCK_KEY, MIGRATION_SESSION_OPTIONS, withMigrationLock, type LockClientLike } from './migration-lock.js';

/** A fake connection: pg_try_advisory_lock answers from `script`, everything is recorded. */
function fakeClient(script: boolean[], unlockError?: Error) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const client: LockClientLike = {
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: script.shift() ?? true }] };
      if (text.includes('pg_advisory_unlock')) { if (unlockError) throw unlockError; return { rows: [{ pg_advisory_unlock: true }] }; }
      return { rows: [] };
    },
  };
  return { client, calls };
}

describe('withMigrationLock (DB-H1)', () => {
  it('takes the fixed key, runs fn while holding it, and releases it afterwards', async () => {
    const { client, calls } = fakeClient([true]);
    const order: string[] = [];
    const result = await withMigrationLock(client, async () => { order.push(`fn after ${calls.length} call(s)`); return 42; });
    expect(result).toBe(42);
    expect(order).toEqual(['fn after 1 call(s)']);
    expect(calls.map((c) => c.text.match(/pg_\w+/)![0])).toEqual(['pg_try_advisory_lock', 'pg_advisory_unlock']);
    expect(calls[0]!.values).toEqual([MIGRATION_ADVISORY_LOCK_KEY.toString()]);
    expect(calls[1]!.values).toEqual([MIGRATION_ADVISORY_LOCK_KEY.toString()]);
  });

  it('releases the lock when fn throws, and rethrows the same error', async () => {
    const { client, calls } = fakeClient([true]);
    const boom = new Error('boom');
    await expect(withMigrationLock(client, async () => { throw boom; })).rejects.toBe(boom);
    expect(calls.at(-1)!.text).toContain('pg_advisory_unlock');
  });

  it('a second concurrent run waits (logging once) until the first releases, then runs', async () => {
    const { client } = fakeClient([false, false, true]);
    const logs: string[] = [];
    const sleep = vi.fn(async () => undefined);
    let t = 0;
    const fn = vi.fn(async () => 'done');
    await withMigrationLock(client, fn, { log: (m) => logs.push(m), sleep, now: () => (t += 100), pollMs: 10 });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(logs.filter((m) => m.includes('waiting'))).toHaveLength(1);
    expect(logs.some((m) => m.includes('acquired'))).toBe(true);
  });

  it('never runs fn, and never unlocks, when the wait exceeds maxWaitMs', async () => {
    const { client, calls } = fakeClient([false, false, false, false]);
    let t = 0;
    const fn = vi.fn(async () => 'x');
    await expect(withMigrationLock(client, fn, { sleep: async () => undefined, now: () => (t += 1000), pollMs: 1, maxWaitMs: 2500 })).rejects.toThrow(/timed out/);
    expect(fn).not.toHaveBeenCalled();
    expect(calls.some((c) => c.text.includes('pg_advisory_unlock'))).toBe(false);
  });

  it('a failing unlock does not mask the result (closing the connection releases a session lock)', async () => {
    const { client } = fakeClient([true], new Error('connection lost'));
    const logs: string[] = [];
    await expect(withMigrationLock(client, async () => 'ok', { log: (m) => logs.push(m) })).resolves.toBe('ok');
    expect(logs.join('\n')).toContain('could not release');
  });
});

describe('DDL lock timeout (DB-L2)', () => {
  it('sets lock_timeout=5s as a startup option and leaves statement_timeout alone', () => {
    expect(MIGRATION_SESSION_OPTIONS).toBe('-c lock_timeout=5000');
    expect(MIGRATION_SESSION_OPTIONS).not.toContain('statement_timeout');
  });

  it('turns SQLSTATE 55P03 into an actionable error and passes anything else through', () => {
    const cause = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    const explained = explainMigrationError(cause) as Error;
    expect(explained.name).toBe('MigrationLockTimeoutError');
    expect(explained.message).toContain('lock_timeout');
    expect(explained.message).toContain('re-run');
    expect((explained as Error & { cause?: unknown }).cause).toBe(cause);
    const other = new Error('syntax error');
    expect(explainMigrationError(other)).toBe(other);
  });
});
