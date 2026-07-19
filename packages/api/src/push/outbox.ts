/**
 * Push outbox (0039). Deliberately the same shape as ../email/outbox.ts —
 * enqueue in the caller's transaction, deliver from the scheduler with backoff
 * and dead-letter. Read that file first; the only interesting difference here is
 * token cleanup: APNs 410/BadDeviceToken means the device is gone, so the row is
 * marked dead AND the device token is deleted rather than retried into the void.
 */
import { and, eq, sql } from 'drizzle-orm';
import { pool, withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { sendApns, apnsConfigured, type ApnsEnvironment } from './apns.js';
import { env } from '../env.js';
import { log } from '../lib/logger.js';

/** Per-attempt backoff in seconds: 1m, 5m, 30m, 2h, 12h. Mirrors email. */
const BACKOFF_S = [60, 300, 1800, 7200, 43200];
const MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_LIMIT = 50;
const MAX_BATCH_LIMIT = 500;

type ClaimedPush = {
  id: string;
  topic: string;
  device_token: string;
  environment: string;
  payload: unknown;
  attempts: number;
};

export function normalizePushBatchLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_BATCH_LIMIT;
  return Math.min(MAX_BATCH_LIMIT, Math.max(1, Math.floor(limit!)));
}

/** The APNs alert body for an order event. Exported for tests + reuse. */
export function buildOrderPushPayload(args: {
  topic: string;
  code: string;
  grandTotal: number;
  currency: string;
  badge?: number;
}): object {
  const amount = (args.grandTotal / 100).toLocaleString('en-US', { style: 'currency', currency: args.currency });
  const title = args.topic === 'order.paid' ? 'New order' : 'Order placed';
  return {
    aps: {
      alert: { title, body: `${args.code} — ${amount}` },
      sound: 'default',
      // Thread by store so a busy store's alerts group in Notification Center
      // instead of burying everything else on the phone.
      'thread-id': 'orders',
      ...(args.badge != null ? { badge: args.badge } : {}),
    },
    // Consumed by the app to deep-link straight to the order.
    orderCode: args.code,
    topic: args.topic,
  };
}

/**
 * The Live Activity push-to-start payload for a new order. ActivityKit rejects
 * anything whose `attributes` / `content-state` don't match the Swift types
 * exactly (see ios/Shared/OrderActivityAttributes.swift) — silently, from the
 * server's point of view (APNs still returns 200). Keep the two in lockstep.
 */
export function buildOrderLiveActivityPayload(args: {
  code: string;
  grandTotal: number;
  currency: string;
  itemCount: number;
  status?: string;
}): object {
  const now = Math.floor(Date.now() / 1000);
  return {
    aps: {
      timestamp: now,
      event: 'start',
      'content-state': {
        status: args.status ?? 'Paid',
        grandTotal: args.grandTotal,
        itemCount: args.itemCount,
        trackingCode: null,
      },
      'attributes-type': 'OrderActivityAttributes',
      attributes: { orderCode: args.code, currency: args.currency },
      // Shown if the device can't render the activity (older iOS, activities
      // disabled) — the operator still learns an order landed.
      alert: {
        title: 'New order',
        body: `${args.code} — ${(args.grandTotal / 100).toLocaleString('en-US', { style: 'currency', currency: args.currency })}`,
      },
      // Stop pinning it to the lock screen after 8h even if nothing ends it.
      'dismissal-date': now + 8 * 3600,
    },
    orderCode: args.code,
  };
}

/**
 * Fan an event out to every device registered for this store + topic, enqueuing
 * one outbox row per device inside the caller's txn. No-ops (no rows) when
 * nobody is registered — the common case for a store with no mobile operators.
 *
 * `kind` selects which token family to address: 'apns' for the alert, or
 * 'live_activity' for the push-to-start token. They're different tokens with
 * different APNs topics, so a caller that wants both enqueues twice.
 */
export async function enqueuePush(tx: Tx, storeId: string, args: {
  topic: string;
  payload: object;
  kind?: 'apns' | 'live_activity';
}): Promise<number> {
  const kind = args.kind ?? 'apns';
  const devices = await tx
    .select({
      token: s.adminDeviceToken.token,
      environment: s.adminDeviceToken.environment,
      topics: s.adminDeviceToken.topics,
      kind: s.adminDeviceToken.kind,
    })
    .from(s.adminDeviceToken)
    .where(eq(s.adminDeviceToken.kind, kind));
  const matched = devices.filter((d) => d.topics.includes('*') || d.topics.includes(args.topic));
  if (!matched.length) return 0;

  await tx.insert(s.pushOutbox).values(matched.map((d) => ({
    storeId,
    // Encode the token family in the outbox topic so the sender knows which
    // APNs push-type/topic to use without re-reading the device table.
    topic: kind === 'live_activity' ? `${args.topic}#live` : args.topic,
    deviceToken: d.token,
    environment: d.environment,
    payload: args.payload,
  })));
  return matched.length;
}

