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
 * serializes ticks; duplicate subscribers are looked up & enrolled with an
 * idempotent list-membership update; and the final UPDATE re-checks `status='confirmed' AND
 * listmonk_synced_at IS NULL`, so a double mark is idempotent. Do not read the
 * SKIP LOCKED as the safety property — if this job ever grows a side effect
 * that is not idempotent, it needs a real claim (see email_outbox's
 * pending→processing flip in 0038).
 *
 * Crash mid-pass: nothing was committed, so the next tick re-claims cleanly. A
 * row that reached Listmonk but crashed before `listmonk_synced_at` was set is
 * retried through the duplicate membership path. `preconfirm_subscriptions` keeps the Listmonk
 * side from sending a confirmation email we already sent.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { pool, withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { safeOutboundFetch } from '../security/outbound-url.js';
import { withRequestDeadline } from '../security/request-deadline.js';
import { normalizeEmail } from '../auth/email.js';

const DEFAULT_BATCH_LIMIT = 200;

/**
 * Paid-order enrollment (DD parity — listmonk.event-handler.ts enrolled
 * customers on OrderPlaced, not just newsletter signups).
 *
 * The durable unit of work is a `kind='order'` subscriber row: inserting it
 * inside the settlement transaction is the entire enqueue — the existing
 * sync pass below claims confirmed+unsynced rows and pushes them to Listmonk
 * with retry. Deduplication is the table's own unique index on
 * (store_id, email, kind, topic): a replayed settlement / second order for
 * the same address is a silent no-op. Every kind uses the store's explicitly
 * configured listId; topic is local segmentation, never a remote list ID.
 *
 * Call-site (payments lane owns paid-effects.ts): inside
 * enqueuePaidEffects(), after recipient resolution —
 *
 *   await enrollOnPaidOrder(tx, storeId, { orderId: order.id, email: recipient, name: order customer name });
 *
 * It never throws: a bad address is logged and skipped, Listmonk
 * unconfiguration just leaves the row unsynced for the next tick.
 */
export async function enrollOnPaidOrder(
  tx: Tx, storeId: string,
  input: { orderId: string; orderCode?: string | null; email: string; name?: string | null },
): Promise<boolean> {
  const email = normalizeEmail(input.email);
  if (!email || !email.includes('@')) return false;
  // Raw SQL for two reasons: `kind='order'` is intentionally outside the
  // drizzle enum ['newsletter','waitlist'] (schema-content.ts is another
  // lane's file — the DB column is plain text, no CHECK), and ON CONFLICT
  // DO NOTHING on the unique index is the dedupe mechanism.
  const r = await tx.execute(sql`
    INSERT INTO subscriber (store_id, email, name, kind, topic, status, confirmed_at, source, meta)
    VALUES (${storeId}, ${email}, ${input.name ?? null}, 'order', '', 'confirmed', now(), 'checkout',
            ${JSON.stringify({ orderId: input.orderId, orderCode: input.orderCode ?? null })}::jsonb)
    ON CONFLICT (store_id, email, kind, topic) DO NOTHING
    RETURNING id`);
  return r.rows.length > 0;
}

interface ListmonkCfg { url: string; apiUser: string; apiToken: string; listId?: number; }

async function getCfg(storeId: string): Promise<ListmonkCfg | null> {
  const [row] = await withStore(storeId, async (tx) =>
    tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1),
  );
  const lm = (row?.config as { listmonk?: ListmonkCfg } | null)?.listmonk;
  return lm?.url && lm?.apiToken ? lm : null;
}

type Claimed = { id: string; email: string; name: string | null; kind: string; topic: string };
type SyncResult = 'synced' | 'unsubscribed' | 'unconfirmed' | 'blocklisted' | 'disabled';
type RemoteSubscriber = {
  id: number; email: string; status: string;
  lists: Array<{ id: number; subscription_status: string }>;
};

