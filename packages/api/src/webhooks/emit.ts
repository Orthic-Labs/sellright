/**
 * Webhook outbox. emitEvent() enqueues a delivery row per subscribed endpoint
 * inside the same txn that produced the event (transactional outbox — no event
 * is lost or sent for a rolled-back order). deliverWebhooks() is the scheduler
 * pass that pushes due rows with an HMAC signature + exponential backoff.
 */
import { createHmac } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import { Client, Pool, type ClientConfig, type PoolConfig, type QueryConfig } from 'pg';
import { currentLeaseSignal, runStoreTransaction, type Tx } from '../db/client.js';
import { getEnv } from '../env.js';
import * as s from '../db/schema.js';
import { safeOutboundFetch } from '../security/outbound-url.js';
import { CANARY_MARKER, CANARY_TOPIC, assertNotReserved, assertNotReservedTopic } from '../canary/marker.js';

/** Enqueue a delivery for every enabled endpoint subscribed to `topic` (or '*').
 *  The reserved `health.canary` topic is never fanned out here: `'*'`
 *  subscribers must never receive canary traffic (PLAN 7.16). */
export async function emitEvent(tx: Tx, storeId: string, topic: string, payload: unknown): Promise<void> {
  assertNotReservedTopic(`webhook topic ${topic}`, topic, false);
  assertNotReserved(`webhook topic ${topic}`, payload, false);
  const endpoints = await tx.select({ id: s.webhookEndpoint.id, topics: s.webhookEndpoint.topics }).from(s.webhookEndpoint).where(and(eq(s.webhookEndpoint.storeId, storeId), eq(s.webhookEndpoint.enabled, true)));
  const matched = endpoints.filter((e) => e.topics.includes('*') || e.topics.includes(topic));
  if (!matched.length) return;
  await tx.insert(s.webhookDelivery).values(matched.map((e) => ({ storeId, endpointId: e.id, topic, payload: payload as object })));
}

/** Canary-only delivery: exactly one endpoint, addressed by id, never fan-out.
 *  The endpoint must belong to this store and be subscribed to `health.canary`.
 *  Payload carries the reserved marker. Called only by canary/health-canary.ts. */
export async function emitCanaryWebhook(tx: Tx, storeId: string, endpointId: string, payload: Record<string, unknown>): Promise<string> {
  const [ep] = await tx.select({ id: s.webhookEndpoint.id, topics: s.webhookEndpoint.topics })
    .from(s.webhookEndpoint)
    .where(and(eq(s.webhookEndpoint.id, endpointId), eq(s.webhookEndpoint.storeId, storeId), eq(s.webhookEndpoint.enabled, true)))
    .limit(1);
  if (!ep || !ep.topics.includes(CANARY_TOPIC)) throw new Error('canary webhook endpoint missing or not subscribed to health.canary');
  const [row] = await tx.insert(s.webhookDelivery).values({
    storeId, endpointId: ep.id, topic: CANARY_TOPIC,
    payload: { ...payload, canary: true, marker: CANARY_MARKER } as object,
  }).returning({ id: s.webhookDelivery.id });
  return row!.id;
}

const BACKOFF_S = [30, 120, 600, 3600, 21600]; // 30s, 2m, 10m, 1h, 6h
const MAX_ATTEMPTS = 6;
const DEFAULT_BATCH_LIMIT = 50;
const MAX_BATCH_LIMIT = 500;
const ADMISSION_WINDOW_MS = 40_000;
const TRANSACTION_TIMEOUT_MS = 2_000;

export function normalizeWebhookBatchLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_BATCH_LIMIT;
  return Math.min(MAX_BATCH_LIMIT, Math.max(1, Math.floor(limit!)));
}

type ClaimedDelivery = { id: string; topic: string; payload: unknown; url: string; secret: string; attempts: number };

/**
 * Claim one due row for one store and COMMIT immediately —
 * releasing the pooled connection before any outbound HTTP happens. Mirrors
 * the WP1.7/WP9 FOR UPDATE SKIP LOCKED claim (unchanged), just no longer
 * shares a txn with the fetch below.
 */
