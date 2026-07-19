/**
 * SUBSCRIBER-1 (docs/plans/2026-07-19-subscriber-newsletter-waitlist.md).
 *
 * Background sync job: claims confirmed + unsynced subscriber rows and pushes
 * them to the store's configured Listmonk instance. Mirrors the email/webhook
 * outbox pattern (REL-4 / WP1.7) — the signup request path persists locally,
 * the scheduler owns the outbound push with retry. Pending addresses NEVER
 * reach the mailing list: the claim filter is `status='confirmed'`.
 *
 * The Listmonk URL is admin-supplied config (not hardcoded), so the fetch
 * MUST go through `safeOutboundFetch` — the same SSRF guard admin-marketing.ts
 * uses. When Listmonk is unconfigured, the sync is skipped entirely; rows
 * simply stay `listmonk_synced_at = NULL` and nothing is lost, which is the
 * fix for the previous inline-Listmonk path that silently dropped addresses.
 *
 * Concurrency: the claim below uses FOR UPDATE SKIP LOCKED, but that lock is
 * released when the claim transaction commits — it does NOT span the outbound
 * fetches, and this job deliberately does no `processing` status flip, so
 * there is no durable claim. Two concurrent passes would therefore both POST
 * the same rows. What actually makes that safe is threefold: the leader-lock
 * serializes ticks; Listmonk returns 409 on a duplicate, which we treat as
 * success; and the final UPDATE re-checks `status='confirmed' AND
 * listmonk_synced_at IS NULL`, so a double mark is idempotent. Do not read the
 * SKIP LOCKED as the safety property — if this job ever grows a side effect
 * that is not idempotent, it needs a real claim (see email_outbox's
 * pending→processing flip in 0038).
 *
 * Crash mid-pass: nothing was committed, so the next tick re-claims cleanly. A
 * row that reached Listmonk but crashed before `listmonk_synced_at` was set is
 * retried and 409s into success. `preconfirm_subscriptions` keeps the Listmonk
 * side from sending a confirmation email we already sent.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { safeOutboundFetch } from '../security/outbound-url.js';

const DEFAULT_BATCH_LIMIT = 200;

interface ListmonkCfg { url: string; apiUser: string; apiToken: string; }

async function getCfg(storeId: string): Promise<ListmonkCfg | null> {
  const [row] = await withStore(storeId, async (tx) =>
    tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1),
  );
  const lm = (row?.config as { listmonk?: ListmonkCfg } | null)?.listmonk;
  return lm?.url && lm?.apiToken ? lm : null;
}

type Claimed = { id: string; email: string; name: string | null; kind: string; topic: string };

/**
 * One idempotent pass: claim a batch of confirmed + unsynced rows and push
 * each to Listmonk. Skips entirely when Listmonk is unconfigured (the
 * caller can decide to log a "skipped" line or stay silent — the rows will
 * still be claimable on the next tick once config lands).
 *
 * Returns counts so the scheduler can log a per-store summary. Failures are
 * per-row; one bad email never blocks the rest of the batch.
 */
export async function listmonkSync(opts: { limit?: number; log?: (m: string) => void } = {}): Promise<{ synced: number; skipped: number; failed: number }> {
  const log = opts.log ?? (() => {});
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_BATCH_LIMIT;
  const stores = await pool.query<{ id: string; slug: string }>('SELECT id, slug FROM store');
  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (const st of stores.rows) {
    const cfg = await getCfg(st.id);
    if (!cfg) { skipped++; continue; }

    // Claim a batch of confirmed + unsynced rows. SKIP LOCKED so a manual
    // run that bypasses the leader-lock still doesn't double-process.
    const claimed = await withStore(st.id, async (tx): Promise<Claimed[]> => {
      const r = await tx.execute(
        sql`SELECT id, email, name, kind, topic
            FROM subscriber
            WHERE status = 'confirmed' AND listmonk_synced_at IS NULL
            ORDER BY created_at
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED`,
      );
      return r.rows as Claimed[];
    });

    if (!claimed.length) continue;

    const auth = Buffer.from(`${cfg.apiUser}:${cfg.apiToken}`).toString('base64');
    const baseUrl = cfg.url.replace(/\/$/, '');
    const claimedIds: string[] = [];

    for (const c of claimed) {
      try {
        const res = await safeOutboundFetch(`${baseUrl}/api/subscribers`, {
          method: 'POST',
          headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            email: c.email,
            name: c.name || c.email,
            // SUBSCRIBER-1: preconfirm_subscriptions=true so Listmonk doesn't
            // send ITS own confirmation — we already sent ours via the email
            // outbox, and the row is only here after confirmed_at IS NOT NULL.
            status: 'enabled',
            preconfirm_subscriptions: true,
          }),
        });
        // 200/201 = created, 409 = already exists (idempotent re-sync — treat
        // as success so we mark synced_at and stop retrying forever).
        if (!res.ok && res.status !== 409) {
          throw new Error(`HTTP ${res.status}`);
        }
        claimedIds.push(c.id);
      } catch (e) {
        failed++;
        // Log the per-row failure but keep the batch going — one bad email
        // must not block the rest. The row stays unsynced and will be
        // re-claimed next tick; if it persistently fails, ops can see it
        // via `SELECT count(*) FROM subscriber WHERE status='confirmed'
        // AND listmonk_synced_at IS NULL`.
        log(`[listmonk-sync] ${st.slug}: failed to sync ${c.email}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Single batched UPDATE for the successes — one round-trip, one txn. The
    // predicate is re-checked here (status still confirmed, still unsynced) so
    // this is idempotent even if a concurrent pass already marked these rows;
    // the row locks from the claim are long gone by now (see file header).
    if (claimedIds.length) {
      await withStore(st.id, async (tx) => {
        await tx.update(s.subscriber)
          .set({ listmonkSyncedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(s.subscriber.status, 'confirmed'), isNull(s.subscriber.listmonkSyncedAt), sql`id IN ${claimedIds}`));
      });
      synced += claimedIds.length;
    }

    if (claimed.length) log(`[listmonk-sync] ${st.slug}: claimed=${claimed.length} synced=${claimedIds.length} failed=${claimed.length - claimedIds.length}`);
  }

  log(`[listmonk-sync] done: synced=${synced} failed=${failed} skipped=${skipped}`);
  return { synced, skipped, failed };
}
