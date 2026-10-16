import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../env.js';

const state = vi.hoisted(() => ({ connects: 0, acquisitions: [] as string[], releases: [] as boolean[] }));
vi.mock('pg', async importOriginal => ({
  ...await importOriginal<typeof import('pg')>(),
  Pool: class {
    private busy = false;
    private waiters: Array<() => void> = [];
    on() {}
    async end() {}
    async connect() {
      state.connects++;
      if (this.busy) await new Promise<void>(resolve => this.waiters.push(resolve));
      this.busy = true;
      return {
        query: async (query: string, values: string[]) => {
          if (query.includes('pg_advisory_lock(')) state.acquisitions.push(values[0]!);
          return { rows: [] };
        },
        release: (broken: boolean) => {
          state.releases.push(broken);
          const next = this.waiters.shift();
          if (next) next();
          else this.busy = false;
        },
      };
    }
  },
}));
import { _resetPoolsForTest, closePools, initPools, withAdvisoryLock, withAdvisoryLocks, type HeldAdvisoryLocks } from './client.js';

afterEach(async () => {
  await closePools();
  _resetPoolsForTest();
  state.connects = 0; state.acquisitions = []; state.releases = [];
});

describe('explicit advisory lock sets', () => {
  it('completes concurrent pay/refund workflows on a capacity-one pool without nested borrowing', async () => {
    initPools({ ...env, PGPOOL_MAX: 1 });
    await Promise.all([1, 2, 3].map(i => withAdvisoryLocks([`refund:${i}`, `pay:${i}`, `pay:${i}`], held =>
      withAdvisoryLock(`refund:${i}`, async () => 'refunded', held))));
    expect(state.connects).toBe(3);
    expect(state.acquisitions).toEqual(['pay:1', 'refund:1', 'pay:2', 'refund:2', 'pay:3', 'refund:3']);
    expect(state.releases).toEqual([false, false, false]);
  });

  it('rejects forged, uncovered & expired tokens without borrowing or running protected work', async () => {
    initPools({ ...env, PGPOOL_MAX: 1 });
    const work = vi.fn(async () => 'unsafe');
    let expired!: HeldAdvisoryLocks;
    await withAdvisoryLocks(['pay:1'], async held => {
      expired = held;
      await expect(withAdvisoryLock('refund:1', work, held)).rejects.toThrow('does not cover');
    });
    await expect(withAdvisoryLock('pay:1', work, expired)).rejects.toThrow('does not cover');
    await expect(withAdvisoryLock('pay:1', work, {} as HeldAdvisoryLocks)).rejects.toThrow('does not cover');
    expect(work).not.toHaveBeenCalled();
    expect(state.connects).toBe(1);
  });

  it('rejects same-token siblings before they can enter the protected operation', async () => {
    initPools({ ...env, PGPOOL_MAX: 1 });
    const entered: string[] = [];
    await withAdvisoryLocks(['pay:1', 'refund:1'], async held => {
      const first = withAdvisoryLock('refund:1', async () => { entered.push('first'); await Promise.resolve(); }, held);
      const second = withAdvisoryLock('refund:1', async () => { entered.push('second'); }, held);
      const results = await Promise.allSettled([first, second]);
      expect(results[0]!.status).toBe('fulfilled');
      expect(results[1]!.status).toBe('rejected');
      expect((results[1] as PromiseRejectedResult).reason.message).toContain('already used');
    });
    expect(entered).toEqual(['first']);
    expect(state.connects).toBe(1);
  });

  it('retains locks until accepted unawaited work settles & expires the token at callback return', async () => {
    initPools({ ...env, PGPOOL_MAX: 1 });
    let complete!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { complete = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let token!: HeldAdvisoryLocks;
    let ownerDone = false;
    let workDone = false;
    const owner = withAdvisoryLocks(['refund:1'], async held => {
      token = held;
      void withAdvisoryLock('refund:1', async () => { entered(); await gate; workDone = true; }, held);
    }).then(() => { ownerDone = true; });
    await started;
    await Promise.resolve();
    expect(ownerDone).toBe(false);
    expect(state.releases).toEqual([]);
    await expect(withAdvisoryLock('refund:1', async () => {}, token)).rejects.toThrow('does not cover');
    complete();
    await owner;
    expect(workDone).toBe(true);
    expect(ownerDone).toBe(true);
    expect(state.releases).toEqual([false]);
  });

  it('sibling work without an explicit token stays serialized until its owner releases', async () => {
    initPools({ ...env, PGPOOL_MAX: 1 });
    let sibling!: Promise<void>;
    let ran = false;
    await withAdvisoryLocks(['pay:1'], async () => {
      sibling = withAdvisoryLock('pay:1', async () => { ran = true; });
      await Promise.resolve();
      expect(ran).toBe(false);
    });
    await sibling;
    expect(ran).toBe(true);
    expect(state.connects).toBe(2);
  });
});
