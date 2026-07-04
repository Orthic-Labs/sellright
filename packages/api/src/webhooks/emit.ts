/**
 * Webhook outbox. emitEvent() enqueues a delivery row per subscribed endpoint
 * inside the same txn that produced the event (transactional outbox — no event
 * is lost or sent for a rolled-back order). deliverWebhooks() is the scheduler
 * pass that pushes due rows with an HMAC signature + exponential backoff.
 */
import { createHmac } from 'node:crypto';
import { eq, lte, sql } from 'drizzle-orm';
import { pool, withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { safeOutboundFetch } from '../security/outbound-url.js';

/** Enqueue a delivery for every enabled endpoint subscribed to `topic` (or '*'). */
export async function emitEvent(tx: Tx, storeId: string, topic: string, payload: unknown): Promise<void> {
  const endpoints = await tx.select({ id: s.webhookEndpoint.id, topics: s.webhookEndpoint.topics }).from(s.webhookEndpoint).where(eq(s.webhookEndpoint.enabled, true));
  const matched = endpoints.filter((e) => e.topics.includes('*') || e.topics.includes(topic));
  if (!matched.length) return;
  await tx.insert(s.webhookDelivery).values(matched.map((e) => ({ storeId, endpointId: e.id, topic, payload: payload as object })));
}

const BACKOFF_S = [30, 120, 600, 3600, 21600]; // 30s, 2m, 10m, 1h, 6h
const MAX_ATTEMPTS = 6;
const DEFAULT_BATCH_LIMIT = 50;
const MAX_BATCH_LIMIT = 500;

export function normalizeWebhookBatchLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_BATCH_LIMIT;
  return Math.min(MAX_BATCH_LIMIT, Math.max(1, Math.floor(limit!)));
}

type ClaimedDelivery = { id: string; topic: string; payload: unknown; url: string; secret: string; attempts: number };

/**
 * PERF-14: claim a batch of due rows for one store and COMMIT immediately —
 * releasing the pooled connection before any outbound HTTP happens. Mirrors
 * the WP1.7/WP9 FOR UPDATE SKIP LOCKED claim (unchanged), just no longer
 * shares a txn with the fetch below.
 */
async function claimDueWebhooks(storeId: string, limit: number): Promise<ClaimedDelivery[]> {
  return withStore(storeId, async (tx) => {
    // url + secret live on webhook_endpoint (delivery references it via
    // endpoint_id) — join it in the UPDATE…FROM so RETURNING can surface
    // them. (Earlier this RETURNed url/secret straight off webhook_delivery,
    // which has neither column → the query threw at runtime and NO webhook
    // ever delivered; the reaper then recycled every row forever.)
    const claim = await tx.execute(
      sql`UPDATE webhook_delivery wd
          SET status = 'processing', attempts = wd.attempts + 1
          FROM webhook_endpoint we
          WHERE we.id = wd.endpoint_id
            AND wd.id IN (
              SELECT id FROM webhook_delivery
              WHERE status = 'pending' AND next_attempt_at <= now()
              ORDER BY next_attempt_at
              LIMIT ${limit}
              FOR UPDATE SKIP LOCKED
            )
          RETURNING wd.id, wd.topic, wd.payload, we.url, we.secret, wd.attempts`,
    );
    return (claim as unknown as { rows: ClaimedDelivery[] }).rows;
  });
}

/**
 * PERF-14: record the outcome of ONE already-claimed delivery in its own
 * short txn — called AFTER safeOutboundFetch has already returned, so this
 * never holds a connection across the outbound call. Crash-safe: if the
 * process dies between claim and finalize, the row is stuck 'processing' and
 * the webhook-reaper (jobs/webhook-reaper.ts) resets it back to 'pending'
 * after its grace period, same as before this split.
 */
async function finalizeWebhookDelivery(
  storeId: string,
  d: ClaimedDelivery,
  outcome: { ok: true } | { ok: false; error: unknown },
): Promise<'delivered' | 'retry' | 'dead'> {
  return withStore(storeId, async (tx) => {
    if (outcome.ok) {
      await tx.update(s.webhookDelivery).set({ status: 'delivered', deliveredAt: new Date() }).where(eq(s.webhookDelivery.id, d.id));
      return 'delivered';
    }
    // `d.attempts` is the post-claim value (incremented at claim time); use it
    // directly for the give-up decision so BACKOFF progresses.
    const giveUp = d.attempts >= MAX_ATTEMPTS;
    const backoff = BACKOFF_S[Math.min(d.attempts - 1, BACKOFF_S.length - 1)]!;
    await tx.update(s.webhookDelivery).set({
      lastError: String(outcome.error instanceof Error ? outcome.error.message : outcome.error),
      status: giveUp ? 'failed' : 'pending',
      nextAttemptAt: new Date(Date.now() + backoff * 1000),
    }).where(eq(s.webhookDelivery.id, d.id));
    return giveUp ? 'dead' : 'retry';
  });
}

/** Deliver due pending webhooks across all stores (scheduler-driven). */
export async function deliverWebhooks(opts: { limit?: number; log?: (m: string) => void } = {}): Promise<{ delivered: number; failed: number }> {
  const log = opts.log ?? (() => {});
  const limit = normalizeWebhookBatchLimit(opts.limit);
  const stores = await pool.query<{ id: string }>('SELECT id FROM store');
  let delivered = 0;
  let failed = 0;

  for (const st of stores.rows) {
    // PERF-14: claim+release (txn #1, committed inside claimDueWebhooks) —
    // no pooled connection is held past this point.
    const due = await claimDueWebhooks(st.id, limit);

    for (const d of due) {
      const body = JSON.stringify({ id: d.id, topic: d.topic, payload: d.payload });
      const signature = createHmac('sha256', d.secret).update(body).digest('hex');
      // PERF-14: the outbound fetch runs with NO db txn open — a slow or
      // timing-out endpoint (up to the 10s AbortSignal) no longer pins a
      // pooled connection. finalizeWebhookDelivery() below opens its own
      // short txn only after the fetch has already settled.
      let outcome: { ok: true } | { ok: false; error: unknown };
      try {
        const res = await safeOutboundFetch(d.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sr-topic': d.topic, 'x-sr-signature': signature },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        outcome = { ok: true };
      } catch (e) {
        outcome = { ok: false, error: e };
      }

      // txn #2: short, record-only finalize.
      const result = await finalizeWebhookDelivery(st.id, d, outcome);
      if (result === 'delivered') delivered++;
      else if (result === 'dead') failed++;
    }
    if (due.length) log(`[webhooks] ${st.id}: ${due.length} attempted`);
  }
  return { delivered, failed };
}
