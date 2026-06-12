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
import { eq } from 'drizzle-orm';
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
  await tx.insert(s.payment).values({
    storeId,
    orderId: order.id,
    amount: order.grandTotal,
    method,
    providerRef: result.providerRef,
    state: result.state, // PaymentResult states are all members of the payment_state enum
    metadata: (result.metadata ?? null) as object | null,
    errorMessage: result.errorMessage ?? null,
  });
  if (result.state === 'Settled' && canTransition(order.state as OrderState, 'Paid')) {
    const paidAt = new Date();
    await tx.update(s.order).set({ state: 'Paid', placedAt: paidAt }).where(eq(s.order.id, order.id));
    await issueLicensesForPaidOrder(tx, { storeId, orderId: order.id, customerId: order.customerId ?? null, paidAt });
    return { orderState: 'Paid', paymentState: 'Settled' };
  }
  return { orderState: order.state as OrderState, paymentState: result.state };
}