function membershipResult(existing: RemoteSubscriber | undefined, c: Claimed, listId: number): SyncResult | undefined {
  if (!existing || !Number.isSafeInteger(existing.id) || existing.id <= 0
    || normalizeEmail(existing.email) !== normalizeEmail(c.email) || !Array.isArray(existing.lists)) {
    throw new Error('duplicate subscriber lookup did not return the requested address & memberships');
  }
  if (existing.status === 'blocklisted' || existing.status === 'disabled') return existing.status;
  if (existing.status !== 'enabled') throw new Error('unknown provider subscriber status');
  const membership = existing.lists.find((list) => list.id === listId);
  if (!membership) return undefined;
  switch (membership.subscription_status) {
    case 'confirmed': return 'synced';
    case 'unsubscribed': return 'unsubscribed';
    case 'unconfirmed': return 'unconfirmed';
    default: throw new Error('unknown provider membership status');
  }
}

async function syncSubscriber(cfg: ListmonkCfg & { listId: number }, c: Claimed, passSignal: AbortSignal): Promise<SyncResult> {
  const auth = Buffer.from(`${cfg.apiUser}:${cfg.apiToken}`).toString('base64');
  const baseUrl = cfg.url.replace(/\/$/, '');
  const request = (path: string, init: RequestInit = {}) => withRequestDeadline(10_000, signal => safeOutboundFetch(`${baseUrl}${path}`, {
    ...init, signal,
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
  }), passSignal);
  const created = await request('/api/subscribers', {
    method: 'POST',
    body: JSON.stringify({
      email: c.email, name: c.name || c.email, status: 'enabled', lists: [cfg.listId],
      // Only locally confirmed rows reach this job; do not send a second opt-in email.
      preconfirm_subscriptions: true,
    }),
  });
  if (created.ok) {
    const result = await created.json() as { data?: RemoteSubscriber };
    const outcome = membershipResult(result.data, c, cfg.listId);
    if (!outcome) throw new Error('provider created subscriber without configured list membership');
    return outcome;
  }
  if (created.status !== 409) throw new Error(`HTTP ${created.status}`);

  // A duplicate address does not prove membership in this store's list.
  // Escape the SQL literal & independently check the returned identity before writing.
  const emailLiteral = c.email.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const query = encodeURIComponent(`subscribers.email = E'${emailLiteral}'`);
  const found = await request(`/api/subscribers?query=${query}&per_page=1`);
  if (!found.ok) throw new Error(`subscriber lookup HTTP ${found.status}`);
  const body = await found.json() as { data?: { results?: RemoteSubscriber[] } };
  const existing = body.data?.results?.[0];
  const current = membershipResult(existing, c, cfg.listId);
  if (current) return current;
  // The query endpoint atomically does ON CONFLICT DO NOTHING. The ordinary
  // ids endpoint overwrites status & could erase an opt-out racing this job.
  const added = await request('/api/subscribers/query/lists', {
    method: 'PUT',
    body: JSON.stringify({
      query: `subscribers.id = ${existing!.id} AND subscribers.status = 'enabled'`,
      action: 'add', target_list_ids: [cfg.listId], status: 'confirmed',
    }),
  });
  if (!added.ok) throw new Error(`list enrollment HTTP ${added.status}`);
  const readback = await request(`/api/subscribers/${existing!.id}`);
  if (!readback.ok) throw new Error(`membership readback HTTP ${readback.status}`);
  const result = await readback.json() as { data?: RemoteSubscriber };
  if (result.data?.id !== existing!.id) throw new Error('membership readback returned another subscriber');
  const outcome = membershipResult(result.data, c, cfg.listId);
  if (!outcome) throw new Error('provider did not enroll subscriber into the configured list');
  return outcome;
}

/**
 * One idempotent pass: claim a batch of confirmed + unsynced rows and push
 * each to Listmonk. Skips entirely when Listmonk is unconfigured (the
 * caller can decide to log a "skipped" line or stay silent — the rows will
 * still be claimable on the next tick once config lands).
 *
 * Returns counts so the scheduler can log a per-store summary. Failures are
 * per-row; one bad email never blocks the rest of the batch.
 */
