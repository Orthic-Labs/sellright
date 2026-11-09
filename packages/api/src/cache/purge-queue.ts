/**
 * Durable edge-purge queue (API-H1, migration 0123 `edge_purge_pending`).
 *
 * Blog, collection and store-config edits purged Cloudflare through an in-memory retry (runPurge: 3 attempts over a few
 * seconds, then log and give up). A Cloudflare outage or an API restart in that window left the edge serving the old
 * page for its whole s-maxage (3600 s), against ADR-0001's 60 s promise. Catalog changes already had a durable marker
 * (catalog_manifest_pending); this is the same idea for the other triggers:
 *
 *   1. a row is written with the edit — in the SAME transaction when the caller has one (enqueuePurge(tx, ...), then
 *      the immediate attempt runs after COMMIT via afterCommit, so a rolled-back edit leaves no row), otherwise right
 *      after the commit from firePurge (the immediate attempt starts at once; the row is written alongside it);
 *   2. the immediate attempt runs exactly as before (same latency); success deletes the row, 'failed' schedules a retry;
 *   3. the `cache-purge-drain` job retries due rows with backoff until Cloudflare accepts them, and after
 *      PURGE_QUEUE_MAX_ATTEMPTS failed rounds marks the row `dead` and logs the existing `cache_purge_failed` alert.
 *
 * `edge_purge_pending` is global infra like catalog_manifest_pending (no RLS; db/assert-force-rls.ts exempts it): it
 * carries store_id for the drain job, which works across stores outside any store context. It holds URLs only.
 * Nothing here ever throws into a caller: a queue failure degrades to today's in-memory-only behaviour.
 */
import { sql } from 'drizzle-orm';
import { pool } from '../db/client.js';
import { err as logErr, log } from '../lib/logger.js';
import type { PurgeEvent, PurgeResult, PurgeSpec } from './purge-hook.js';

export const PURGE_QUEUE_MAX_ATTEMPTS = 10;
const BACKOFF_BASE_S = 30;
const BACKOFF_CAP_S = 15 * 60;
/** A claimed row is invisible to other drain passes for this long. */
const CLAIM_LEASE_S = 120;
const DEAD_RETENTION_DAYS = 30;
const DRAIN_LIMIT = 20;

/** Seconds until the next retry after `attempts` failed rounds: 30 s, 60 s, 2 min, 4 min, 8 min, then 15 min. */
export function purgeBackoffSeconds(attempts: number): number {
  return Math.min(BACKOFF_CAP_S, BACKOFF_BASE_S * 2 ** Math.max(0, attempts - 1));
}

/** Anything with drizzle's `execute` (a withStore tx or the unscoped db). */
export interface Executor { execute(query: ReturnType<typeof sql>): Promise<unknown> }
type Rows<T> = { rows: T[] };

/** The id of a queued purge (or null when queuing failed / was skipped). */
export type PendingPurge = Promise<string | null> | string | null;

/**
 * Queue a purge. With `tx` the row is part of the caller's transaction (atomic with the edit); without it a short
 * statement on the pool. Never throws: null means "not queued", and the caller still runs the in-memory attempt.
 */
export async function enqueuePurge(tx: Executor | undefined, event: PurgeEvent, storeSlug: string, spec: PurgeSpec): Promise<string | null> {
  try {
    const q = sql`INSERT INTO edge_purge_pending (store_id, store_slug, event, spec)
      SELECT id, ${storeSlug}, ${event}, ${JSON.stringify(spec)}::jsonb FROM store WHERE slug = ${storeSlug}
      RETURNING id`;
    const rows = tx
      ? ((await tx.execute(q)) as Rows<{ id: string }>).rows
      : (await pool.query<{ id: string }>(
        `INSERT INTO edge_purge_pending (store_id, store_slug, event, spec)
         SELECT id, $1, $2, $3::jsonb FROM store WHERE slug = $1 RETURNING id`, [storeSlug, event, JSON.stringify(spec)])).rows;
    return rows[0]?.id ?? null;
  } catch (e) {
    logErr.error('failed to queue durable cache purge (in-memory retry only for this trigger)', e, { event, storeSlug });
    return null;
  }
}

