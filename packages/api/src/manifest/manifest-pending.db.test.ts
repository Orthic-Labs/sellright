/**
 * DB tests for the durable-retry marker table (SELLRIGHT-ISSUES P1 —
 * "Cross-process catalog triggers can be skipped without durable retry").
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../db/client.js';
import { env } from '../env.js';
import { markManifestRegenerationPending, clearManifestRegenerationPending, loadStalePendingManifestRegenerations } from './manifest-pending.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`manifest-pending test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

async function wipe() {
  await pool.query('TRUNCATE catalog_manifest_pending');
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await pool.end();
});

describe('catalog manifest durable-retry marker', () => {
  it('marks pending, then clears it once the regeneration succeeds', async () => {
    const storeId = '11111111-1111-4111-8111-111111111111';
    const token = await markManifestRegenerationPending(storeId, 'store-a');
    let stale = await loadStalePendingManifestRegenerations(0);
    expect(stale.some((p) => p.storeId === storeId)).toBe(true);

    await clearManifestRegenerationPending(storeId, token!.token);
    stale = await loadStalePendingManifestRegenerations(0);
    expect(stale.some((p) => p.storeId === storeId)).toBe(false);
  });

  it('an older successful publish cannot acknowledge a newer trigger, even one microsecond later', async () => {
    const storeId = '44444444-4444-4444-8444-444444444444';
    const oldToken = await markManifestRegenerationPending(storeId, 'store-race');
    // Force the collision that a millisecond-resolution JS Date cannot represent.
    await pool.query(`UPDATE catalog_manifest_pending SET requested_at = $2::timestamptz + interval '1 microsecond' WHERE store_id = $1`, [storeId, oldToken!.token]);
    await clearManifestRegenerationPending(storeId, oldToken!.token);
    const [pending] = (await loadStalePendingManifestRegenerations(0)).filter(p => p.storeId === storeId);
    expect(pending).toBeDefined();
    expect(pending!.token).not.toBe(oldToken!.token);
    await clearManifestRegenerationPending(storeId, pending!.token);
    expect((await loadStalePendingManifestRegenerations(0)).some(p => p.storeId === storeId)).toBe(false);
  });

  it('tokens advance strictly even when an existing requested_at is ahead of the database clock', async () => {
    const storeId = '55555555-5555-4555-8555-555555555555';
    await markManifestRegenerationPending(storeId, 'store-clock');
    await pool.query(`UPDATE catalog_manifest_pending SET requested_at = clock_timestamp() + interval '1 day' WHERE store_id = $1`, [storeId]);
    const first = await markManifestRegenerationPending(storeId, 'store-clock');
    const second = await markManifestRegenerationPending(storeId, 'store-clock');
    expect(first!.token).not.toBe(second!.token);
    await clearManifestRegenerationPending(storeId, first!.token);
    expect((await pool.query('SELECT count(*)::int AS n FROM catalog_manifest_pending WHERE store_id = $1', [storeId])).rows[0].n).toBe(1);
    await clearManifestRegenerationPending(storeId, second!.token);
    expect((await pool.query('SELECT count(*)::int AS n FROM catalog_manifest_pending WHERE store_id = $1', [storeId])).rows[0].n).toBe(0);
  });

  it('requires full coverage when another outstanding trigger may have a different scope', async () => {
    const storeId = '66666666-6666-4666-8666-666666666666';
    const first = await markManifestRegenerationPending(storeId, 'store-scopes');
    expect(first!.requiresFull).toBe(false);
    const second = await markManifestRegenerationPending(storeId, 'store-scopes');
    expect(second!.requiresFull).toBe(true);
    await clearManifestRegenerationPending(storeId, first!.token);
    expect((await loadStalePendingManifestRegenerations(0)).some(p => p.storeId === storeId)).toBe(true);
    await clearManifestRegenerationPending(storeId, second!.token);
    const fresh = await markManifestRegenerationPending(storeId, 'store-scopes');
    expect(fresh!.requiresFull).toBe(false);
  });

  it('is an upsert — repeated marks for the same store do not create duplicate rows', async () => {
    const storeId = '22222222-2222-4222-8222-222222222222';
    await markManifestRegenerationPending(storeId, 'store-b');
    await markManifestRegenerationPending(storeId, 'store-b');
    await markManifestRegenerationPending(storeId, 'store-b');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM catalog_manifest_pending WHERE store_id = $1', [storeId]);
    expect(rows[0].n).toBe(1);
  });

  it('only surfaces rows older than the given staleness threshold', async () => {
    const storeId = '33333333-3333-4333-8333-333333333333';
    await markManifestRegenerationPending(storeId, 'store-c');
    // Freshly marked — not yet "stale" under any positive threshold.
    const notYetStale = await loadStalePendingManifestRegenerations(60_000);
    expect(notYetStale.some((p) => p.storeId === storeId)).toBe(false);
    // A threshold of 0ms treats it as immediately stale (proves the query
    // itself, without needing a real sleep in the test).
    const immediatelyStale = await loadStalePendingManifestRegenerations(0);
    expect(immediatelyStale.some((p) => p.storeId === storeId)).toBe(true);
  });

  it('never throws even if the underlying write fails (best-effort bookkeeping)', async () => {
    // An invalid UUID would normally throw from Postgres — mark/clear must
    // swallow it (logged, not thrown), since this is fire-and-forget
    // bookkeeping on the stock-hook path and must never break the caller.
    await expect(markManifestRegenerationPending('not-a-uuid', 'store-d')).resolves.toBeNull();
    await expect(clearManifestRegenerationPending('not-a-uuid', '2000-01-01')).resolves.toBeUndefined();
  });
});
