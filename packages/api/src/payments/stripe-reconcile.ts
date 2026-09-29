/**
 * Stripe settlement fallback + durable PaymentIntent tracking (payments audit
 * D1/D3/D4/D5/D10/D14/D18).
 *
 * The webhook stays the primary settle path. Every PI minted for an order is
 * recorded as a payment_attempt row (operation 'intent', method 'stripe',
 * provider_ref = pi_...). `applyStripeIntent` is the ONE place a PaymentIntent
 * snapshot (from a webhook event or a server-side retrieve) is applied to an
 * order; it settles through the same idempotent applyPaymentResult the webhook
 * always used, so paid effects and the confirmation email fire exactly once no
 * matter which path wins.
 *
 * `reconcileStripeOrder` is the pull-based fallback: it retrieves each
 * unresolved tracked PI from Stripe with NO transaction open, then applies the
 * snapshot in a short transaction under the same advisory lock /pay uses.
 * Payment state only — nothing here caches stock or order data.
 *
 * Attempt status for operation 'intent':
 *   open       minted / awaiting the shopper (not a hold)
 *   processing processing | requires_action | requires_capture (a hold)
 *   failed     last attempt declined; the PI can still be retried (not a hold)
 *   unknown    succeeded at Stripe but could not be applied (D3; a hold)
 *   settled    recorded on the ledger
 *   cancelled  PI cancelled at Stripe
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { withAdvisoryLock, withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { applyPaymentResult, amountDueForOrder } from './settle.js';
import { verifyIntent, retrieveStripeIntent, cancelStripeIntent, type IntentLike, type StripeMode } from './stripe.js';
import { recordPaymentAlert } from './payment-alerts.js';

export type StripeIntent = IntentLike & { last_payment_error?: { message?: string | null } | null };

export type StripeIntentOutcome =
  | 'settled' | 'already_settled' | 'after_cancel' | 'duplicate' | 'verify_failed'
  | 'held' | 'failed' | 'cancelled' | 'open' | 'ignored';

type Attempt = typeof s.paymentAttempt.$inferSelect;

const HOLD_STATUSES = new Set(['processing', 'requires_action', 'requires_capture']);
/** Tracked intents the sweeper must resolve at Stripe before cancelling an order. */
export const SWEEPABLE_INTENT_STATUSES = ['open', 'failed'] as const;

const asMode = (m: string): StripeMode => (m === 'live' ? 'live' : 'test');

/** Record a minted PI against its order (idempotent on the PI id). */
export async function trackStripeIntent(tx: Tx, storeId: string, a: {
  orderId: string; intentId: string; amount: number; currency: string; mode: StripeMode; source?: string;
}): Promise<Attempt> {
  await tx.insert(s.paymentAttempt).values({
    storeId, orderId: a.orderId, operation: 'intent', method: 'stripe', accountId: 'stripe', mode: a.mode,
    amount: Math.max(1, a.amount), currency: a.currency.toUpperCase(),
    idempotencyKey: `stripe-pi:${a.intentId}`,
    fingerprint: createHash('sha256').update(`stripe-pi:${a.intentId}`).digest('hex'),
    status: 'open', providerRef: a.intentId, context: { source: a.source ?? 'payment-intent' },
  }).onConflictDoNothing();
  const [row] = await tx.select().from(s.paymentAttempt).where(and(
    eq(s.paymentAttempt.providerRef, a.intentId), eq(s.paymentAttempt.operation, 'intent'),
  )).limit(1).for('update');
  if (!row) throw new Error('stripe intent attempt missing after insert');
  return row;
}

async function setAttempt(tx: Tx, attempt: Attempt, status: string, extra: { paymentId?: string; result?: Record<string, unknown> } = {}) {
  // Monotonic: a settled intent never moves again (out-of-order events).
  if (attempt.status === 'settled' && status !== 'settled') return;
  await tx.update(s.paymentAttempt).set({
    status, updatedAt: new Date(),
    ...(extra.paymentId ? { paymentId: extra.paymentId } : {}),
    ...(extra.result ? { result: extra.result } : {}),
  }).where(eq(s.paymentAttempt.id, attempt.id));
}

