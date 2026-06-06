/**
 * Webhook outbox. emitEvent() enqueues a delivery row per subscribed endpoint
 * inside the same txn that produced the event (transactional outbox — no event
 * is lost or sent for a rolled-back order). deliverWebhooks() is the scheduler
 * pass that pushes due rows with an HMAC signature + exponential backoff.
 */
import { createHmac } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';
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
      const due = await tx
        .select({ id: s.webhookDelivery.id, topic: s.webhookDelivery.topic, payload: s.webhookDelivery.payload, attempts: s.webhookDelivery.attempts, url: s.webhookEndpoint.url, secret: s.webhookEndpoint.secret })
        .from(s.webhookDelivery)
        .innerJoin(s.webhookEndpoint, eq(s.webhookEndpoint.id, s.webhookDelivery.endpointId))
        .where(and(eq(s.webhookDelivery.status, 'pending'), lte(s.webhookDelivery.nextAttemptAt, new Date())))
        .limit(limit);

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
          const attempts = d.attempts + 1;
          const giveUp = attempts >= MAX_ATTEMPTS;
          const backoff = BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)]!;
          await tx.update(s.webhookDelivery).set({ attempts, lastError: String(e instanceof Error ? e.message : e), status: giveUp ? 'failed' : 'pending', nextAttemptAt: new Date(Date.now() + backoff * 1000) }).where(eq(s.webhookDelivery.id, d.id));
          if (giveUp) failed++;
        }
      }
      if (due.length) log(`[webhooks] ${st.id}: ${due.length} attempted`);
    });
  }
  return { delivered, failed };
}