/** Record the immediate attempt's outcome: purged/skipped delete the row, failed schedules the first retry. Never throws. */
export async function settlePurge(pending: PendingPurge, result: PurgeResult): Promise<void> {
  try {
    const id = await pending;
    if (!id) return;
    if (result === 'failed') {
      await pool.query(
        `UPDATE edge_purge_pending SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $2), last_error = 'immediate attempt failed'
         WHERE id = $1 AND status = 'pending'`, [id, purgeBackoffSeconds(1)]);
    } else {
      await pool.query('DELETE FROM edge_purge_pending WHERE id = $1', [id]);
    }
  } catch (e) {
    logErr.error('failed to settle durable cache purge row (the drain job retries it harmlessly)', e);
  }
}

interface DueRow { id: string; store_slug: string; event: PurgeEvent; spec: PurgeSpec; attempts: number }

const validSpec = (s: unknown): s is PurgeSpec =>
  !!s && typeof s === 'object' && (('everything' in s && (s as { everything: unknown }).everything === true) || ('urls' in s && Array.isArray((s as { urls: unknown }).urls)));

/**
 * One drain pass: claim due rows (SKIP LOCKED, oldest first, bounded), retry each once through `run` (runPurge with one
 * attempt), delete on success, back off on failure, go `dead` after PURGE_QUEUE_MAX_ATTEMPTS failed rounds. Also drops
 * dead rows older than 30 days.
 */
export async function drainPendingPurges(
  run: (event: PurgeEvent, storeSlug: string, spec: PurgeSpec) => Promise<PurgeResult>,
  opts: { limit?: number; log?: (m: string) => void } = {},
): Promise<{ purged: number; retried: number; dead: number }> {
  const say = opts.log ?? (() => {});
  const claimed = await pool.query<DueRow>(
    `WITH due AS (
       SELECT id FROM edge_purge_pending WHERE status = 'pending' AND next_attempt_at <= now()
       ORDER BY next_attempt_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE edge_purge_pending e SET next_attempt_at = now() + make_interval(secs => $2)
     FROM due WHERE e.id = due.id
     RETURNING e.id, e.store_slug, e.event, e.spec, e.attempts`, [opts.limit ?? DRAIN_LIMIT, CLAIM_LEASE_S]);
  let purged = 0, retried = 0, dead = 0;
  for (const row of claimed.rows) {
    let result: PurgeResult = 'failed';
    if (validSpec(row.spec)) {
      try { result = await run(row.event, row.store_slug, row.spec); } catch { result = 'failed'; }
    } else {
      logErr.error('edge_purge_pending row has an unreadable spec; dropping it', undefined, { id: row.id, storeSlug: row.store_slug, event: row.event });
      result = 'skipped';
    }
    if (result !== 'failed') {
      await pool.query('DELETE FROM edge_purge_pending WHERE id = $1', [row.id]);
      purged++;
      continue;
    }
    const attempts = row.attempts + 1;
    if (attempts >= PURGE_QUEUE_MAX_ATTEMPTS) {
      await pool.query(`UPDATE edge_purge_pending SET status = 'dead', attempts = $2, last_error = 'gave up' WHERE id = $1`, [row.id, attempts]);
      logErr.error('durable cache purge gave up; the edge may serve stale content until its TTL ends', new Error('purge dead'), {
        alert: 'cache_purge_failed', dead: true, event: row.event, storeSlug: row.store_slug, attempts, id: row.id,
      });
      dead++;
    } else {
      await pool.query(
        `UPDATE edge_purge_pending SET attempts = $2, next_attempt_at = now() + make_interval(secs => $3), last_error = 'retry failed' WHERE id = $1`,
        [row.id, attempts, purgeBackoffSeconds(attempts)]);
      retried++;
    }
  }
  await pool.query(`DELETE FROM edge_purge_pending WHERE status = 'dead' AND created_at < now() - make_interval(days => $1)`, [DEAD_RETENTION_DAYS]);
  if (claimed.rows.length) say(`[jobs:cache-purge-drain] purged=${purged} retried=${retried} dead=${dead}`);
  else log.debug('cache-purge-drain: nothing due');
  return { purged, retried, dead };
}
