// withLockedSet restart backstop (X-45): a deadlock_detected (40P01) or serialization_failure (40001) raised while
// the locked transaction runs restarts the whole transaction, bounded by maxRestarts. The transaction layer is faked:
// the simulated failure is raised at commit of the locked run (after the user fn ran), never during planning.
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ failures: 0, code: '40P01', userRuns: 0 }));

vi.mock('./client.js', () => {
  const query: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'for', 'orderBy']) query[m] = () => query;
  query.then = (res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) => Promise.resolve([]).then(res, rej);
  const fakeTx = {
    select: () => query,
    execute: async () => ({ rows: [] }),
  };
  return {
    withStore: async (_storeId: string, fn: (tx: unknown) => Promise<unknown>) => {
      const out = await fn(fakeTx);
      if (state.failures > 0 && state.userRuns > 0) {
        state.failures--;
        throw Object.assign(new Error('Failed query: deadlock'), { code: state.code });
      }
      return out;
    },
  };
});

import { isDeadlockOrSerializationFailure, withLockedSet } from './locks.js';

describe('withLockedSet deadlock/serialization restart', () => {
  it('classifies 40P01 and 40001, including driver wrappers, and nothing else', () => {
    expect(isDeadlockOrSerializationFailure(Object.assign(new Error('x'), { code: '40P01' }))).toBe(true);
    expect(isDeadlockOrSerializationFailure(Object.assign(new Error('x'), { code: '40001' }))).toBe(true);
    expect(isDeadlockOrSerializationFailure(Object.assign(new Error('wrap'), { cause: { code: '40P01' } }))).toBe(true);
    expect(isDeadlockOrSerializationFailure(Object.assign(new Error('x'), { code: '55P03' }))).toBe(false);
    expect(isDeadlockOrSerializationFailure(new Error('plain'))).toBe(false);
    // an outer wrapper with its own (non-Postgres) code must not hide the driver error underneath
    expect(isDeadlockOrSerializationFailure(Object.assign(new Error('http'), { code: 'INTERNAL', cause: { code: '40P01' } }))).toBe(true);
  });

  it('restarts the transaction after a transient deadlock and returns the successful run', async () => {
    state.failures = 2;
    state.code = '40P01';
    state.userRuns = 0;
    const fn = vi.fn(async () => { state.userRuns++; return 'ok'; });
    await expect(withLockedSet('store-1', { kind: 'order', orderId: '00000000-0000-0000-0000-000000000001' }, fn))
      .resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('restarts on serialization_failure (40001) as well', async () => {
    state.failures = 1;
    state.code = '40001';
    state.userRuns = 0;
    const fn = vi.fn(async () => { state.userRuns++; return 'ok'; });
    await expect(withLockedSet('store-1', { kind: 'order', orderId: '00000000-0000-0000-0000-000000000002' }, fn, { mustCommit: true }))
      .resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRestarts transient failures and surfaces the deadlock error', async () => {
    state.failures = 100;
    state.code = '40P01';
    state.userRuns = 0;
    const fn = vi.fn(async () => { state.userRuns++; return 'never'; });
    await expect(withLockedSet('store-1', { kind: 'order', orderId: '00000000-0000-0000-0000-000000000003' }, fn, { mustCommit: true, maxRestarts: 2 }))
      .rejects.toThrow('deadlock');
    // one run, then maxRestarts (2) restarts, then the error is thrown
    expect(fn).toHaveBeenCalledTimes(3);
    state.failures = 0;
  });
});
