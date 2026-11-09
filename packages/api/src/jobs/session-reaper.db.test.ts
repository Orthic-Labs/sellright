/**
 * DB tests — DB-M1: expired sessions are deleted 7 days after expires_at (and legacy rows past legacy_expires_at);
 * valid and recently expired rows survive. Same harness as processed-event-reaper.test.ts.
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { reapSessions } from './session-reaper.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'session-reaper.db.test.ts');

const STORE = 'dddddddd-dddd-dddd-dddd-ddddddddd001';
const DAY = 24 * 3_600_000;

async function seed(hash: string, expiresDaysFromNow: number, legacyDaysFromNow: number | null = null): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO session (store_id, token_hash, expires_at, legacy_expires_at)
      VALUES (${STORE}, ${hash}, ${new Date(Date.now() + expiresDaysFromNow * DAY).toISOString()}::timestamptz,
        ${legacyDaysFromNow === null ? null : new Date(Date.now() + legacyDaysFromNow * DAY).toISOString()}::timestamptz)`);
  });
}
const hashes = () => withStore(STORE, async (tx) => (await tx.execute(sql`SELECT token_hash FROM session ORDER BY token_hash`)).rows.map((r) => (r as { token_hash: string }).token_hash));

describe('reapSessions (DB-M1)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE store CASCADE');
    await withStore(STORE, async (tx) => { await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, 'session-reaper-test', 'x')`); });
  });
  afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); await pool.end(); });

  it('deletes rows expired more than 7 days ago and keeps valid and recently expired ones', async () => {
    await seed('old', -8);
    await seed('recent', -6);
    await seed('valid', 5);
    const r = await reapSessions({ apply: true });
    expect(r.deleted).toBe(1);
    expect(await hashes()).toEqual(['recent', 'valid']);
  });

  it('deletes legacy rows past legacy_expires_at even when expires_at is still ahead', async () => {
    await seed('legacy-dead', 30, -1);
    await seed('legacy-live', 30, 2);
    await reapSessions({ apply: true });
    expect(await hashes()).toEqual(['legacy-live']);
  });

  it('works in batches, oldest first', async () => {
    for (let i = 0; i < 5; i++) await seed(`old-${i}`, -10 - i);
    const r = await reapSessions({ apply: true, batchLimit: 2 });
    expect(r.deleted).toBe(5);
    expect(await hashes()).toEqual([]);
  });

  it('dry-run counts but deletes nothing', async () => {
    await seed('old', -8);
    expect((await reapSessions({ apply: false })).deleted).toBe(1);
    expect(await hashes()).toEqual(['old']);
  });
});