async function stripePaymentFor(tx: Tx, intentId: string) {
  const [p] = await tx.select().from(s.payment).where(and(
    eq(s.payment.method, 'stripe'), eq(s.payment.providerRef, intentId),
  )).limit(1);
  return p;
}

/**
 * Apply one PaymentIntent snapshot to its order. Caller owns the transaction
 * (webhook claim tx, or reconcileStripeOrder's short tx). Never calls Stripe.
 */
export async function applyStripeIntent(tx: Tx, storeId: string, pi: StripeIntent, mode: StripeMode, opts: { actor?: string } = {}): Promise<{ outcome: StripeIntentOutcome; orderState?: string }> {
  const code = pi.metadata?.orderCode;
  if (!code) return { outcome: 'ignored' };
  const [order] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update');
  if (!order) return { outcome: 'ignored' };
  const attempt = await trackStripeIntent(tx, storeId, {
    orderId: order.id, intentId: pi.id, amount: pi.amount, currency: order.currency, mode, source: 'reconcile',
  });
  if (attempt.orderId !== order.id) return { outcome: 'ignored', orderState: order.state };
  const existing = await stripePaymentFor(tx, pi.id);
  const actor = opts.actor ?? 'system:stripe';

  if (pi.status === 'succeeded') {
    if (existing?.state === 'Settled') {
      await setAttempt(tx, attempt, 'settled', { paymentId: existing.id });
      return { outcome: 'already_settled', orderState: order.state };
    }
    const payable = order.state === 'PendingPayment' || order.state === 'Cancelled';
    const amountDue = payable ? await amountDueForOrder(tx, storeId, order.id, order.grandTotal) : 0;
    if (payable && amountDue > 0) {
      const result = verifyIntent(pi, { orderCode: code, amount: amountDue, currency: order.currency, stripeMode: mode });
      if (result.state === 'Settled') {
        const applied = await applyPaymentResult(tx, { storeId, order: { ...order, code }, method: 'stripe', result, amount: amountDue });
        const paid = await stripePaymentFor(tx, pi.id);
        await setAttempt(tx, attempt, 'settled', { paymentId: paid?.id, result: { state: 'Settled' } });
        if (order.state === 'Cancelled') {
          // D14: settle.ts already wrote the payment_after_cancel audit row
          // (MONEY-4); add the operator notification on top of it.
          await recordPaymentAlert(tx, storeId, {
            kind: 'payment_after_cancel', audit: false, actor, orderId: order.id, orderCode: code, providerRef: pi.id,
            amount: amountDue, currency: order.currency,
            detail: 'A Stripe payment settled after this order was cancelled. Stock was already released; refund the customer or reinstate the order manually.',
          });
          return { outcome: 'after_cancel', orderState: applied.orderState };
        }
        return { outcome: 'settled', orderState: applied.orderState };
      }
      // D3: captured money that fails verification (amount changed after the
      // PI was minted, wrong order binding) is never dropped silently.
      // Alert once per intent: a later poll/redelivery sees 'unknown' already.
      if (attempt.status === 'unknown') return { outcome: 'verify_failed', orderState: order.state };
      await setAttempt(tx, attempt, 'unknown', { result: { state: 'Settled', verifyError: result.errorMessage ?? 'verification failed' } });
      await recordPaymentAlert(tx, storeId, {
        kind: 'stripe_verify_failed', actor, orderId: order.id, orderCode: code, providerRef: pi.id,
        amount: pi.amount, currency: pi.currency.toUpperCase(),
        detail: `Stripe captured this payment but it did not match the order (${result.errorMessage ?? 'verification failed'}). It was not applied.`,
        data: { amountDue, orderState: order.state },
      });
      return { outcome: 'verify_failed', orderState: order.state };
    }
    // D4: a succeeded PI the order no longer needs (already Paid through a
    // different PI, or fully covered by other tenders) is a double charge.
    // Record the money on the ledger (flagged duplicate, so the normal refund
    // flow can return it) and alert the operator. No auto-refund.
    const [dup] = await tx.insert(s.payment).values({
      storeId, orderId: order.id, amount: pi.amount, method: 'stripe', providerRef: pi.id, state: 'Settled',
      gatewayMode: mode, currency: pi.currency.toUpperCase(),
      metadata: { duplicate: true, latest_charge: pi.latest_charge ?? null, gateway: { mode } },
      errorMessage: 'duplicate payment — order was already covered',
    }).onConflictDoNothing().returning({ id: s.payment.id });
    const paymentId = dup?.id ?? (await stripePaymentFor(tx, pi.id))?.id;
    await setAttempt(tx, attempt, 'settled', { paymentId, result: { state: 'Settled', duplicate: true } });
    if (dup) {
      await recordPaymentAlert(tx, storeId, {
        kind: 'duplicate_payment', actor, orderId: order.id, orderCode: code, providerRef: pi.id,
        amount: pi.amount, currency: pi.currency.toUpperCase(),
        detail: `Stripe captured a second payment for an order that was already ${order.state === 'PendingPayment' ? 'covered' : order.state}. It was recorded as a duplicate; refund it from the order.`,
        data: { orderState: order.state },
      });
    }
    return { outcome: 'duplicate', orderState: order.state };
  }

  if (HOLD_STATUSES.has(pi.status)) {
    await setAttempt(tx, attempt, 'processing', { result: { status: pi.status } });
    return { outcome: 'held', orderState: order.state };
  }

  if (pi.status === 'canceled') {
    await setAttempt(tx, attempt, 'cancelled', { result: { status: pi.status } });
    if (existing && existing.state === 'Pending') {
      await applyPaymentResult(tx, { storeId, order: { ...order, code }, method: 'stripe', amount: existing.amount,
        result: { state: 'Declined', providerRef: pi.id, errorMessage: 'payment intent canceled', metadata: { gateway: { mode } } } });
    }
    return { outcome: 'cancelled', orderState: order.state };
  }

  // requires_payment_method with an error = the last confirmation failed
  // (D10). The PI stays retryable, so the attempt is released (not a hold)
  // and the shopper can try again. D18: a Declined ledger row lets the order
  // read report paymentStatus 'failed' with the provider message.
  const failure = pi.last_payment_error?.message ?? null;
  if (pi.status === 'requires_payment_method' && (failure || existing?.state === 'Pending')) {
    await setAttempt(tx, attempt, 'failed', { result: { status: pi.status, error: failure } });
    if (order.state === 'PendingPayment' && existing?.state !== 'Settled') {
      await applyPaymentResult(tx, { storeId, order: { ...order, code }, method: 'stripe', amount: existing?.amount ?? pi.amount,
        result: { state: 'Declined', providerRef: pi.id, errorMessage: failure ?? 'payment failed', metadata: { gateway: { mode } } } });
    }
    return { outcome: 'failed', orderState: order.state };
  }
  if (attempt.status !== 'failed') await setAttempt(tx, attempt, 'open', { result: { status: pi.status } });
  return { outcome: 'open', orderState: order.state };
}

