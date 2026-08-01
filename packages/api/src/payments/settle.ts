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
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import type { PaymentResult } from './provider.js';
import { issueLicensesForPaidOrder } from '../licensing/issue.js';
import { enqueuePush, buildOrderPushPayload } from '../push/outbox.js';

/**
 * MONEY-3: amount still owed on an order, in cents — grandTotal minus every
 * Settled tender already recorded against it (gift-card draw-downs, prior
 * partial gateway captures, etc). This is the number a gateway charge must be
 * created/verified for — NEVER order.grandTotal directly, which silently
 * overcharges whenever an earlier tender (e.g. a partial gift card) already
 * paid part of the order down.
 */
export async function amountDueForOrder(tx: Tx, storeId: string, orderId: string, grandTotal: number): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${s.payment.amount}), 0)` })
    .from(s.payment)
    .where(and(eq(s.payment.storeId, storeId), eq(s.payment.orderId, orderId), eq(s.payment.state, 'Settled')));
  const settled = Number(row?.total ?? 0);
  return grandTotal - settled;
}

export interface SettleOrderRef {
  id: string;
  state: string;
  grandTotal: number;
  currency: string;
  customerId?: string | null;
  /** Human order code. Optional: only the push payload needs it, and a caller
   *  that doesn't have it simply doesn't get the mobile alert (never a throw). */
  code?: string;
}

export async function applyPaymentResult(
  tx: Tx,
  // `amount` is the amount ACTUALLY charged for this capture. Optional for
  // callers (e.g. subscriptions.ts renewal invoices) that always settle the
  // order's full grandTotal in one shot; defaults to order.grandTotal. /pay
  // and the Stripe webhook reconcile path (MONEY-3) pass it explicitly —
  // computed via amountDueForOrder — because a prior partial tender (a
  // gift-card draw-down at checkout) can leave less than grandTotal owed.
  opts: { storeId: string; order: SettleOrderRef; method: string; result: PaymentResult; amount?: number },
): Promise<{ orderState: OrderState; paymentState: PaymentResult['state'] }> {
  const { storeId, order, method, result } = opts;
  const amount = opts.amount ?? order.grandTotal;
  // MONEY-1: /pay and the Stripe webhook reconcile path both call this function
  // for the same capture — a concurrent settle race (client's /pay call and the
  // webhook landing at nearly the same instant) can reach here twice for the
  // same (storeId, providerRef). The partial unique index (migration 0037;
  // WHERE provider_ref IS NOT NULL, so manual/cod rows never collide) makes the
  // second insert a no-op instead of a duplicate ledger row. onConflictDoNothing
  // + .returning() lets us detect that no-op (0 rows) without a separate SELECT.
  //
  // MONEY-3: `amount` is the amount ACTUALLY charged for this capture — the
  // caller computes it via amountDueForOrder (grandTotal minus prior Settled
  // tenders), never order.grandTotal. Recording anything else here would make
  // the ledger lie about what the customer was charged.
  const inserted = await tx
    .insert(s.payment)
    .values({
      storeId,
      orderId: order.id,
      amount,
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
  if (result.state === 'Settled') {
    if (canTransition(order.state as OrderState, 'Paid')) {
      // MONEY-3: don't flip to Paid on the FIRST Settled tender — a partial
      // gift-card draw-down at checkout can leave the order PendingPayment with
      // grandTotal unchanged, and this same function later settles the
      // remaining gateway charge. Only transition once every Settled tender
      // (including the row just inserted) covers the full grandTotal.
      const remaining = await amountDueForOrder(tx, storeId, order.id, order.grandTotal);
      if (remaining <= 0) {
        const paidAt = new Date();
        await tx.update(s.order).set({ state: 'Paid', placedAt: paidAt }).where(eq(s.order.id, order.id));
        await issueLicensesForPaidOrder(tx, { storeId, orderId: order.id, customerId: order.customerId ?? null, paidAt });
        // Mobile push for the ASYNC paid paths (Stripe webhook, /pay, subscription
        // renewal). The synchronous checkout enqueues its own — it never calls this
        // function, so there's no double-ding. Guarded by the processed-event claim
        // above, so a webhook/pay race pushes exactly once. Same txn: a rollback
        // takes the alert with it.
        if (order.code) {
          await enqueuePush(tx, storeId, {
            topic: 'order.paid',
            payload: buildOrderPushPayload({ topic: 'order.paid', code: order.code, grandTotal: order.grandTotal, currency: order.currency }),
          });
        }
        return { orderState: 'Paid', paymentState: 'Settled' };
      }
      return { orderState: order.state as OrderState, paymentState: 'Settled' };
    }
    // MONEY-4: real money settled (e.g. a Stripe capture landing after the
    // stale-allocation job auto-cancelled the order) but the order's current
    // state can't transition to Paid. The payment row above already recorded
    // it — never let it stop there silently. Flag it loudly for manual
    // reconciliation instead of the money going invisible.
    await tx.insert(s.auditLog).values({
      storeId,
      actor: 'system:settle',
      entity: 'order',
      entityId: order.id,
      action: 'payment_after_cancel',
      fromState: order.state,
      toState: order.state,
      data: {
        reason: 'settled_payment_on_non_payable_order',
        needsReconciliation: true,
        amount,
        method,
        providerRef: result.providerRef ?? null,
      },
    });
  }
  return { orderState: order.state as OrderState, paymentState: result.state };
}
