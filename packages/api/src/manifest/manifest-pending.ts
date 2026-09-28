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
export async function markManifestRegenerationPending(storeId: string, storeSlug: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO catalog_manifest_pending (store_id, store_slug, requested_at) VALUES ($1, $2, now())
       ON CONFLICT (store_id) DO UPDATE SET requested_at = now()`,
      [storeId, storeSlug],
    );
  } catch (e) {
    logErr.error('failed to mark catalog manifest regeneration pending (durable retry degraded for this trigger)', e, { storeSlug });
  }
}

/** Clear the pending marker — call ONLY after a regeneration has actually
 *  succeeded (publishCatalogManifest resolved without throwing). */
export async function clearManifestRegenerationPending(storeId: string): Promise<void> {
  try {
    await pool.query(`DELETE FROM catalog_manifest_pending WHERE store_id = $1`, [storeId]);
  } catch (e) {
    logErr.error('failed to clear catalog manifest regeneration pending marker (drain job will retry it harmlessly)', e, { storeId });
  }
}

export interface StalePending { storeId: string; storeSlug: string; requestedAt: Date; }

/** Pending rows older than `staleMs` — old enough that whatever in-process
 *  attempt was behind them must have failed (a healthy run clears its own
 *  row in well under this window). The drain job republishes each one. */
export async function loadStalePendingManifestRegenerations(staleMs: number): Promise<StalePending[]> {
  const { rows } = await pool.query<{ store_id: string; store_slug: string; requested_at: Date }>(
    `SELECT store_id, store_slug, requested_at FROM catalog_manifest_pending WHERE requested_at < now() - ($1 || ' milliseconds')::interval`,
    [staleMs],
  );
  return rows.map((r) => ({ storeId: r.store_id, storeSlug: r.store_slug, requestedAt: r.requested_at }));
}
