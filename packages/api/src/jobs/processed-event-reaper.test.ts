/**
 * DB tests — HARDENING FIX 3: processed_event never had a reaper (one row per
 * Stripe webhook id + one per payment idempotency claim, growing forever).
 * Mirrors release-stale-allocations.test.ts / webhook-reaper conventions:
 * _test-DB guard + TRUNCATE store CASCADE wipe + seed helpers under
 * withStore(). vitest runs files serially (fileParallelism: false).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { reapProcessedEvents } from './processed-event-reaper.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `processed-event-reaper test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`,
  );
}

const STORE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SLUG = 'processed-event-reaper-test-store';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seedStore(): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
  });
}

async function seedProcessedEvent(id: string, ageMinutes: number): Promise<void> {
  const processedAt = new Date(Date.now() - ageMinutes * 60_000).toISOString();
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO processed_event (id, store_id, type, processed_at)
      VALUES (${id}, ${STORE}, 'payment', ${processedAt}::timestamptz)
      ON CONFLICT (id) DO NOTHING`);
  });
}

async function processedEventIds(): Promise<string[]> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM processed_event WHERE store_id = ${STORE} ORDER BY id`);
    return (r.rows as { id: string }[]).map((row) => row.id);
  });
}

describe('reapProcessedEvents (HARDENING FIX 3)', () => {
  beforeEach(async () => {
    await wipe();
    await seedStore();
  });
  afterAll(async () => {
    await wipe();
    await pool.end();
  });

  it('deletes only rows older than the retention window — never rows still within it', async () => {
    await seedProcessedEvent('old-1', 60 * 24 * 40); // 40 days old — past a 30-day retention
    await seedProcessedEvent('old-2', 60 * 24 * 31); // 31 days old — past
    await seedProcessedEvent('recent-1', 60 * 24 * 29); // 29 days old — within
    await seedProcessedEvent('recent-2', 5); // 5 minutes old — well within

    const res = await reapProcessedEvents({ apply: true, retentionDays: 30 });
    expect(res.deleted).toBe(2);

    const remaining = await processedEventIds();
    expect(remaining.sort()).toEqual(['recent-1', 'recent-2']);
  });

  it('dry-run counts but never deletes', async () => {
    await seedProcessedEvent('old-1', 60 * 24 * 40);
    await seedProcessedEvent('recent-1', 5);

    const res = await reapProcessedEvents({ apply: false, retentionDays: 30 });
    expect(res.deleted).toBe(1); // counted, not applied

    const remaining = await processedEventIds();
    expect(remaining.sort()).toEqual(['old-1', 'recent-1']); // nothing actually removed
  });

  it('batches deletes across multiple passes when the backlog exceeds one batch', async () => {
    for (let i = 0; i < 5; i++) await seedProcessedEvent(`old-${i}`, 60 * 24 * 40);
    await seedProcessedEvent('recent-1', 5);

    const res = await reapProcessedEvents({ apply: true, retentionDays: 30, batchLimit: 2 });
    expect(res.deleted).toBe(5); // multiple 2-row batches, still all 5 removed

    const remaining = await processedEventIds();
    expect(remaining).toEqual(['recent-1']);
  });

  it('rejects a non-positive retentionDays', async () => {
    await expect(reapProcessedEvents({ apply: true, retentionDays: 0 })).rejects.toThrow(/retentionDays/);
  });
});
