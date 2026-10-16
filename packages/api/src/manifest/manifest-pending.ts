/**
 * Durable retry for cross-process catalog manifest regeneration (migration
 * 0079, SELLRIGHT-ISSUES P1). See catalog_manifest_pending's own migration
 * comment for the full rationale: manifest/stock-hook.ts's in-memory
 * trailing-rerun state only survives one process's lifetime, so a crash (or
 * a lock handoff) between "stock changed" and "manifest republished" can
 * silently drop the regeneration. This table is the durable trace of a
 * regeneration being owed; jobs/scheduler.ts's catalog-manifest-drain pass
 * republishes (full regen — always safe) anything stale enough to prove the
 * in-process attempt behind it never finished.
 */
import { pool } from '../db/client.js';
import { err as logErr } from '../lib/logger.js';

/** Mark a regeneration as owed for this store. Upsert — safe to call on
 *  every stock change, not just the first in a batch (idempotent, just
 *  resets the age). Best-effort: a failure here is logged, never thrown —
 *  the caller is on the fire-and-forget stock-hook path and must not have
 *  its response latency or correctness depend on this bookkeeping write. */
export interface PendingManifestToken { token: string; requiresFull: boolean }
export async function markManifestRegenerationPending(storeId: string, storeSlug: string): Promise<PendingManifestToken | null> {
  try {
    // Claiming an empty marker proves this is the only outstanding scope. If
    // another trigger already marked work, its scope is unknown across processes:
    // the next successful publisher must cover the full catalog before ack.
    const inserted = await pool.query<{ token: string }>(
      `INSERT INTO catalog_manifest_pending (store_id, store_slug, requested_at) VALUES ($1, $2, clock_timestamp())
       ON CONFLICT (store_id) DO NOTHING RETURNING requested_at::text AS token`,
      [storeId, storeSlug],
    );
    if (inserted.rows[0]) return { token: inserted.rows[0].token, requiresFull: false };
    // The previous publisher may clear between these statements. Upsert
    // recreates the marker in that case; full coverage remains the safe default.
    const { rows } = await pool.query<{ token: string }>(
      `INSERT INTO catalog_manifest_pending (store_id, store_slug, requested_at) VALUES ($1, $2, clock_timestamp())
       ON CONFLICT (store_id) DO UPDATE
       SET requested_at = GREATEST(clock_timestamp(), catalog_manifest_pending.requested_at + interval '1 microsecond'), store_slug = EXCLUDED.store_slug
       RETURNING requested_at::text AS token`,
      [storeId, storeSlug],
    );
    return { token: rows[0]!.token, requiresFull: true };
  } catch (e) {
    logErr.error('failed to mark catalog manifest regeneration pending (durable retry degraded for this trigger)', e, { storeSlug });
    return null;
  }
}

/** Acknowledge only the exact database timestamp covered by this publish.
 *  Keep its text form: JavaScript Date would truncate Postgres microseconds.
 *  Clear the pending marker — call ONLY after a regeneration has actually
 *  succeeded (publishCatalogManifest resolved without throwing). */
export async function clearManifestRegenerationPending(storeId: string, token: string): Promise<void> {
  try {
    await pool.query(`DELETE FROM catalog_manifest_pending WHERE store_id = $1 AND requested_at = $2::timestamptz`, [storeId, token]);
  } catch (e) {
    logErr.error('failed to clear catalog manifest regeneration pending marker (drain job will retry it harmlessly)', e, { storeId });
  }
}

export interface StalePending { storeId: string; storeSlug: string; requestedAt: Date; token: string; }

/** Pending rows older than `staleMs` — old enough that whatever in-process
 *  attempt was behind them must have failed (a healthy run clears its own
 *  row in well under this window). The drain job republishes each one. */
export async function loadStalePendingManifestRegenerations(staleMs: number): Promise<StalePending[]> {
  const { rows } = await pool.query<{ store_id: string; store_slug: string; requested_at: Date; token: string }>(
    `SELECT store_id, store_slug, requested_at, requested_at::text AS token FROM catalog_manifest_pending WHERE requested_at < now() - ($1 || ' milliseconds')::interval`,
    [staleMs],
  );
  return rows.map((r) => ({ storeId: r.store_id, storeSlug: r.store_slug, requestedAt: r.requested_at, token: r.token }));
}
