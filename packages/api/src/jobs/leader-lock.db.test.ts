import { afterAll, expect, it } from 'vitest';
import { pool } from '../db/client.js';
import { env } from '../env.js';
import { withLeaderLock } from './leader-lock.js';

if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Leader lock fixture requires a *_test database');
afterAll(() => pool.end());

it('serializes same-store publishers without suppressing another store', async () => {
  await withLeaderLock('catalog-manifest', async () => {
    expect(await withLeaderLock('catalog-manifest', async () => 'duplicate', 'fixture-a')).toBeUndefined();
    expect(await withLeaderLock('catalog-manifest', async () => 'independent', 'fixture-b')).toBe('independent');
  }, 'fixture-a');
  expect(await withLeaderLock('catalog-manifest', async () => 'released', 'fixture-a')).toBe('released');
});

it('preserves global job locking and releases scoped locks after errors', async () => {
  await withLeaderLock('auto-deliver', async () => {
    expect(await withLeaderLock('auto-deliver', async () => 'duplicate')).toBeUndefined();
  });
  await expect(withLeaderLock('catalog-manifest', async () => { throw new Error('fixture failure'); }, 'fixture-a')).rejects.toThrow('fixture failure');
  expect(await withLeaderLock('catalog-manifest', async () => 'released', 'fixture-a')).toBe('released');
});
