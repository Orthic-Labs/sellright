/**
 * WP3: shared settle path. Records a PaymentResult against an order and, when it
 * Settled, transitions PendingPayment -> Paid through the FSM. Used by both
 * POST /v1/shop/orders/{code}/pay and the inbound Stripe webhook reconcile path
 * (payment_intent.succeeded), so a client that dies before calling /pay still
 * lands the exact same ledger row + state change when the webhook arrives.
 *
 * Caller owns the transaction (and any idempotency claim). This function only
 * writes the payment row + the order transition.
 */
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import type { PaymentResult } from './provider.js';
import { issueLicensesForPaidOrder } from '../licensing/issue.js';

export interface SettleOrderRef {
  id: string;
  state: string;
  grandTotal: number;
  currency: string;
  customerId?: string | null;
}

export async function applyPaymentResult(
  tx: Tx,
  opts: { storeId: string; order: SettleOrderRef; method: string; result: PaymentResult },
): Promise<{ orderState: OrderState; paymentState: PaymentResult['state'] }> {
  const { storeId, order, method, result } = opts;
  // MONEY-1: /pay and the Stripe webhook reconcile path both call this function
  // for the same capture — a concurrent settle race (client's /pay call and the
  // webhook landing at nearly the same instant) can reach here twice for the
  // same (storeId, providerRef). The partial unique index (migration 0037;
  // WHERE provider_ref IS NOT NULL, so manual/cod rows never collide) makes the
  // second insert a no-op instead of a duplicate ledger row. onConflictDoNothing
  // + .returning() lets us detect that no-op (0 rows) without a separate SELECT.
  const inserted = await tx
    .insert(s.payment)
    .values({
      storeId,
      orderId: order.id,
      amount: order.grandTotal,
      method,
      providerRef: result.providerRef,
      state: result.state, // PaymentResult states are all members of the payment_state enum
      metadata: (result.metadata ?? null) as object | null,
      errorMessage: result.errorMessage ?? null,
    })
    // The arbiter is the PARTIAL unique index (migration 0037), so the ON
    // CONFLICT target MUST carry the same `WHERE provider_ref IS NOT NULL`
    // predicate — without it Postgres cannot infer the arbiter index and every
    // payment insert fails with 42P10 (infer_arbiter_indexes). Null provider_ref
    // rows (manual/cod) fall outside the index and never conflict.
    .onConflictDoNothing({
      target: [s.payment.storeId, s.payment.providerRef],
      where: sql`${s.payment.providerRef} is not null`,
    })
    .returning({ id: s.payment.id });
  if (inserted.length === 0) {
    // Already settled by the other caller (webhook vs /pay race). Skip the FSM
    // transition + license issuance — they already ran (or are about to run) on
    // whichever call won the insert. Report the order's CURRENT state rather
    // than re-deriving from `result`, since the winning call may have already
    // moved it to Paid.
    return { orderState: order.state as OrderState, paymentState: result.state };
  }
  if (result.state === 'Settled' && canTransition(order.state as OrderState, 'Paid')) {
    const paidAt = new Date();
    await tx.update(s.order).set({ state: 'Paid', placedAt: paidAt }).where(eq(s.order.id, order.id));
    await issueLicensesForPaidOrder(tx, { storeId, orderId: order.id, customerId: order.customerId ?? null, paidAt });
    return { orderState: 'Paid', paymentState: 'Settled' };
  }
  return { orderState: order.state as OrderState, paymentState: result.state };
}
