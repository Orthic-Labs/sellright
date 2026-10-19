import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, runStoreTransaction, type Tx } from './client.js';
import { afterCommit } from './after-commit.js';

afterAll(async () => {
  await pool.end();
});

describe('runStoreTransaction', () => {
  it('preserves the original error and evicts the client when rollback fails', async () => {
    const original = new Error('query connection lost');
    const query = vi.fn(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('socket closed during rollback');
      return { rows: [] };
    });
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;

    await expect(
      runStoreTransaction(
        client,
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        async () => { throw original; },
        () => ({}) as Tx,
      ),
    ).rejects.toBe(original);

    expect(release).toHaveBeenCalledWith(true);
  });

  it('commits and recycles a healthy client', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;

    const result = await runStoreTransaction(
      client,
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      async () => 'ok',
      () => ({}) as Tx,
    );

    expect(result).toBe('ok');
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      "SELECT set_config('app.current_store', $1, true)",
      'COMMIT',
    ]);
    expect(release).toHaveBeenCalledWith(false);
    expect(release).toHaveBeenCalledTimes(1);
  });
});


describe('bounded store transactions', () => {
  it('closes active SQL, awaits physical close, discards hooks & releases once without rollback', async () => {
    vi.useFakeTimers();
    try {
      let finishClose!: () => void;
      let rejectQuery!: (error: Error) => void;
      const closed = new Promise<void>((resolve) => { finishClose = resolve; });
      const active = new Promise<never>((_resolve, reject) => { rejectQuery = reject; });
      const query = vi.fn(async (text: string) => text === 'SLOW SQL' ? active : { rows: [] });
      const end = vi.fn(() => { rejectQuery(new Error('Connection terminated')); return closed; });
      const release = vi.fn();
      const hook = vi.fn();
      const client = { query, end, release } as unknown as PoolClient;
      const work = runStoreTransaction(client, 'store-a', async (tx) => {
        afterCommit(tx, hook);
        await client.query('SLOW SQL');
        await client.query('LATE SQL');
      }, () => ({ $client: client }) as Tx, { timeoutMs: 2_000 });
      const result = expect(work).rejects.toThrow('timed out after 2000ms');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(end).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      expect(hook).not.toHaveBeenCalled();
      finishClose();
      await result;
      expect(query.mock.calls.map(([text]) => text)).toEqual([
        'BEGIN', "SELECT set_config('app.current_store', $1, true)", 'SLOW SQL',
      ]);
      expect(release).toHaveBeenCalledExactlyOnceWith(true);
    } finally { vi.useRealTimers(); }
  });

  it('prevents late COMMIT when a callback settles after its timeout', async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const waiting = new Promise<void>((resolve) => { finish = resolve; });
      const query = vi.fn(async (_text: string) => ({ rows: [] }));
      const release = vi.fn();
      const end = vi.fn(async () => undefined);
      const client = { query, end, release } as unknown as PoolClient;
      const work = runStoreTransaction(client, 'store-a', () => waiting, () => ({}) as Tx, { timeoutMs: 2_000 });
      const result = expect(work).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(2_000);
      await result;
      finish();
      await Promise.resolve();
      await Promise.resolve();
      expect(query.mock.calls.map(([text]) => text)).not.toContain('COMMIT');
      expect(query.mock.calls.map(([text]) => text)).not.toContain('ROLLBACK');
      expect(release).toHaveBeenCalledExactlyOnceWith(true);
    } finally { vi.useRealTimers(); }
  });

  it('preserves default commit hooks, rollback error & single release', async () => {
    const hook = vi.fn();
    const release = vi.fn();
    const query = vi.fn(async (_text: string) => ({ rows: [] }));
    const end = vi.fn();
    const client = { query, end, release } as unknown as PoolClient;
    await runStoreTransaction(client, 'store-a', async (tx) => { afterCommit(tx, hook); }, () => ({ $client: client }) as Tx);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(end).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
    query.mockClear(); release.mockClear(); hook.mockClear();
    const original = new Error('callback failed');
    await expect(runStoreTransaction(client, 'store-a', async (tx) => {
      afterCommit(tx, hook); throw original;
    }, () => ({ $client: client }) as Tx)).rejects.toBe(original);
    expect(query.mock.calls.map(([text]) => text)).toContain('ROLLBACK');
    expect(hook).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
});
