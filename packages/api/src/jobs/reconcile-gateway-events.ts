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
/** No backoff: a failed event is retried on every pass (~1/min), so it reaches manual review after ~30 minutes, the window a
 *  failed payment's order is given before it cancels (Adrian, 2026-10-30). Kept as a function so a cadence change stays one place. */
export function gatewayEventRetryDelayMs(_attempts: number): number {
  return 0;
}

/** Ingress acknowledges only durable storage. This worker performs authoritative reads. */
export async function reconcileGatewayEvents() {
  const stores = await pool.query<{ id: string }>('SELECT id FROM store');
  let processed = 0;
  for (const store of stores.rows) {
    // Every pending event is due each pass (no backoff, see gatewayEventRetryDelayMs). Stable order: longest-waiting first, id
    // as tiebreak, so a stuck event cannot starve the others in the 25-event window.
    const events = await withStore(store.id, tx => tx.select().from(s.gatewayEvent)
      .where(eq(s.gatewayEvent.status, 'pending'))
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