export interface ReconcileResult {
  found: boolean;
  code?: string;
  state?: string;
  intents: Array<{ intentId: string; outcome: StripeIntentOutcome | 'error'; error?: string }>;
}

/**
 * D1: server-side settlement fallback. For a PendingPayment (or, MONEY-4,
 * Cancelled) order, retrieve every unresolved tracked PI from Stripe and apply
 * it. Stripe is called with no transaction open; each apply is a short tx
 * under the order's pay advisory lock.
 */
export async function reconcileStripeOrder(storeId: string, ref: { code: string } | { orderId: string }, opts: { actor?: string } = {}): Promise<ReconcileResult> {
  const found = await withStore(storeId, async (tx) => {
    const [order] = await tx.select({ id: s.order.id, code: s.order.code, state: s.order.state }).from(s.order)
      .where('code' in ref ? eq(s.order.code, ref.code) : eq(s.order.id, ref.orderId)).limit(1);
    if (!order) return null;
    const attempts = await tx.select().from(s.paymentAttempt).where(and(
      eq(s.paymentAttempt.orderId, order.id), eq(s.paymentAttempt.operation, 'intent'),
      notInArray(s.paymentAttempt.status, ['settled', 'cancelled']),
    ));
    return { order, attempts };
  });
  if (!found) return { found: false, intents: [] };
  const { order, attempts } = found;
  const out: ReconcileResult = { found: true, code: order.code, state: order.state, intents: [] };
  if (order.state !== 'PendingPayment' && order.state !== 'Cancelled') return out;
  for (const a of attempts) {
    if (!a.providerRef) continue;
    const mode = asMode(a.mode);
    try {
      const pi = await retrieveStripeIntent(storeId, mode, a.providerRef);
      const r = await withAdvisoryLock(`pay:${storeId}:${order.code}`, () =>
        withStore(storeId, (tx) => applyStripeIntent(tx, storeId, pi, mode, opts)));
      out.intents.push({ intentId: a.providerRef, outcome: r.outcome });
      if (r.orderState) out.state = r.orderState;
    } catch (e) {
      out.intents.push({ intentId: a.providerRef, outcome: 'error', error: e instanceof Error ? e.message : 'reconcile failed' });
    }
  }
  return out;
}

