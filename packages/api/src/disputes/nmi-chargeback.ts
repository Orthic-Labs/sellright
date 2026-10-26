/**
 * NMI chargeback order handling (issue #395; previous-platform parity with
 * damned/admin/src/plugins/nmi-payment/nmi-chargeback-webhook.controller.ts
 * processChargeback, ~116-167):
 *
 *   - fulfilled order   -> NOT cancelled; an order note records it for immediate review
 *   - already Cancelled -> nothing to do
 *   - otherwise         -> order cancelled WITHOUT a refund (the funds already left at NMI),
 *                          stock released, and an order note records why
 *
 * Plus the entitlement reversal Stripe already performs on a chargeback
 * (webhook-reconcile.ts recordStripeDispute), so licences/downloads are revoked on open.
 *
 * Runs on the webhook transaction, under the order's lock set. "Order note" = the
 * order's audit_log trail (SellRight has no separate note table). Called only for
 * the FIRST observation of a dispute (recordDispute created:true), so a provider
 * retry adds nothing.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { withLockedSetInTx } from '../db/locks.js';
import * as s from '../db/schema.js';
import { dispute } from '../db/schema-ops.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import { releaseOrderLoyalty } from '../loyalty/ledger.js';
import { importedFinancialReconciliationRequired } from '../orders/imported-financial-reconciliation.js';
import { release } from '../payments/reservation.js';
import { recordSettlementOperation } from '../payments/settlement/record.js';

export type NmiChargebackOutcome =
  | 'cancelled' | 'not_cancelled_fulfilled' | 'already_cancelled' | 'not_cancelled_state' | 'needs_reconciliation' | 'order_missing';

export async function applyNmiChargebackToOrder(tx: Tx, storeId: string, input: {
  orderId: string; disputeRecordId: string; transactionId: string; reason?: string | null;
}): Promise<{ outcome: NmiChargebackOutcome; stockChanged: boolean }> {
  const actor = 'nmi:webhook';
  const detail = `NMI chargeback received for transaction ${input.transactionId}${input.reason ? ` (${input.reason})` : ''}.`;
  const result = await withLockedSetInTx(tx, storeId, { kind: 'order', orderId: input.orderId }, async (t, held) => {
    const [o] = await t.select().from(s.order)
      .where(and(eq(s.order.id, input.orderId), eq(s.order.storeId, storeId))).limit(1).for('update');
    if (!o) return { outcome: 'order_missing' as NmiChargebackOutcome, stockChanged: false };
    const note = (text: string) => t.insert(s.auditLog).values({
      storeId, actor, entity: 'order', entityId: o.id, action: 'nmi_chargeback_note',
      data: { note: text, transactionId: input.transactionId, disputeRecordId: input.disputeRecordId },
    });

    // Entitlement reversal on open (same operation kind Stripe uses; identity = our dispute row).
    if (!importedFinancialReconciliationRequired(o.metadata)) {
      await recordSettlementOperation(t, {
        storeId, kind: 'dispute_opened', operationId: `nmi_dispute:${input.disputeRecordId}`, orderId: o.id, mutations: [],
        effects: [{ kind: 'entitlement_reversal', payload: { orderId: o.id, reason: 'chargeback' } }], effectMode: 'deferred',
      });
    }

    const [fulfilled] = await t.select({ id: s.fulfillment.id }).from(s.fulfillment)
      .where(and(eq(s.fulfillment.orderId, o.id), sql`${s.fulfillment.state} <> 'Cancelled'`)).limit(1);
    if (fulfilled) {
      await note(`${detail} Order was not cancelled because it has a fulfillment; review immediately.`);
      return { outcome: 'not_cancelled_fulfilled' as NmiChargebackOutcome, stockChanged: false };
    }
    if (o.state === 'Cancelled') return { outcome: 'already_cancelled' as NmiChargebackOutcome, stockChanged: false };
    if (importedFinancialReconciliationRequired(o.metadata)) {
      await note(`${detail} Order was not cancelled: imported financial reconciliation is required first.`);
      return { outcome: 'needs_reconciliation' as NmiChargebackOutcome, stockChanged: false };
    }
    if (!canTransition(o.state as OrderState, 'Cancelled')) {
      await note(`${detail} Order was not cancelled because it is ${o.state}; review.`);
      return { outcome: 'not_cancelled_state' as NmiChargebackOutcome, stockChanged: false };
    }

    // Same stock/line bookkeeping as the admin cancel route; no payment-gateway call (no refund).
    let stockChanged = false;
    const lines = await t.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
    for (const l of lines) {
      const rel = l.quantity - l.fulfilledQty - l.cancelledQty;
      if (rel > 0) {
        await t.update(s.orderLine).set({ cancelledQty: sql`${s.orderLine.cancelledQty} + ${rel}` }).where(eq(s.orderLine.id, l.id));
        if (l.variantId) {
          await t.update(s.stock).set({ allocated: sql`greatest(${s.stock.allocated} - ${rel}, 0)` })
            .where(and(eq(s.stock.variantId, l.variantId), eq(s.stock.storeId, storeId)));
          stockChanged = true;
        }
      }
    }
    await t.update(s.order).set({ state: 'Cancelled', updatedAt: new Date() }).where(eq(s.order.id, o.id));
    await releaseOrderLoyalty(t, storeId, o.id, actor);
    await t.insert(s.auditLog).values({ storeId, actor, entity: 'order', entityId: o.id, action: 'cancel', fromState: o.state, toState: 'Cancelled' });
    await release(t, held, { storeId, orderId: o.id, reason: 'order_cancelled', stripeDiscoverable: false });
    await note(`${detail} Cancelled automatically; no NMI refund was issued.`);
    return { outcome: 'cancelled' as NmiChargebackOutcome, stockChanged };
  });
  await tx.update(dispute).set({
    details: sql`coalesce(${dispute.details}, '{}'::jsonb) || ${JSON.stringify({ orderOutcome: result.outcome })}::jsonb`,
  }).where(eq(dispute.id, input.disputeRecordId));
  return result;
}