export async function listmonkSync(opts: { limit?: number; log?: (m: string) => void } = {}): Promise<{ synced: number; suppressed: number; skipped: number; failed: number }> {
  const passDeadline = performance.now() + 60_000;
  return withRequestDeadline(60_000, signal => listmonkSyncPass(opts, signal, passDeadline));
}

// Remaining provider time is shared fairly by remaining stores each pass.
// Each store signal also bounds all of its rows & duplicate requests.
// DB operations are awaited normally; no live work escapes the leader lock.
async function listmonkSyncPass(opts: { limit?: number; log?: (m: string) => void }, signal: AbortSignal, passDeadline: number): Promise<{ synced: number; suppressed: number; skipped: number; failed: number }> {
  const log = opts.log ?? (() => {});
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_BATCH_LIMIT;
  const stores = await pool.query<{ id: string; slug: string }>('SELECT id, slug FROM store');
  let synced = 0;
  let suppressed = 0;
  let skipped = 0;
  let failed = 0;

  for (const [storeIndex, st] of stores.rows.entries()) {
    if (signal.aborted || performance.now() >= passDeadline) { log('[listmonk-sync] provider-work deadline exceeded; remaining rows stay queued'); break; }
    const cfg = await getCfg(st.id);
    if (signal.aborted || performance.now() >= passDeadline) break;
    if (!cfg) { skipped++; continue; }
    const listId = cfg.listId;
    if (!Number.isSafeInteger(listId) || !listId || listId <= 0) {
      skipped++;
      log(`[listmonk-sync] ${st.slug}: skipped: configure a positive listId; subscriber rows remain queued`);
      continue;
    }

    // Locks protect only this transaction; leader-lock serializes outbound work.
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

    const claimedIds: string[] = [];
    let storeSuppressed = 0;
    let storeFailed = 0;

    const storeStartedAt = performance.now();
    const remainingMs = passDeadline - storeStartedAt;
    if (signal.aborted || remainingMs <= 0) break;
    const storeBudgetMs = remainingMs / (stores.rows.length - storeIndex);
    const storeDeadline = storeStartedAt + storeBudgetMs;
    // Await cancellation before marking successes or moving to another store.
    // Unattempted rows remain queued; no store receives a minimum over its share.
    await withRequestDeadline(storeBudgetMs, async (storeSignal) => {
      for (const c of claimed) {
        if (storeSignal.aborted || performance.now() >= storeDeadline) break;
        try {
          const outcome = await syncSubscriber({ ...cfg, listId }, c, storeSignal);
          if (outcome !== 'synced') {
            storeSuppressed++;
            log(`[listmonk-sync] ${st.slug}: subscriber=${c.id} suppressed: preserving provider ${outcome}`);
          }
          claimedIds.push(c.id);
        } catch (e) {
          failed++; storeFailed++;
          // Log the per-row failure but keep the batch going — one bad email
          // must not block the rest. The row stays unsynced and will be
          // re-claimed next tick; if it persistently fails, ops can see it
          // via `SELECT count(*) FROM subscriber WHERE status='confirmed'
          // AND listmonk_synced_at IS NULL`.
          log(`[listmonk-sync] ${st.slug}: failed to sync ${c.email}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }, signal);

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
      synced += claimedIds.length - storeSuppressed;
      suppressed += storeSuppressed;
    }

    if (claimed.length) log(`[listmonk-sync] ${st.slug}: claimed=${claimed.length} synced=${claimedIds.length - storeSuppressed} suppressed=${storeSuppressed} failed=${storeFailed} queued=${claimed.length - claimedIds.length - storeFailed}`);
  }

  log(`[listmonk-sync] done: synced=${synced} suppressed=${suppressed} failed=${failed} skipped=${skipped}`);
  return { synced, suppressed, skipped, failed };
}
