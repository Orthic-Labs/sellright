import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, runStoreTransaction, type Tx } from './client.js';

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
  });
});
