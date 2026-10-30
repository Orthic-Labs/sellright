import { and, asc, eq, sql } from 'drizzle-orm';
import { pool, withAdvisoryLock, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { verifySezzleAttempt } from '../payments/gateway-payment.js';
import { observeImportedSezzlePayment, reconcileSezzleRefunds, resolveSezzleSessionAttempt } from '../payments/sezzle-reconcile.js';

/**
 * D9 (perf plan P6). `attempts` counts processing attempts already made. The
 * attempt that would make it MANUAL_AFTER_ATTEMPTS (the 30th) and still leaves
 * the event pending moves it to visible manual review instead.
 */
export const MANUAL_AFTER_ATTEMPTS = 30;
const EVENT_BATCH_LIMIT = 25;
/** Retry backoff after `attempts` failed passes: 1, 2, 4, 8 then every 15 minutes. */
export function gatewayEventRetryDelayMs(attempts: number): number {
  return attempts <= 0 ? 0 : Math.min(60_000 * 2 ** (attempts - 1), 15 * 60_000);
}

/** Ingress acknowledges only durable storage. This worker performs authoritative reads. */
export async function reconcileGatewayEvents() {
  const stores = await pool.query<{ id: string }>('SELECT id FROM store');
  let processed = 0;
  for (const store of stores.rows) {
    // Due filter BEFORE the limit (D9): a failed event waits out its backoff
    // (updated_at is stamped on every attempt) instead of being re-verified
    // against the provider every minute; fresh events (attempts = 0) are due at
    // once. Stable order: longest-waiting first, id as tiebreak.
    const events = await withStore(store.id, tx => tx.select().from(s.gatewayEvent)
      .where(and(eq(s.gatewayEvent.status, 'pending'),
        sql`${s.gatewayEvent.updatedAt} <= now() - least(
          case when ${s.gatewayEvent.attempts} <= 0 then 0 else 60 * power(2, least(${s.gatewayEvent.attempts}, 10) - 1) end,
          900) * interval '1 second'`))
      .orderBy(asc(s.gatewayEvent.updatedAt), asc(s.gatewayEvent.id)).limit(EVENT_BATCH_LIMIT));
    for (const event of events) {
      await withAdvisoryLock('gateway-event:' + event.id, async () => {
        let status = 'pending';
        let lastError: string | null = null;
        const [current] = await withStore(store.id, tx => tx.select().from(s.gatewayEvent)
          .where(eq(s.gatewayEvent.id, event.id)).limit(1));
        if (!current || current.status !== 'pending') return;
        let attempt: Awaited<ReturnType<typeof resolveSezzleSessionAttempt>> = null;
        const ref = { storeId: store.id, accountId: event.accountId, mode: event.mode, providerRef: event.providerRef };
        try {
          // D15: exact providerRef first, then the provider's reference_id
          // (== attempt id) so a lost session response still associates.
          if (event.method === 'sezzle' && !event.eventType.startsWith('dispute.') && event.eventType !== 'order.refunded') {
            attempt = await resolveSezzleSessionAttempt(ref);
          }
          if (event.method === 'sezzle' && event.eventType === 'order.refunded') {
            // D16: provider-side refunds reconcile into the refund ledger
            // (Stripe T15 parity) instead of parking for an operator.
            const r = await reconcileSezzleRefunds(ref);
            if (r.ambiguous) lastError = 'Ambiguous refund reservations — bind the refund reference explicitly';
            else status = 'processed';
          } else if (!attempt && event.method === 'sezzle' && ['order.authorized', 'order.captured'].includes(event.eventType)) {
            // Historical imports already contain settled money & have no
            // attempt. A proven association acknowledges observation only.
            const imported = await observeImportedSezzlePayment(ref);
            if (imported) status = 'processed';
            else lastError = 'Payment association pending';
          } else if (!attempt) lastError = 'Payment association pending';
          else if (event.method === 'sezzle' && ['order.authorized', 'order.captured'].includes(event.eventType)) {
            const result = await verifySezzleAttempt(store.id, attempt.id);
            if (event.eventType === 'order.captured' ? result.status === 'settled'
              : ['pending', 'settled'].includes(result.status)) status = 'processed';
            else lastError = 'Provider ledger has not reconciled';
          } else {
            status = 'manual';
            lastError = 'Review external refund, dispute or unsupported provider event';
          }
        } catch { lastError = 'Provider verification unavailable'; }
        // A still-ambiguous refund is operator work, not a retry loop.
        if (lastError?.startsWith('Ambiguous')) status = 'manual';
        // Keep the durable work visible after repeated failures; operators can
        // retry it. Never silently drop an event when a provider stops retries.
        if (status === 'pending' && current.attempts + 1 >= MANUAL_AFTER_ATTEMPTS) status = 'manual';
        await withStore(store.id, async tx => {
          await tx.update(s.gatewayEvent).set({
            status, lastError, attempts: current.attempts + 1, updatedAt: new Date(),
          }).where(eq(s.gatewayEvent.id, event.id));
          if (status === 'manual') await tx.insert(s.auditLog).values({
            storeId: store.id, actor: 'system:gateway', entity: 'gateway_event', entityId: event.id,
            action: 'reconciliation_required',
            data: { method: event.method, eventType: event.eventType, providerRef: event.providerRef, orderId: attempt?.orderId },
          });
        });
        if (status === 'processed') processed++;
      });
    }
  }
  return { processed };
}