type StoreTransaction = <T>(storeId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;

async function claimDueWebhooks(storeTransaction: StoreTransaction, storeId: string, cutoff: string, deadline: number): Promise<ClaimedDelivery[]> {
  return storeTransaction(storeId, async (tx) => {
    // Connecting/BEGIN may consume the remaining admission window.
    if (performance.now() >= deadline) return [];
    // url + secret live on webhook_endpoint (delivery references it via
    // endpoint_id) — join it in the UPDATE…FROM so RETURNING can surface
    // them. (Earlier this RETURNed url/secret straight off webhook_delivery,
    // which has neither column → the query threw at runtime and NO webhook
    // ever delivered; the reaper then recycled every row forever.)
    const claim = await tx.execute(
      sql`UPDATE webhook_delivery wd
          SET status = 'processing', attempts = wd.attempts + 1, claimed_at = now(), updated_at = now()
          FROM webhook_endpoint we
          WHERE we.id = wd.endpoint_id
            AND wd.store_id = ${storeId}
            AND we.store_id = ${storeId}
            AND wd.id IN (
              SELECT id FROM webhook_delivery
              WHERE store_id = ${storeId}
                AND status = 'pending' AND next_attempt_at <= ${cutoff}::timestamptz
              ORDER BY next_attempt_at, id
              LIMIT 1
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
  storeTransaction: StoreTransaction,
  storeId: string,
  d: ClaimedDelivery,
  outcome: { ok: true } | { ok: false; error: unknown },
): Promise<'delivered' | 'retry' | 'dead'> {
  return storeTransaction(storeId, async (tx) => {
    if (outcome.ok) {
      await tx.update(s.webhookDelivery).set({ status: 'delivered', deliveredAt: new Date(), claimedAt: null, updatedAt: new Date() }).where(and(eq(s.webhookDelivery.storeId, storeId), eq(s.webhookDelivery.id, d.id)));
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
      // De-fork 2.9: release the claim; stamp the first failure once.
      claimedAt: null,
      firstFailedAt: sql`coalesce(${s.webhookDelivery.firstFailedAt}, now())`,
      updatedAt: new Date(),
    }).where(and(eq(s.webhookDelivery.storeId, storeId), eq(s.webhookDelivery.id, d.id)));
    return giveUp ? 'dead' : 'retry';
  });
}

/** Deliver due pending webhooks across all stores (scheduler-driven).
 * Two FIFO workers hold at most one attempt per store, through finalization.
 * Admission stops after 40s; accepted work & physical connection cleanup drain
 * before returning to the scheduler's unchanged global leader-lock owner. */
export async function deliverWebhooks(opts: { limit?: number; log?: (m: string) => void } = {}): Promise<{ delivered: number; failed: number }> {
  const deadline = performance.now() + ADMISSION_WINDOW_MS;
  const log = opts.log ?? (() => {});
  const limit = normalizeWebhookBatchLimit(opts.limit);
  const failures: unknown[] = [];
  const closedClients: Promise<void>[] = [];
  const observeClientError = (error: Error) => {
    failures.push(error);
    console.error('[pg webhook client error]', error);
  };
  // pg-pool can remove an errored client before its socket closes (including
  // failed enumeration/connect). Track every constructed client's end event,
  // not just pool.end(), so leader ownership covers those closes as well.
  class DeliveryClient extends Client {
    constructor(config?: ClientConfig) {
      super(config);
      closedClients.push(new Promise<void>((resolve) => { this.once('end', resolve); }));
      this.on('error', observeClientError);
    }
  }
  const env = getEnv();
  const deliveryPool = new Pool({
    connectionString: env.DATABASE_URL,
    application_name: `${env.PGAPPNAME}-webhooks`,
    max: 2,
    connectionTimeoutMillis: 1_000,
    statement_timeout: 1_000,
    lock_timeout: 250,
    pipeline: false,
    Client: DeliveryClient,
  } as PoolConfig & { Client: typeof Client; pipeline: boolean });
  deliveryPool.on('error', (error) => {
    failures.push(error);
    console.error('[pg webhook pool error]', error);
  });
  const storeTransaction: StoreTransaction = async (storeId, fn) => {
    const client = await deliveryPool.connect();
    return runStoreTransaction(client, storeId, fn, undefined, { timeoutMs: TRANSACTION_TIMEOUT_MS });
  };
  let delivered = 0;
  let failed = 0;
  try {
    // One DB statement supplies both deterministic process-independent rotation
    // & a frozen due cutoff. Failed rows cannot age back into this pass at 30s.
    // pg supports query_timeout natively; its separate declaration omits it.
    const enumeration: QueryConfig & { query_timeout: number } = {
      text: `SELECT id, statement_timestamp()::text AS cutoff,
                    floor(extract(epoch FROM statement_timestamp()) / 60)::integer AS "minuteOrdinal"
             FROM store ORDER BY id`,
      query_timeout: 1_500,
    };
    const stores = await deliveryPool.query<{ id: string; cutoff: string; minuteOrdinal: number }>(enumeration);
    const count = stores.rows.length;
    const offset = count ? stores.rows[0]!.minuteOrdinal % count : 0;
    const queue = [...stores.rows.slice(offset), ...stores.rows.slice(0, offset)]
      .map((store) => ({ ...store, attempted: 0 }));
    const leaseSignal = currentLeaseSignal(); // #360 L2: a lost lease stops admission of further stores
    const worker = async () => {
      while (performance.now() < deadline && !leaseSignal?.aborted) {
        // Shift before awaiting: active stores are absent from the shared FIFO.
        const store = queue.shift();
        if (!store) return;
        try {
          const [d] = await claimDueWebhooks(storeTransaction, store.id, store.cutoff, deadline);
          if (!d) continue;
          store.attempted++;
          const body = JSON.stringify({ id: d.id, topic: d.topic, payload: d.payload });
          const signature = createHmac('sha256', d.secret).update(body).digest('hex');
          // No DB connection is held during existing secured outbound I/O.
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
          } catch (error) {
            outcome = { ok: false, error };
          }
          const result = await finalizeWebhookDelivery(storeTransaction, store.id, d, outcome);
          if (result === 'delivered') delivered++;
          else if (result === 'dead') failed++;
          log(`[webhooks] ${store.id}: ${store.attempted} attempted`);
          if (store.attempted < limit) queue.push(store);
        } catch (error) {
          // Remove this store for this pass; unrelated stores keep their turns.
          failures.push(error);
        }
      }
    };
    const workers = await Promise.allSettled([worker(), worker()]);
    for (const result of workers) if (result.status === 'rejected') failures.push(result.reason);
  } catch (error) {
    failures.push(error);
  } finally {
    const cleanup = await Promise.allSettled([deliveryPool.end(), ...closedClients]);
    for (const result of cleanup) if (result.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length) throw new AggregateError(failures, 'Webhook delivery pass failed');
  return { delivered, failed };
}
