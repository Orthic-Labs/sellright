import { beforeEach, describe, expect, it, vi } from 'vitest';

const { poolQuery, errError } = vi.hoisted(() => ({ poolQuery: vi.fn(), errError: vi.fn() }));
vi.mock('../db/client.js', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('../lib/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }, err: { error: (...a: unknown[]) => errError(...a) } }));

import { drainPendingPurges, enqueuePurge, purgeBackoffSeconds, PURGE_QUEUE_MAX_ATTEMPTS, settlePurge } from './purge-queue.js';

beforeEach(() => { poolQuery.mockReset(); errError.mockClear(); });

const sqlOf = (n: number) => String(poolQuery.mock.calls[n]![0]);

describe('purgeBackoffSeconds', () => {
  it('doubles from 30 s and caps at 15 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 9].map(purgeBackoffSeconds)).toEqual([30, 60, 120, 240, 480, 900, 900, 900]);
  });
});

describe('enqueuePurge', () => {
  it('inserts through the transaction when one is given (same transaction as the edit)', async () => {
    const tx = { execute: vi.fn(async () => ({ rows: [{ id: 'row-9' }] })) };
    await expect(enqueuePurge(tx, 'blog-content', 'acme', { urls: ['https://a/'] })).resolves.toBe('row-9');
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('uses the pool without a transaction and never throws (null = not queued)', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'row-1' }] });
    await expect(enqueuePurge(undefined, 'collection', 'acme', { everything: true })).resolves.toBe('row-1');
    poolQuery.mockRejectedValueOnce(new Error('db down'));
    await expect(enqueuePurge(undefined, 'collection', 'acme', { everything: true })).resolves.toBeNull();
    expect(errError).toHaveBeenCalled();
  });
});

describe('settlePurge', () => {
  it('deletes the row when the attempt purged or was skipped, schedules a retry when it failed, ignores an unqueued purge', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await settlePurge(Promise.resolve('r1'), 'purged');
    expect(sqlOf(0)).toMatch(/^DELETE FROM edge_purge_pending/);
    await settlePurge('r2', 'skipped');
    expect(sqlOf(1)).toMatch(/^DELETE FROM edge_purge_pending/);
    await settlePurge('r3', 'failed');
    expect(sqlOf(2)).toMatch(/UPDATE edge_purge_pending SET attempts = attempts \+ 1/);
    expect(poolQuery.mock.calls[2]![1]).toEqual(['r3', 30]);
    poolQuery.mockClear();
    await settlePurge(null, 'failed');
    expect(poolQuery).not.toHaveBeenCalled();
  });
});

describe('drainPendingPurges', () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: 'r1', store_slug: 'acme', event: 'blog-content', spec: { urls: ['https://a/'] }, attempts: 0, ...over });

  it('deletes rows Cloudflare accepted and backs off the ones it did not', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [row({ id: 'ok' }), row({ id: 'bad', attempts: 2 })] }).mockResolvedValue({ rows: [] });
    const run = vi.fn(async (_e: string, _s: string, _spec: unknown): Promise<'purged' | 'failed'> => 'purged').mockResolvedValueOnce('purged').mockResolvedValueOnce('failed');
    const out = await drainPendingPurges(run);
    expect(out).toEqual({ purged: 1, retried: 1, dead: 0 });
    expect(run).toHaveBeenCalledTimes(2);
    const calls = poolQuery.mock.calls.map((c) => [String(c[0]), c[1]] as const);
    expect(calls.find(([q]) => q.startsWith('DELETE FROM edge_purge_pending WHERE id'))![1]).toEqual(['ok']);
    const retry = calls.find(([q]) => q.startsWith('UPDATE edge_purge_pending SET attempts = $2'))!;
    expect(retry[1]).toEqual(['bad', 3, purgeBackoffSeconds(3)]);
  });

  it('marks a row dead after the maximum failed rounds and logs the cache_purge_failed alert', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [row({ attempts: PURGE_QUEUE_MAX_ATTEMPTS - 1 })] }).mockResolvedValue({ rows: [] });
    const out = await drainPendingPurges(async () => 'failed');
    expect(out.dead).toBe(1);
    expect(poolQuery.mock.calls.some((c) => String(c[0]).includes("status = 'dead'") && String(c[0]).startsWith('UPDATE'))).toBe(true);
    expect(errError).toHaveBeenCalledWith(expect.stringContaining('gave up'), expect.anything(), expect.objectContaining({ alert: 'cache_purge_failed', dead: true }));
  });

  it('claims with SKIP LOCKED, oldest first, bounded, and drops an unreadable spec instead of looping on it', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [row({ spec: { nonsense: 1 } })] }).mockResolvedValue({ rows: [] });
    const run = vi.fn();
    const out = await drainPendingPurges(run);
    expect(run).not.toHaveBeenCalled();
    expect(out.purged).toBe(1);
    const claim = sqlOf(0);
    expect(claim).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim).toContain('ORDER BY next_attempt_at, id LIMIT $1');
  });
});