/**
 * D5: before the stale sweeper cancels PendingPayment orders, resolve their
 * open Stripe intents at Stripe: succeeded → settle (not cancel); processing /
 * requires_action → hold; anything else → cancel the PI at Stripe, then the
 * order may be cancelled. An intent that cannot be resolved (Stripe error)
 * stays open, and the sweeper's claim query keeps skipping its order.
 */
export async function sweepStaleStripeIntents(storeId: string, cutoff: Date, limit: number, log: (m: string) => void = () => {}): Promise<{ checked: number; settled: number; held: number; cancelled: number; errors: number }> {
  const stats = { checked: 0, settled: 0, held: 0, cancelled: 0, errors: 0 };
  const rows = await withStore(storeId, (tx) => tx.select({
    code: s.order.code, intentId: s.paymentAttempt.providerRef, mode: s.paymentAttempt.mode,
  }).from(s.paymentAttempt).innerJoin(s.order, eq(s.order.id, s.paymentAttempt.orderId)).where(and(
    eq(s.paymentAttempt.operation, 'intent'), inArray(s.paymentAttempt.status, [...SWEEPABLE_INTENT_STATUSES]),
    eq(s.order.state, 'PendingPayment'), sql`${s.order.createdAt} < ${cutoff}`,
  )).limit(limit));
  for (const r of rows) {
    if (!r.intentId) continue;
    stats.checked++;
    const mode = asMode(r.mode);
    try {
      let pi: StripeIntent = await retrieveStripeIntent(storeId, mode, r.intentId);
      if (pi.status !== 'succeeded' && !HOLD_STATUSES.has(pi.status) && pi.status !== 'canceled') {
        pi = await cancelStripeIntent(storeId, mode, r.intentId);
      }
      const applied = await withAdvisoryLock(`pay:${storeId}:${r.code}`, () =>
        withStore(storeId, (tx) => applyStripeIntent(tx, storeId, pi, mode, { actor: 'system:reservation-expiry' })));
      if (['settled', 'already_settled', 'duplicate', 'verify_failed'].includes(applied.outcome)) stats.settled++;
      else if (applied.outcome === 'held') stats.held++;
      else if (applied.outcome === 'cancelled') stats.cancelled++;
    } catch (e) {
      stats.errors++;
      log(`[release-stale] stripe intent ${r.intentId} unresolved: ${e instanceof Error ? e.message : 'error'}`);
    }
  }
  return stats;
}

/**
 * Per-order throttle for the shopper-triggered fallback (GET order, POST
 * payment/refresh): at most one Stripe round-trip per order per window. This
 * limits calls to Stripe; it caches no payment, stock or order data — every
 * permitted call reads live Stripe + DB state.
 */
export const RECONCILE_THROTTLE_MS = 5_000;
const lastReconcile = new Map<string, number>();
export function claimReconcileSlot(storeId: string, orderId: string, now = Date.now()): boolean {
  const key = `${storeId}:${orderId}`;
  const last = lastReconcile.get(key);
  if (last !== undefined && now - last < RECONCILE_THROTTLE_MS) return false;
  if (lastReconcile.size > 10_000) {
    for (const [k, t] of lastReconcile) if (now - t >= RECONCILE_THROTTLE_MS) lastReconcile.delete(k);
  }
  lastReconcile.set(key, now);
  return true;
}