async function claimDuePushes(storeId: string, limit: number): Promise<ClaimedPush[]> {
  return withStore(storeId, async (tx) => {
    const claim = await tx.execute(
      sql`UPDATE push_outbox po
          SET status = 'processing', attempts = po.attempts + 1, updated_at = now()
          WHERE po.id IN (
            SELECT id FROM push_outbox
            WHERE (status = 'pending' AND next_attempt_at <= now())
               OR (status = 'processing' AND updated_at < now() - interval '10 minutes')
            ORDER BY next_attempt_at
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING po.id, po.topic, po.device_token, po.environment, po.payload, po.attempts`,
    );
    return (claim as unknown as { rows: ClaimedPush[] }).rows;
  });
}

type PushOutcome =
  | { kind: 'sent' }
  | { kind: 'unregistered'; error: string }
  | { kind: 'failed'; error: unknown };

async function finalizePush(
  storeId: string,
  delivery: ClaimedPush,
  outcome: PushOutcome,
): Promise<{ result: 'sent' | 'retry' | 'dead' | 'stale'; pruned: number }> {
  return withStore(storeId, async (tx) => {
    const currentAttempt = and(
      eq(s.pushOutbox.id, delivery.id),
      eq(s.pushOutbox.status, 'processing'),
      eq(s.pushOutbox.attempts, delivery.attempts),
    );
    if (outcome.kind === 'sent') {
      const rows = await tx
        .update(s.pushOutbox)
        .set({ status: 'sent', sentAt: new Date(), updatedAt: new Date(), lastError: null })
        .where(currentAttempt)
        .returning({ id: s.pushOutbox.id });
      return { result: rows.length ? 'sent' : 'stale', pruned: 0 };
    }

    if (outcome.kind === 'unregistered') {
      const rows = await tx
        .update(s.pushOutbox)
        .set({ status: 'dead', lastError: outcome.error, updatedAt: new Date() })
        .where(currentAttempt)
        .returning({ id: s.pushOutbox.id });
      if (!rows.length) return { result: 'stale', pruned: 0 };
      const removed = await tx
        .delete(s.adminDeviceToken)
        .where(eq(s.adminDeviceToken.token, delivery.device_token))
        .returning({ id: s.adminDeviceToken.id });
      return { result: 'dead', pruned: removed.length };
    }

    const giveUp = delivery.attempts >= MAX_ATTEMPTS;
    const backoff = BACKOFF_S[Math.min(delivery.attempts - 1, BACKOFF_S.length - 1)]!;
    const rows = await tx
      .update(s.pushOutbox)
      .set({
        lastError: String(outcome.error instanceof Error ? outcome.error.message : outcome.error),
        status: giveUp ? 'dead' : 'pending',
        nextAttemptAt: new Date(Date.now() + backoff * 1000),
        updatedAt: new Date(),
      })
      .where(currentAttempt)
      .returning({ id: s.pushOutbox.id });
    if (!rows.length) return { result: 'stale', pruned: 0 };
    return { result: giveUp ? 'dead' : 'retry', pruned: 0 };
  });
}

/** Deliver due pending pushes across all stores (scheduler-driven). */
export async function deliverPushes(opts: { limit?: number } = {}): Promise<{ sent: number; failed: number; pruned: number }> {
  let sent = 0;
  let failed = 0;
  let pruned = 0;

  // Not configured = not an error. The outbox keeps filling; when the APNs key
  // is finally set the queued alerts drain (subject to their own backoff).
  if (!apnsConfigured()) return { sent, failed, pruned };

  const limit = normalizePushBatchLimit(opts.limit);
  const stores = await pool.query<{ id: string }>('SELECT id FROM store');

  for (const st of stores.rows) {
    const due = await claimDuePushes(st.id, limit);
    for (const d of due) {
      let outcome: PushOutcome;
      try {
        const isLive = d.topic.endsWith('#live');
        const res = await sendApns({
          deviceToken: d.device_token,
          environment: d.environment as ApnsEnvironment,
          payload: d.payload,
          ...(isLive
            ? {
                pushType: 'liveactivity' as const,
                topic: `${env.APNS_BUNDLE_ID}.push-type.liveactivity`,
              }
            : {}),
        });
        if (res.ok) outcome = { kind: 'sent' };
        else if (res.unregistered) {
          outcome = {
            kind: 'unregistered',
            error: `unregistered (${res.status} ${res.reason ?? ''})`.trim(),
          };
        } else {
          outcome = { kind: 'failed', error: new Error(`apns ${res.status} ${res.reason ?? ''}`.trim()) };
        }
      } catch (error) {
        outcome = { kind: 'failed', error };
      }
      const finalized = await finalizePush(st.id, d, outcome);
      if (finalized.result === 'sent') sent++;
      else if (finalized.result === 'retry' || finalized.result === 'dead') failed++;
      pruned += finalized.pruned;
    }
  }

  if (sent || failed || pruned) log.info('push outbox pass', { sent, failed, pruned });
  return { sent, failed, pruned };
}
