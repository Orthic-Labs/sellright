/**
 * Permanent order purge (cascade), shared by the admin bulk purge
 * (routes/admin-order-ops.ts) and the cancelled-order expiry job
 * (jobs/purge-cancelled-orders.ts). Both run it inside the order's lock set
 * (withLockedSet {kind:'order'}) with the order row locked FOR UPDATE.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import type { HeldLocks } from '../db/locks.js';
import * as s from '../db/schema.js';
import { dispute } from '../db/schema-ops.js';
import { hasUnresolvedPayment } from '../payments/hold.js';
import { purgeBlockedByReservations, purgeReservations } from '../payments/reservation.js';
import { recordSettlementOperation } from '../payments/settlement/record.js';
import { importedFinancialReconciliationRequired, ImportedFinancialReconciliationError } from './imported-financial-reconciliation.js';

export type PurgeErrorCode = 'ACCOUNT_CREDIT_HOLD_UNRESOLVED' | 'IMPORTED_FINANCIAL_RECONCILIATION_REQUIRED';
type PurgeOrder = { id: string; code: string; state: string; metadata: unknown };

export const isPaidPurgeState = (state: string) => state === 'Paid' || state === 'PartiallyRefunded' || state === 'Refunded';

/** Why this order may not be purged (null = it may). Read-only; call it under the order's lock set before purgeOrderInSet. */
export async function purgeRefusal(
  tx: Tx, storeId: string, o: PurgeOrder, opts: { stripeDiscoverable: boolean; force: boolean; reason?: string | null },
): Promise<{ error: string; errorCode?: PurgeErrorCode } | null> {
  if (importedFinancialReconciliationRequired(o.metadata)) {
    const refusal = new ImportedFinancialReconciliationError();
    return { error: refusal.message, errorCode: refusal.code };
  }
  if (await hasUnresolvedPayment(tx, o.id)) return { error: 'Resolve the pending payment before purging' };
  if (await purgeBlockedByReservations(tx, storeId, o.id, { stripeDiscoverable: opts.stripeDiscoverable })) return { error: 'Resolve the pending payment before purging' };
  // Credit reserve/redeem/release also lock this order first. Inspect the
  // live hold here, before any write, so each bulk item stays atomic & a
  // force purge cannot orphan credit reserved against a deleted order.
  const [creditHold] = await tx.select({ id: s.accountCreditTransaction.id }).from(s.accountCreditTransaction).where(and(
    eq(s.accountCreditTransaction.storeId, storeId), eq(s.accountCreditTransaction.orderId, o.id),
    eq(s.accountCreditTransaction.kind, 'RESERVE'), eq(s.accountCreditTransaction.status, 'PENDING'))).limit(1);
  if (creditHold) return { errorCode: 'ACCOUNT_CREDIT_HOLD_UNRESOLVED',
    error: 'Resolve the pending account credit hold through cancellation or reconciliation before purging' };
  const isPaid = isPaidPurgeState(o.state);
  if (isPaid && !opts.force) return { error: `paid order — purge requires force + reason (state ${o.state})` };
  if (isPaid && opts.force && !opts.reason) return { error: 'force-purging a paid order requires a reason' };
  return null;
}

/**
 * Delete the order and its operational children. The audit row (`purge`, with `data`) is written BEFORE the cascade
 * so the record survives the row deletion. Returns whether reserved stock was released (the caller regenerates the
 * catalog manifest after commit).
 */
