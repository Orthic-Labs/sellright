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

/** Enqueue a delivery for every enabled endpoint subscribed to `topic` (or '*'). */
export async function emitEvent(tx: Tx, storeId: string, topic: string, payload: unknown): Promise<void> {
  const endpoints = await tx.select({ id: s.webhookEndpoint.id, topics: s.webhookEndpoint.topics }).from(s.webhookEndpoint).where(eq(s.webhookEndpoint.enabled, true));
  const matched = endpoints.filter((e) => e.topics.includes('*') || e.topics.includes(topic));
  if (!matched.length) return;
  await tx.insert(s.webhookDelivery).values(matched.map((e) => ({ storeId, endpointId: e.id, topic, payload: payload as object })));
}

const BACKOFF_S = [30, 120, 600, 3600, 21600]; // 30s, 2m, 10m, 1h, 6h
const MAX_ATTEMPTS = 6;

/** Deliver due pending webhooks across all stores (scheduler-driven). */
export async function deliverWebhooks(opts: { limit?: number; log?: (m: string) => void } = {}): Promise<{ delivered: number; failed: number }> {
  const log = opts.log ?? (() => {});
  const limit = opts.limit ?? 50;
  const stores = await pool.query<{ id: string }>('SELECT id FROM store');
  let delivered = 0;
  let failed = 0;

  for (const st of stores.rows) {
    await withStore(st.id, async (tx) => {
      // WP1.7 / WP9 (perf): claim a batch of due rows under FOR UPDATE SKIP
      // LOCKED so concurrent scheduler passes (e.g. multi-instance deploys)
      // don't double-deliver the same row. The claim is held for the duration
      // of this txn, then marked status='processing' (so a crash mid-delivery
      // leaves a recoverable row — reaper resets stuck 'processing' rows).
      const claim = await tx.execute(
        sql`UPDATE webhook_delivery
            SET status = 'processing', attempts = attempts + 1
            WHERE id IN (
              SELECT id FROM webhook_delivery
              WHERE status = 'pending' AND next_attempt_at <= now()
              ORDER BY next_attempt_at
              LIMIT ${sql.raw(String(limit))}
              FOR UPDATE SKIP LOCKED
            )
            RETURNING id, topic, payload, url, secret, attempts`,
      );
      const due = (claim as unknown as { rows: Array<{ id: string; topic: string; payload: unknown; url: string; secret: string; attempts: number }> }).rows;

      for (const d of due) {
        const body = JSON.stringify({ id: d.id, topic: d.topic, payload: d.payload });
        const signature = createHmac('sha256', d.secret).update(body).digest('hex');
        try {
          const res = await fetch(d.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-sr-topic': d.topic, 'x-sr-signature': signature },
            body,
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await tx.update(s.webhookDelivery).set({ status: 'delivered', deliveredAt: new Date() }).where(eq(s.webhookDelivery.id, d.id));
          delivered++;
        } catch (e) {
          // `d.attempts` is the post-claim value (incremented at claim time);
          // use it directly for the give-up decision so BACKOFF progresses.
          const giveUp = d.attempts >= MAX_ATTEMPTS;
          const backoff = BACKOFF_S[Math.min(d.attempts - 1, BACKOFF_S.length - 1)]!;
          await tx.update(s.webhookDelivery).set({ lastError: String(e instanceof Error ? e.message : e), status: giveUp ? 'failed' : 'pending', nextAttemptAt: new Date(Date.now() + backoff * 1000) }).where(eq(s.webhookDelivery.id, d.id));
          if (giveUp) failed++;
        }
      }
      if (due.length) log(`[webhooks] ${st.id}: ${due.length} attempted`);
    });
  }
  return { delivered, failed };
}
