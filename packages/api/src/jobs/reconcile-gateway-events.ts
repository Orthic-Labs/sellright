import { asc, eq } from 'drizzle-orm';
import { pool, withAdvisoryLock, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { verifySezzleAttempt } from '../payments/gateway-payment.js';
import { reconcileSezzleRefunds, resolveSezzleSessionAttempt } from '../payments/sezzle-reconcile.js';

/** Ingress acknowledges only durable storage. This worker performs authoritative reads. */
export async function reconcileGatewayEvents() {
  const stores = await pool.query<{ id: string }>('SELECT id FROM store');
  let processed = 0;
  for (const store of stores.rows) {
    const events = await withStore(store.id, tx => tx.select().from(s.gatewayEvent)
      .where(eq(s.gatewayEvent.status, 'pending')).orderBy(asc(s.gatewayEvent.updatedAt)).limit(25));
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
        if (status === 'pending' && current.attempts >= 29) status = 'manual';
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
