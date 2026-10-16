/**
 * WP3: shared settle path. Records a PaymentResult against an order and, when it
 * Settled, transitions PendingPayment -> Paid through the FSM. Used by both
 * POST /v1/shop/orders/{code}/pay and the inbound Stripe webhook reconcile path
 * (payment_intent.succeeded), so a client that dies before calling /pay still
 * lands the exact same ledger row + state change when the webhook arrives.
 *
 * Caller owns the transaction (and any idempotency claim). Every write goes
 * through the settlement chokepoint (settlement/record.ts), which also records the
 * fulfilment effects in the same transaction (settlement/effects.ts).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { withLockedSetInTx } from '../db/locks.js';
import * as s from '../db/schema.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import type { PaymentResult } from './provider.js';
import { editBalanceEffects, paidOrderEffects, recordSettlementOperation, type SettlementMutation } from './settlement/record.js';
import { enqueueEmail } from '../email/outbox.js';
import { paymentAfterCancelAlert } from '../email/templates-ops.js';
import { operatorRecipients } from '../disputes/disputes.js';
import { env } from '../env.js';
import { EDIT_REFUND_SOURCE } from './edit-refund.js';
import { usableTenderSql } from './tender.js';

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
    .where(and(eq(s.payment.storeId, storeId), eq(s.payment.orderId, orderId), usableTenderSql));
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
  opts: { storeId: string; order: SettleOrderRef; method: string; result: PaymentResult; amount?: number; editId?: string },
): Promise<{ orderState: OrderState; paymentState: PaymentResult['state'] }> {
  // PAYMENT-TIMING §3.5: the order's set (L2 licences, L3 order, L4 reservations) is held on this transaction BEFORE
  // the order row is read FOR UPDATE below, so an inline issuance never takes L2 after L3. Pass-through when the
  // caller already holds a covering set (webhook, /pay, order edit, gateway finish).
  return withLockedSetInTx(tx, opts.storeId, { kind: 'order', orderId: opts.order.id }, () => applyPaymentResultLocked(tx, opts));
}

async function applyPaymentResultLocked(
  tx: Tx,
  // `amount` is the amount ACTUALLY charged for this capture. Optional for
  // callers that always settle the order's full grandTotal in one shot; defaults
  // to order.grandTotal. /pay and the Stripe webhook reconcile path (MONEY-3)
  // pass it explicitly — computed via amountDueForOrder — because a prior
  // partial tender (a gift-card draw-down at checkout) can leave less than
  // grandTotal owed. `editId`: the order edit this payment settles (the edit's
  // own record_payment), which keys the balance operation.
  opts: { storeId: string; order: SettleOrderRef; method: string; result: PaymentResult; amount?: number; editId?: string },
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
  const settled = result.state === 'Settled';
  const mismatch = () => new Error('Payment reference does not match the order and amount');

  // ── plan (reads only): insert a new ledger row, or progress the existing one ──
  let paymentId: string = randomUUID();
  const mutations: SettlementMutation[] = [];
  if (result.providerRef) {
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
      eq(s.payment.providerRef, result.providerRef),
      ...(method === 'stripe' ? [] : [
        sql`coalesce(${s.payment.gatewayAccount}, '') = ${gatewayAccount ?? ''}`,
        sql`coalesce(${s.payment.gatewayMode}, '') = ${gatewayMode ?? ''}`,
      ]),
    )).limit(1).for('update');
    if (existing) {
      if (existing.orderId !== order.id || existing.amount !== amount ||
          (existing.currency && existing.currency !== order.currency) ||
          (existing.gatewayMode != null && gatewayMode != null && existing.gatewayMode !== gatewayMode) ||
          (existing.gatewayAccount != null && gatewayAccount != null && existing.gatewayAccount !== gatewayAccount)) {
        throw mismatch();
      }
      // Backfill the trusted gateway identity on rows recorded before it was
      // persisted (never overwrite — a stored identity wins; conflicts were
      // rejected above).
      if ((gatewayMode && !existing.gatewayMode) || (gatewayAccount && !existing.gatewayAccount)) {
        await recordSettlementOperation(tx, {
          storeId, kind: 'payment_state_progress', operationId: existing.id, effects: [],
          mutations: [{ type: 'payment_gateway_identity', paymentId: existing.id, gatewayMode, gatewayAccount }],
        });
      }
      // A duplicate or delayed webhook must never downgrade captured funds.
      if (existing.state === 'Settled' ||
          (existing.state === 'Authorized' && result.state === 'Pending') ||
          (existing.state !== 'Pending' && result.state !== 'Settled' && existing.state === result.state)) {
        return { orderState: order.state as OrderState, paymentState: existing.state };
      }
      paymentId = existing.id;
      mutations.push({ type: 'payment_state', paymentId, next: { state: result.state, metadata: row.metadata, errorMessage: row.errorMessage } });
    }
  }
  if (!mutations.length) mutations.push({ type: 'payment_insert', rows: [{ ...row, id: paymentId }] });

  // ── not a captured payment: a monotone progression, no first-paid effects ──
  if (!settled) {
    const r = await recordSettlementOperation(tx, { storeId, kind: 'payment_state_progress', operationId: paymentId, effects: [], mutations });
    if (r.paymentId === undefined) throw mismatch();
    return { orderState: order.state as OrderState, paymentState: result.state };
  }

  // MONEY-3: don't flip to Paid on the FIRST Settled tender — a partial
  // gift-card draw-down at checkout can leave the order PendingPayment with
  // grandTotal unchanged, and this same function later settles the remaining
  // gateway charge. Only transition once every Settled tender (including this
  // one) covers the full grandTotal.
  const remaining = (await amountDueForOrder(tx, storeId, order.id, order.grandTotal)) - amount;
  const transitions = canTransition(order.state as OrderState, 'Paid') && remaining <= 0;
  const balance = !canTransition(order.state as OrderState, 'Paid') &&
    (order.state === 'Paid' || order.state === 'PartiallyRefunded') && remaining >= 0;
  // Entitlements follow money: once an edit's balance is fully covered, issue
  // licences for added licensed lines (idempotent), revoke any stranded on removed
  // lines, and post a deferred edit earn. The edit's own settlement is keyed by the
  // edit; any other balance payment by the payment fact.
  const balanceCleared = balance && remaining === 0;
  const op = (opts.editId && balanceCleared)
    ? { kind: 'order_edit_balance_settled' as const, operationId: opts.editId }
    : { kind: 'payment_settled' as const, operationId: paymentId };
  const recorded = await recordSettlementOperation(tx, {
    storeId, ...op, mutations,
    effects: balanceCleared ? editBalanceEffects({ orderId: order.id, customerId: order.customerId ?? null }) : [],
  });
  if (!recorded.created && !recorded.replayed) throw mismatch();

  if (transitions) {
    const paidAt = new Date();
    // The Paid transition is its own operation (order.id); its fan-out — licence
    // issue, loyalty (account bootstrap first), and notification (order.paid event,
    // confirmation, list enrolment, and — for these ASYNC paid paths — the mobile
    // push) — are effect rows written in THIS transaction and executed before it
    // commits. Guarded by the processed-event claim upstream, and by the operation
    // identity as a second line, so a webhook/pay race pushes exactly once.
    await recordSettlementOperation(tx, {
      storeId, kind: 'order_paid_transition', operationId: order.id, orderId: order.id,
      mutations: [{ type: 'order_paid', orderId: order.id, placedAt: paidAt }],
      effects: paidOrderEffects({ orderId: order.id, customerId: order.customerId ?? null, paidAt, variant: 'settle' }),
    });
    return { orderState: 'Paid', paymentState: 'Settled' };
  }
  if (!balance && canTransition(order.state as OrderState, 'Paid')) {
    return { orderState: order.state as OrderState, paymentState: 'Settled' }; // partial tender: still owed
  }
  if (balance) {
    // Order editing (G13): a Settled tender landing on an order that is ALREADY
    // Paid (or PartiallyRefunded) is a balance payment for an edit that raised the
    // total. The payment row is the ledger entry; the order state stays as is (FSM
    // unchanged). An overpayment (remaining < 0) falls through to the MONEY-4 alert.
    await tx.insert(s.auditLog).values({
      storeId, actor: 'system:settle', entity: 'order', entityId: order.id,
      action: 'balance_payment', fromState: order.state, toState: order.state,
      data: { amount, method, providerRef: result.providerRef ?? null },
    });
    return { orderState: order.state as OrderState, paymentState: 'Settled' };
  }
  await recordPaymentAfterCancel(tx, storeId, order, { method, providerRef: result.providerRef ?? null, amount });
  return { orderState: order.state as OrderState, paymentState: result.state };
}

/** MONEY-4: real money settled on an order whose state can't transition to Paid. Never leave it silent. */
export async function recordPaymentAfterCancel(
  tx: Tx, storeId: string,
  order: { id: string; code?: string | null; state: string; currency: string },
  d: { method: string; providerRef: string | null; amount: number },
): Promise<void> {
  const { method, amount } = d;
  const result = { providerRef: d.providerRef };
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
