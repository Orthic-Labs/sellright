import { describe, expect, it } from 'vitest';
import { afterCommit, beginAfterCommit, discardAfterCommit, flushAfterCommit } from './after-commit.js';

describe('after-commit registry', () => {
  it('runs registered callbacks only on flush (after COMMIT), once', () => {
    const client = {};
    const tx = { $client: client };
    const fn = () => calls.push('wake');
    const calls: string[] = [];
    beginAfterCommit(client);
    afterCommit(tx, fn);
    expect(calls).toEqual([]);
    flushAfterCommit(client);
    flushAfterCommit(client);
    expect(calls).toEqual(['wake']);
  });

  it('drops callbacks on rollback', () => {
    const client = {};
    const calls: string[] = [];
    beginAfterCommit(client);
    afterCommit({ $client: client }, () => calls.push('wake'));
    discardAfterCommit(client);
    flushAfterCommit(client);
    expect(calls).toEqual([]);
  });

  it('is a no-op for a tx not opened by runStoreTransaction', () => {
    const calls: string[] = [];
    afterCommit({ $client: {} }, () => calls.push('wake'));
    expect(calls).toEqual([]);
  });

  it('a throwing callback never escapes flush', () => {
    const client = {};
    const calls: string[] = [];
    beginAfterCommit(client);
    afterCommit({ $client: client }, () => {
      throw new Error('boom');
    });
    afterCommit({ $client: client }, () => calls.push('second'));
    expect(() => flushAfterCommit(client)).not.toThrow();
    expect(calls).toEqual(['second']);
  });
});
