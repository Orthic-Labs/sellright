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
import { enqueuePaidEffects } from './paid-effects.js';
import { enqueuePush, buildOrderPushPayload } from '../push/outbox.js';
import { enqueueEmail } from '../email/outbox.js';
import { paymentAfterCancelAlert } from '../email/templates-ops.js';
import { operatorRecipients } from '../disputes/disputes.js';
import { env } from '../env.js';
import { EDIT_REFUND_SOURCE } from './edit-refund.js';

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
  return grandTotal - settled + await editRefundedTotal(tx, storeId, orderId);
}

/**
 * Order editing (G13): money already handed BACK because an edit lowered the
 * order total (a refund tagged by payments/edit-refund.ts). The order's
 * grandTotal was reduced by the same edit, so this refund must not read as "the
 * customer now owes it again" — it is added back to the amount due. Refunds
 * issued through the regular refund flow (item/return refunds, which never
 * change grandTotal) are deliberately NOT counted: the refund engine leaves
 * grandTotal alone, so for those the existing grandTotal - settled arithmetic
 * is already right. Failed refunds returned no money and are ignored. Orders
 * that were never edited cost one cheap lookup and return 0.
 */
export async function editRefundedTotal(tx: Tx, storeId: string, orderId: string): Promise<number> {
  const res = await tx.execute(sql`
    SELECT coalesce(sum(r.amount), 0)::bigint AS total
    FROM refund r
    WHERE r.store_id = ${storeId} AND r.order_id = ${orderId} AND r.state <> 'Failed'
      AND r.metadata->>'source' = ${EDIT_REFUND_SOURCE}`);
  return Number((res.rows[0] as { total?: string } | undefined)?.total ?? 0);
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
  const { storeId, method, result } = opts;
  const [current] = await tx.select().from(s.order)
    .where(and(eq(s.order.id, opts.order.id), eq(s.order.storeId, storeId))).limit(1).for('update');
  if (!current) throw new Error('Payment order is missing');
  const order = current;
  const amount = opts.amount ?? order.grandTotal;
  const identity = (result.metadata as { gateway?: { accountId?: string; mode?: string } } | null)?.gateway;
  const gatewayAccount = identity?.accountId ?? null;
  const gatewayMode = identity?.mode ?? null;
  const row = {
    storeId, orderId: order.id, amount, method,
    providerRef: result.providerRef, state: result.state,
    gatewayAccount, gatewayMode, currency: order.currency,
    metadata: (result.metadata ?? null) as object | null,
    errorMessage: result.errorMessage ?? null,
  };
  const inserted = await tx.insert(s.payment).values(row)
    .onConflictDoNothing().returning({ id: s.payment.id });
  if (!inserted.length) {
    // SR-03: a Stripe provider ref (pi_...) is bound to exactly one
    // account+mode at the provider — a payment_intent id can never exist in
    // both test and live. The dedupe index for stripe therefore keys on
    // (store_id, provider_ref) alone (migration 0055), and this lookup is
    // mode/account-tolerant for the same reason: a row first written before
    // its trusted mode was known (e.g. a subscription invoice settle) must
    // still be FOUND here rather than mistaken for a different payment —
    // its missing identity is then backfilled below. nmi/sezzle keep the
    // strict account+mode match: their transaction ids can collide across
    // accounts/modes, so identity is part of the key.
    const [existing] = await tx.select().from(s.payment).where(and(
      eq(s.payment.storeId, storeId), eq(s.payment.method, method),
      eq(s.payment.providerRef, result.providerRef!),
      ...(method === 'stripe' ? [] : [
        sql`coalesce(${s.payment.gatewayAccount}, '') = ${gatewayAccount ?? ''}`,
        sql`coalesce(${s.payment.gatewayMode}, '') = ${gatewayMode ?? ''}`,
      ]),
    )).limit(1).for('update');
    if (!existing || existing.orderId !== order.id || existing.amount !== amount ||
        (existing.currency && existing.currency !== order.currency) ||
        (existing.gatewayMode != null && gatewayMode != null && existing.gatewayMode !== gatewayMode) ||
        (existing.gatewayAccount != null && gatewayAccount != null && existing.gatewayAccount !== gatewayAccount)) {
      throw new Error('Payment reference does not match the order and amount');
    }
    // Backfill the trusted gateway identity on rows recorded before it was
    // persisted (never overwrite — a stored identity wins; conflicts were
    // rejected above).
    if ((gatewayMode && !existing.gatewayMode) || (gatewayAccount && !existing.gatewayAccount)) {
      await tx.update(s.payment).set({
        gatewayMode: existing.gatewayMode ?? gatewayMode,
        gatewayAccount: existing.gatewayAccount ?? gatewayAccount,
      }).where(eq(s.payment.id, existing.id));
      existing.gatewayMode = existing.gatewayMode ?? gatewayMode;
      existing.gatewayAccount = existing.gatewayAccount ?? gatewayAccount;
    }
    // A duplicate or delayed webhook must never downgrade captured funds.
    if (existing.state === 'Settled' ||
        (existing.state === 'Authorized' && result.state === 'Pending') ||
        (existing.state !== 'Pending' && result.state !== 'Settled' && existing.state === result.state)) {
      return { orderState: order.state as OrderState, paymentState: existing.state };
    }
    await tx.update(s.payment).set({
      state: result.state, metadata: row.metadata, errorMessage: row.errorMessage,
    }).where(eq(s.payment.id, existing.id));
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
        await enqueuePaidEffects(tx, storeId, order.id);
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
    // Order editing (G13): a Settled tender landing on an order that is ALREADY
    // Paid (or PartiallyRefunded) is a balance payment for an edit that raised
    // the total. The payment row above is the ledger entry; the order state
    // stays as is (FSM unchanged). Duplicate-capture detection for money the
    // order did NOT need lives in the callers (they only reach here when an
    // amount was genuinely due).
    if ((order.state === 'Paid' || order.state === 'PartiallyRefunded') &&
        (await amountDueForOrder(tx, storeId, order.id, order.grandTotal)) >= 0) {
      // (amount due after this row is >= 0, i.e. it did not overpay the order;
      // an overpayment still falls through to the MONEY-4 alert below.)
      await tx.insert(s.auditLog).values({
        storeId, actor: 'system:settle', entity: 'order', entityId: order.id,
        action: 'balance_payment', fromState: order.state, toState: order.state,
        data: { amount, method, providerRef: result.providerRef ?? null },
      });
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
    // D14: the audit row alone was invisible — alert operators through the
    // transactional email outbox (same tx: a rollback drops the alert too).
    await enqueuePaymentAfterCancelAlert(tx, storeId, {
      orderId: order.id, orderCode: order.code ?? null, orderState: order.state,
      method, providerRef: result.providerRef ?? null, amount, currency: order.currency,
    });
  }
  return { orderState: order.state as OrderState, paymentState: result.state };
}

/** D14: operator email for a MONEY-4 payment_after_cancel. Deduped per
 *  (order, provider ref, recipient) so a webhook replay never double-sends. */
export async function enqueuePaymentAfterCancelAlert(tx: Tx, storeId: string, d: {
  orderId: string; orderCode: string | null; orderState: string; method: string;
  providerRef: string | null; amount: number; currency: string | null;
}): Promise<number> {
  const [store] = await tx.select({ name: s.store.name, currency: s.store.currency, config: s.store.config })
    .from(s.store).where(eq(s.store.id, storeId)).limit(1);
  const recipients = await operatorRecipients(tx, storeId);
  const storefrontUrl = ((store?.config as { storefrontUrl?: string } | null)?.storefrontUrl) ?? env.STOREFRONT_URL;
  const rendered = paymentAfterCancelAlert(
    { name: store?.name ?? 'Store', currency: store?.currency ?? 'USD', storefrontUrl, fromEmail: env.SMTP_FROM ?? '' },
    { orderCode: d.orderCode, orderState: d.orderState, method: d.method, providerRef: d.providerRef,
      amountCents: d.amount, currency: d.currency ?? store?.currency ?? null },
  );
  for (const recipient of recipients) {
    await enqueueEmail(tx, storeId, {
      kind: 'payment_after_cancel_alert', recipient,
      payload: { to: recipient, from: env.SMTP_FROM, subject: rendered.subject, html: rendered.html, text: rendered.text },
      dedupeKey: `payment_after_cancel:${d.orderId}:${d.providerRef ?? 'none'}:${recipient}`,
    });
  }
  return recipients.length;
}