export async function purgeOrderInSet(
  tx: Tx, held: HeldLocks, input: { storeId: string; order: { id: string; code: string; state: string }; actor: string; data: Record<string, unknown> },
): Promise<{ stockChanged: boolean }> {
  const { storeId, actor } = input;
  const o = input.order;
  await tx.insert(s.auditLog).values({ storeId, actor, entity: 'order', entityId: o.id, action: 'purge', data: { code: o.code, state: o.state, ...input.data } });

  // Source history & monetary credit entries survive purge. Detach only
  // operational back-references; their source records, allocations & money
  // remain intact. Refund/payment/line links also use ON DELETE SET NULL.
  await tx.update(s.importedOrderModification).set({ orderId: null })
    .where(and(eq(s.importedOrderModification.storeId, storeId), eq(s.importedOrderModification.orderId, o.id)));
  await tx.update(s.accountCreditTransaction).set({ orderId: null })
    .where(and(eq(s.accountCreditTransaction.storeId, storeId), eq(s.accountCreditTransaction.orderId, o.id)));

  const refunds = await tx.select({ id: s.refund.id }).from(s.refund).where(eq(s.refund.orderId, o.id));
  if (refunds.length) await tx.delete(s.refundLine).where(inArray(s.refundLine.refundId, refunds.map((x) => x.id)));
  await tx.delete(s.refund).where(eq(s.refund.orderId, o.id));

  const fulfillments = await tx.select({ id: s.fulfillment.id }).from(s.fulfillment).where(eq(s.fulfillment.orderId, o.id));
  if (fulfillments.length) await tx.delete(s.fulfillmentLine).where(inArray(s.fulfillmentLine.fulfillmentId, fulfillments.map((x) => x.id)));
  await tx.delete(s.fulfillment).where(eq(s.fulfillment.orderId, o.id));

  const returns = await tx.select({ id: s.returnRequest.id }).from(s.returnRequest).where(eq(s.returnRequest.orderId, o.id));
  if (returns.length) await tx.delete(s.returnLine).where(inArray(s.returnLine.returnId, returns.map((x) => x.id)));
  await tx.delete(s.returnRequest).where(eq(s.returnRequest.orderId, o.id));

  const lics = await tx.select({ id: s.license.id }).from(s.license).where(eq(s.license.orderId, o.id));
  if (lics.length) {
    await tx.delete(s.licenseActivation).where(inArray(s.licenseActivation.licenseId, lics.map((x) => x.id)));
    await tx.delete(s.license).where(inArray(s.license.id, lics.map((x) => x.id)));
  }
  // gift_card_transaction + return_request also reference order; gift-card
  // txns are a money ledger we keep, but they FK order — null is allowed via
  // the optional reference, so detach them rather than delete the audit trail.
  await tx.delete(s.promotionUsage).where(eq(s.promotionUsage.orderId, o.id));
  // Order editing (G13): edit history + adjustments (also ON DELETE cascade in 0084).
  await tx.delete(s.orderEdit).where(eq(s.orderEdit.orderId, o.id));
  await tx.delete(s.orderAdjustment).where(eq(s.orderAdjustment.orderId, o.id));
  // Payment reservations (PAYMENT-TIMING): deleted before the order; the lock set already holds them (L4).
  await purgeReservations(tx, held, { storeId, orderId: o.id });
  await tx.update(s.giftCardTransaction).set({ orderId: null }).where(eq(s.giftCardTransaction.orderId, o.id));
  await tx.update(s.stockMovement).set({ refOrderId: null }).where(eq(s.stockMovement.refOrderId, o.id));
  // A converted cart points back at this order (nullable FK) — detach it so
  // the order row can be deleted (the cart row itself is analytics, kept).
  await tx.update(s.cart).set({ convertedOrderId: null }).where(eq(s.cart.convertedOrderId, o.id));
  // A subscription's backing order (nullable FK) — detach so the order can be
  // purged; the subscription row (Stripe link) is kept.
  await tx.update(s.subscription).set({ orderId: null }).where(eq(s.subscription.orderId, o.id));
  // Dispute rows are an operator/compliance ledger — dispute.order_id and
  // dispute.payment_id are nullable back-refs, so detach rather than delete
  // the dispute record itself (a chargeback must survive order purge).
  await tx.update(dispute).set({ orderId: null }).where(eq(dispute.orderId, o.id));
  const pays = await tx.select({ id: s.payment.id }).from(s.payment).where(eq(s.payment.orderId, o.id));
  if (pays.length) await tx.update(dispute).set({ paymentId: null })
    .where(inArray(dispute.paymentId, pays.map((p) => p.id)));
  const attempts = await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.orderId, o.id));
  if (attempts.length) await tx.insert(s.auditLog).values({ storeId, actor,
    entity: 'order', entityId: o.id, action: 'archive_payment_attempts', data: { attempts } });
  await tx.delete(s.paymentAttempt).where(eq(s.paymentAttempt.orderId, o.id));
  // Purge retires the remaining reservation, not physical stock. Fulfilled
  // units already left onHand; cancelled/refunded units were released earlier.
  const lines = await tx.select().from(s.orderLine).where(and(eq(s.orderLine.orderId, o.id), eq(s.orderLine.storeId, storeId)));
  let stockChanged = false;
  for (const line of lines) {
    const remaining = Math.max(line.quantity - line.fulfilledQty - line.cancelledQty, 0);
    if (remaining > 0 && line.variantId) {
      await tx.update(s.stock).set({ allocated: sql`greatest(${s.stock.allocated} - ${remaining}, 0)` })
        .where(and(eq(s.stock.variantId, line.variantId), eq(s.stock.storeId, storeId)));
      stockChanged = true;
    }
  }
  await tx.delete(s.orderLine).where(eq(s.orderLine.orderId, o.id));
  // Chokepoint operation `order_purge` (order.id): the order's payments are snapshotted on the
  // operation row first (so invoice evidence survives), then payment rows and the order row go.
  await recordSettlementOperation(tx, {
    storeId, kind: 'order_purge', operationId: o.id, effects: [],
    mutations: [{ type: 'order_purge', orderId: o.id }],
  });
  return { stockChanged };
}
