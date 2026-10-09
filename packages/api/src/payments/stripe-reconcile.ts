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
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import { recoveryBackoffMs } from '../jobs/gateway-recovery.js';
import { withAdvisoryLock, withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { applyPaymentResult, amountDueForOrder } from './settle.js';
import { recordSettlementOperation } from './settlement/record.js';
import { verifyIntent, retrieveStripeIntent, cancelStripeIntent, searchStripeIntentsForOrder, resolveStripeConfigured, type IntentLike, type StripeMode } from './stripe.js';
import { isPaymentMethodEnabled } from './provider.js';
import { recordPaymentAlert } from './payment-alerts.js';
import { releaseOnProviderTerminal } from './reservation.js';
import { env } from '../env.js';

export type StripeIntent = IntentLike & { last_payment_error?: { message?: string | null } | null };

export type StripeIntentOutcome =
  | 'settled' | 'already_settled' | 'after_cancel' | 'duplicate' | 'verify_failed'
  | 'held' | 'action_required' | 'failed' | 'cancelled' | 'open' | 'ignored';

type Attempt = typeof s.paymentAttempt.$inferSelect;

/** Only money that may still move without the shopper holds the order. A PI in
 *  requires_action waits on the shopper (3DS) and is cancellable at Stripe, so
 *  it is NOT a hold: the sweeper may cancel it past the TTL. */
const HOLD_STATUSES = new Set(['processing', 'requires_capture']);
/** Tracked intents the sweeper must resolve at Stripe before cancelling an order. */
export const SWEEPABLE_INTENT_STATUSES = ['open', 'failed', 'action_required'] as const;
/** Sweeper retrieve/cancel failures before an intent is flagged for operators. */
export const STRIPE_SWEEP_MAX_TRIES = 5;
const STRIPE_SWEEP_BACKOFF_MIN = 5;

const asMode = (m: string): StripeMode => (m === 'live' ? 'live' : 'test');

/** Record a minted PI against its order (idempotent on the PI id). An attempt already bound to this
 *  PI (a pre-mint row, or an earlier track) is returned as is, never duplicated. */
export async function trackStripeIntent(tx: Tx, storeId: string, a: {
  orderId: string; intentId: string; amount: number; currency: string; mode: StripeMode; source?: string;
}): Promise<Attempt> {
  const [bound] = await tx.select().from(s.paymentAttempt).where(and(
    eq(s.paymentAttempt.providerRef, a.intentId), eq(s.paymentAttempt.operation, 'intent'),
  )).limit(1).for('update');
  if (bound) return bound;
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

/**
 * PAYMENT-TIMING §4.2 (decision X-9): the pre-mint attempt row for one mint-loop iteration, written
 * after the beforePaymentAttempt hook and before the PaymentIntent is minted. Status `open`, no
 * provider ref, so the order is non-quiescent from this commit. Idempotent on the iteration key:
 * a replay of the same mint key collapses onto the same row.
 */
export async function openStripePreMint(tx: Tx, storeId: string, a: {
  orderId: string; iterationKey: string; amount: number; currency: string; mode: StripeMode;
}): Promise<Attempt> {
  const idempotencyKey = `stripe-pi-pending:${a.iterationKey}`;
  await tx.insert(s.paymentAttempt).values({
    storeId, orderId: a.orderId, operation: 'intent', method: 'stripe', accountId: 'stripe', mode: a.mode,
    amount: Math.max(1, a.amount), currency: a.currency.toUpperCase(), idempotencyKey,
    fingerprint: createHash('sha256').update(idempotencyKey).digest('hex'),
    status: 'open', providerRef: null, context: { source: 'payment-intent', preMint: true },
  }).onConflictDoNothing();
  const [row] = await tx.select().from(s.paymentAttempt).where(and(
    eq(s.paymentAttempt.storeId, storeId), eq(s.paymentAttempt.idempotencyKey, idempotencyKey),
  )).limit(1).for('update');
  if (!row || row.orderId !== a.orderId) throw new Error('stripe pre-mint attempt is missing or belongs to another order');
  return row;
}

/**
 * Binds a pre-mint row to the PaymentIntent it minted (same transaction as the track). When an
 * attempt already tracks this PI (a normal idempotent replay under a different key), the pending row
 * never had a provider object: it is marked cancelled with `superseded_by` and the existing attempt
 * is returned. Otherwise the pending row itself takes the provider ref.
 */
export async function bindStripePreMint(tx: Tx, storeId: string, a: {
  pendingAttemptId: string; orderId: string; intentId: string; amount: number; currency: string; mode: StripeMode;
}): Promise<Attempt> {
  const [existing] = await tx.select().from(s.paymentAttempt).where(and(
    eq(s.paymentAttempt.providerRef, a.intentId), eq(s.paymentAttempt.operation, 'intent'),
  )).limit(1).for('update');
  if (existing?.id === a.pendingAttemptId) return existing;
  if (existing) {
    await tx.update(s.paymentAttempt).set({
      status: 'cancelled', result: { superseded_by: existing.id }, updatedAt: new Date(),
    }).where(and(eq(s.paymentAttempt.id, a.pendingAttemptId), isNull(s.paymentAttempt.providerRef)));
    return existing;
  }
  // The row keeps its pending iteration key: a replay of the same mint key must find this row (T-S7 collapse).
  const [row] = await tx.update(s.paymentAttempt).set({ providerRef: a.intentId, updatedAt: new Date() })
    .where(and(eq(s.paymentAttempt.id, a.pendingAttemptId), isNull(s.paymentAttempt.providerRef), eq(s.paymentAttempt.orderId, a.orderId)))
    .returning();
  if (!row) throw new Error('stripe pre-mint attempt could not be bound');
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
  // PAYMENT-TIMING §5.2: a confirmed provider cancellation is a provider-terminal event. Release the
  // order's requested holds in this transaction (no-op unless the order is terminal and quiescent).
  if (status === 'cancelled') await releaseOnProviderTerminal(tx, { storeId: attempt.storeId, orderId: attempt.orderId });
}

/** PAYMENT-TIMING §5.4 / decision X-10: the age after which an unconfirmed PaymentIntent is cancelled at Stripe. */
export function paymentIntentDeadlineMin(): number {
  return env.PAYMENT_INTENT_DEADLINE_MIN ?? 60;
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
    // Order editing (G13): a Paid/PartiallyRefunded order with a positive amount
    // due (an edit raised the total) accepts a balance payment; with nothing
    // due it still falls through to the duplicate-capture handling below.
    const payable = order.state === 'PendingPayment' || order.state === 'Cancelled' || order.state === 'Paid' || order.state === 'PartiallyRefunded';
    const amountDue = payable ? await amountDueForOrder(tx, storeId, order.id, order.grandTotal) : 0;
    if (payable && amountDue > 0) {
      const result = verifyIntent(pi, { orderCode: code, amount: amountDue, currency: order.currency, stripeMode: mode });
      if (result.state === 'Settled') {
        const applied = await applyPaymentResult(tx, { storeId, order: { ...order, code }, method: 'stripe', result, amount: amountDue });
        const paid = await stripePaymentFor(tx, pi.id);
        await setAttempt(tx, attempt, 'settled', { paymentId: paid?.id, result: { state: 'Settled' } });
        if (order.state === 'Cancelled') {
          // D14: settle.ts writes the payment_after_cancel audit row and
          // enqueues the operator email for every gateway — nothing to add here.
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
    // Chokepoint operation `duplicate_capture_recorded` (payment.id): ledger row
    // only — eligible for no issuance or any other fulfilment effect.
    const dupId = randomUUID();
    const rec = await recordSettlementOperation(tx, {
      storeId, kind: 'duplicate_capture_recorded', operationId: dupId, effects: [],
      mutations: [{ type: 'payment_insert', rows: [{
        id: dupId, storeId, orderId: order.id, amount: pi.amount, method: 'stripe', providerRef: pi.id, state: 'Settled',
        gatewayMode: mode, currency: pi.currency.toUpperCase(),
        metadata: { duplicate: true, latest_charge: pi.latest_charge ?? null, gateway: { mode } },
        errorMessage: 'duplicate payment — order was already covered',
      }] }],
    });
    const dup = rec.created ? { id: dupId } : undefined;
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

  if (pi.status === 'requires_action') {
    await setAttempt(tx, attempt, 'action_required', { result: { status: pi.status } });
    return { outcome: 'action_required', orderState: order.state };
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
  discovery?: { found: number; modes: StripeMode[]; errors: string[] };
}

/**
 * D1: server-side settlement fallback. For a PendingPayment (or, MONEY-4,
 * Cancelled) order, retrieve every unresolved tracked PI from Stripe and apply
 * it. Stripe is called with no transaction open; each apply is a short tx
 * under the order's pay advisory lock.
 */
/**
 * Find PaymentIntents Stripe has for this order that we never tracked (PI
 * minted before intent tracking, or the attempt insert failed after Stripe
 * created it) and record them as intent attempts (idempotent on the PI id).
 * Runs Stripe Search in every mode this store has a usable secret key for,
 * with no DB transaction open. `errors` non-empty = discovery is incomplete:
 * callers must hold the order, never treat it as "no payment".
 */
export async function discoverStripeIntents(storeId: string, orderCode: string): Promise<{ found: number; modes: StripeMode[]; errors: string[] }> {
  const out = { found: 0, modes: [] as StripeMode[], errors: [] as string[] };
  for (const mode of ['test', 'live'] as StripeMode[]) {
    let configured = false;
    try { configured = await resolveStripeConfigured(storeId, mode); }
    catch (e) { out.errors.push(`${mode}: ${e instanceof Error ? e.message : 'credential lookup failed'}`); continue; }
    if (!configured) continue;
    out.modes.push(mode);
    let intents: IntentLike[];
    try { intents = await searchStripeIntentsForOrder(storeId, mode, orderCode); }
    catch (e) { out.errors.push(`${mode}: ${(e instanceof Error ? e.message : 'search failed').slice(0, 160)}`); continue; }
    if (!intents.length) continue;
    const recorded = await withStore(storeId, async (tx) => {
      const [order] = await tx.select({ id: s.order.id, currency: s.order.currency }).from(s.order).where(eq(s.order.code, orderCode)).limit(1);
      if (!order) return 0;
      let n = 0;
      for (const pi of intents) {
        const row = await trackStripeIntent(tx, storeId, { orderId: order.id, intentId: pi.id, amount: pi.amount, currency: order.currency, mode, source: 'discovery' });
        if (row.orderId === order.id) n++;
      }
      return n;
    });
    out.found += recorded;
  }
  return out;
}

/** Stripe is enabled for the store AND a usable key exists in some mode. */
export async function stripeDiscoverable(storeId: string, config: unknown): Promise<boolean> {
  if (!isPaymentMethodEnabled(config, 'stripe')) return false;
  for (const mode of ['test', 'live'] as StripeMode[]) {
    try { if (await resolveStripeConfigured(storeId, mode)) return true; } catch { return true; /* unknown → be safe: discover */ }
  }
  return false;
}

export async function reconcileStripeOrder(storeId: string, ref: { code: string } | { orderId: string }, opts: { actor?: string; discover?: boolean } = {}): Promise<ReconcileResult> {
  const load = () => withStore(storeId, async (tx) => {
    const [order] = await tx.select({ id: s.order.id, code: s.order.code, state: s.order.state }).from(s.order)
      .where('code' in ref ? eq(s.order.code, ref.code) : eq(s.order.id, ref.orderId)).limit(1);
    if (!order) return null;
    const attempts = await tx.select().from(s.paymentAttempt).where(and(
      eq(s.paymentAttempt.orderId, order.id), eq(s.paymentAttempt.operation, 'intent'),
      notInArray(s.paymentAttempt.status, ['settled', 'cancelled']),
    ));
    const [anyIntent] = await tx.select({ id: s.paymentAttempt.id }).from(s.paymentAttempt).where(and(
      eq(s.paymentAttempt.orderId, order.id), eq(s.paymentAttempt.operation, 'intent'))).limit(1);
    return { order, attempts, tracked: !!anyIntent };
  });
  let found = await load();
  if (!found) return { found: false, intents: [] };
  const out: ReconcileResult = { found: true, code: found.order.code, state: found.order.state, intents: [] };
  // Order editing (G13): a Paid/PartiallyRefunded order can have an open balance
  // payment (edit raised the total) — reconcile its unresolved intents too.
  if (!['PendingPayment', 'Cancelled', 'Paid', 'PartiallyRefunded'].includes(found.order.state)) return out;
  // Untracked order (PI minted before intent tracking, or a lost attempt
  // insert): ask Stripe which PIs exist for it, then reconcile those.
  if (opts.discover && !found.tracked) {
    const d = await discoverStripeIntents(storeId, found.order.code);
    out.discovery = d;
    if (d.found) found = (await load())!;
  }
  const { order, attempts } = found;
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
 * Resolve one tracked intent so its order can be (or stays) cancelled:
 * succeeded → settle (MONEY-4 on a Cancelled order); processing /
 * requires_capture → hold; anything else (incl. requires_action) → cancel the
 * PI at Stripe first. Stripe calls run with no transaction open; the apply
 * runs under the order's pay advisory lock.
 */
async function resolveIntentForCancel(storeId: string, code: string, intentId: string, mode: StripeMode, actor: string) {
  let pi: StripeIntent = await retrieveStripeIntent(storeId, mode, intentId);
  if (pi.status !== 'succeeded' && !HOLD_STATUSES.has(pi.status) && pi.status !== 'canceled') {
    pi = await cancelStripeIntent(storeId, mode, intentId);
  }
  return withAdvisoryLock(`pay:${storeId}:${code}`, () =>
    withStore(storeId, (tx) => applyStripeIntent(tx, storeId, pi, mode, { actor })));
}

/**
 * Order editing: retire every confirmable Stripe intent minted for the order
 * (its amount basis is about to change). Cancels each at Stripe and marks the
 * local attempt cancelled. Caller MUST hold the `pay:{storeId}:{code}` advisory
 * lock (the edit commit does; /payment-intent takes the same lock). An intent
 * that already succeeded/is processing cannot be cancelled: it is returned in
 * `captured` (never marked cancelled) so the caller can refuse the edit and
 * reconcile the money instead of silently stranding it.
 */
export async function cancelOpenIntentsForOrder(tx: Tx, storeId: string, orderId: string): Promise<{ cancelled: string[]; captured: string[] }> {
  const out = { cancelled: [] as string[], captured: [] as string[] };
  const attempts = await tx.select().from(s.paymentAttempt).where(and(
    eq(s.paymentAttempt.storeId, storeId), eq(s.paymentAttempt.orderId, orderId),
    eq(s.paymentAttempt.operation, 'intent'), eq(s.paymentAttempt.method, 'stripe'),
    inArray(s.paymentAttempt.status, [...SWEEPABLE_INTENT_STATUSES, 'processing']),
  )).for('update');
  for (const a of attempts) {
    if (!a.providerRef) continue;
    const pi = await cancelStripeIntent(storeId, asMode(a.mode), a.providerRef);
    if (pi.status === 'canceled') {
      await setAttempt(tx, a, 'cancelled', { result: { status: pi.status, retired: 'order_edit' } });
      out.cancelled.push(a.providerRef);
    } else {
      out.captured.push(a.providerRef);
    }
  }
  return out;
}

interface SweepRecovery { tries: number; nextAt?: string; lastError?: string; manual?: boolean }

/**
 * D5: before the stale sweeper cancels PendingPayment orders, resolve their
 * open Stripe intents at Stripe (see resolveIntentForCancel). Also sweeps open
 * intents left on already-Cancelled orders (e.g. an admin cancel whose
 * best-effort Stripe cancel failed). Oldest orders first; a failing intent
 * backs off (context.recovery) so it never starves newer ones, and after
 * STRIPE_SWEEP_MAX_TRIES it is flagged manual + raised as a payment alert. An
 * unresolved intent keeps its order out of the cancel claim.
 */
export async function sweepStaleStripeIntents(storeId: string, cutoff: Date, limit: number, log: (m: string) => void = () => {}, now = new Date()): Promise<{ checked: number; settled: number; held: number; cancelled: number; errors: number; flagged: number }> {
  const stats = { checked: 0, settled: 0, held: 0, cancelled: 0, errors: 0, flagged: 0 };
  const rows = await withStore(storeId, (tx) => tx.select({
    attempt: s.paymentAttempt, code: s.order.code, orderId: s.order.id,
  }).from(s.paymentAttempt).innerJoin(s.order, eq(s.order.id, s.paymentAttempt.orderId)).where(and(
    eq(s.paymentAttempt.operation, 'intent'), inArray(s.paymentAttempt.status, [...SWEEPABLE_INTENT_STATUSES]),
    or(and(eq(s.order.state, 'PendingPayment'), sql`${s.order.createdAt} < ${cutoff}`), eq(s.order.state, 'Cancelled')),
    sql`coalesce((${s.paymentAttempt.context}->'recovery'->>'manual')::boolean, false) = false`,
    sql`coalesce((${s.paymentAttempt.context}->'recovery'->>'nextAt')::timestamptz, '-infinity'::timestamptz) <= ${now}`,
  )).orderBy(asc(s.order.createdAt), asc(s.paymentAttempt.createdAt)).limit(limit));
  for (const { attempt, code, orderId } of rows) {
    if (!attempt.providerRef) continue;
    stats.checked++;
    const mode = asMode(attempt.mode);
    try {
      const applied = await resolveIntentForCancel(storeId, code, attempt.providerRef, mode, 'system:reservation-expiry');
      if (['settled', 'already_settled', 'after_cancel', 'duplicate', 'verify_failed'].includes(applied.outcome)) stats.settled++;
      else if (applied.outcome === 'held') stats.held++;
      else if (applied.outcome === 'cancelled') stats.cancelled++;
    } catch (e) {
      stats.errors++;
      const msg = (e instanceof Error ? e.message : 'error').slice(0, 200);
      log(`[release-stale] stripe intent ${attempt.providerRef} unresolved: ${msg}`);
      if (await recordIntentSweepFailure(storeId, { attempt, orderId, code, msg, now, actor: 'system:reservation-expiry' })) stats.flagged++;
    }
  }
  return stats;
}

/**
 * Sweeper failure bookkeeping (shared by the stale, balance and orphan sweeps): exponential backoff in
 * context.recovery, then manual after STRIPE_SWEEP_MAX_TRIES with a payment alert. Returns true when
 * the attempt was flagged manual by this call.
 */
async function recordIntentSweepFailure(storeId: string, a: { attempt: Attempt; orderId: string; code: string; msg: string; now: Date; actor: string }): Promise<boolean> {
  const prev = (a.attempt.context as { recovery?: SweepRecovery } | null)?.recovery;
  const tries = (prev?.tries ?? 0) + 1;
  const manual = tries >= STRIPE_SWEEP_MAX_TRIES;
  const next: SweepRecovery = { tries, lastError: a.msg, ...(manual ? { manual: true }
    : { nextAt: new Date(a.now.getTime() + recoveryBackoffMs(tries, STRIPE_SWEEP_BACKOFF_MIN)).toISOString() }) };
  let flagged = false;
  await withStore(storeId, async (tx) => {
    const updated = await tx.update(s.paymentAttempt).set({
      context: sql`coalesce(${s.paymentAttempt.context}, '{}'::jsonb) || jsonb_build_object('recovery', ${JSON.stringify(next)}::jsonb)`,
      updatedAt: new Date(),
    }).where(and(eq(s.paymentAttempt.id, a.attempt.id), inArray(s.paymentAttempt.status, [...SWEEPABLE_INTENT_STATUSES])))
      .returning({ id: s.paymentAttempt.id });
    if (manual && updated.length) {
      flagged = true;
      await recordPaymentAlert(tx, storeId, {
        kind: 'stripe_intent_unresolvable', actor: a.actor, orderId: a.orderId, orderCode: a.code,
        providerRef: a.attempt.providerRef, amount: a.attempt.amount, currency: a.attempt.currency,
        detail: `The sweeper could not resolve this Stripe PaymentIntent after ${tries} tries (${a.msg}). The order is held until it is reconciled.`,
        data: { tries },
      });
    }
  });
  return flagged;
}

/**
 * PAYMENT-TIMING §5.4 (G1): balance intents minted on Paid / PartiallyRefunded orders (routes/pay.ts)
 * older than the deadline are resolved at Stripe exactly like checkout intents: a succeeded PI settles,
 * a processing / requires_capture PI holds (never cancelled), anything else is cancelled at Stripe.
 * Failures back off and go manual after STRIPE_SWEEP_MAX_TRIES.
 */
export async function sweepStaleBalanceIntents(storeId: string, limit: number, log: (m: string) => void = () => {}, now = new Date(), deadlineMin = paymentIntentDeadlineMin()): Promise<{ checked: number; settled: number; held: number; cancelled: number; errors: number; flagged: number }> {
  const stats = { checked: 0, settled: 0, held: 0, cancelled: 0, errors: 0, flagged: 0 };
  const cutoff = new Date(now.getTime() - deadlineMin * 60_000);
  const rows = await withStore(storeId, (tx) => tx.select({
    attempt: s.paymentAttempt, code: s.order.code, orderId: s.order.id,
  }).from(s.paymentAttempt).innerJoin(s.order, eq(s.order.id, s.paymentAttempt.orderId)).where(and(
    eq(s.paymentAttempt.operation, 'intent'), inArray(s.paymentAttempt.status, [...SWEEPABLE_INTENT_STATUSES]),
    isNotNull(s.paymentAttempt.providerRef),
    inArray(s.order.state, ['Paid', 'PartiallyRefunded']),
    sql`${s.paymentAttempt.createdAt} < ${cutoff}`,
    sql`coalesce((${s.paymentAttempt.context}->'recovery'->>'manual')::boolean, false) = false`,
    sql`coalesce((${s.paymentAttempt.context}->'recovery'->>'nextAt')::timestamptz, '-infinity'::timestamptz) <= ${now}`,
  )).orderBy(asc(s.paymentAttempt.createdAt)).limit(limit));
  for (const { attempt, code, orderId } of rows) {
    if (!attempt.providerRef) continue;
    stats.checked++;
    try {
      const applied = await resolveIntentForCancel(storeId, code, attempt.providerRef, asMode(attempt.mode), 'system:balance-intent-sweep');
      if (['settled', 'already_settled', 'after_cancel', 'duplicate', 'verify_failed'].includes(applied.outcome)) stats.settled++;
      else if (applied.outcome === 'held') stats.held++;
      else if (applied.outcome === 'cancelled') stats.cancelled++;
    } catch (e) {
      stats.errors++;
      const msg = (e instanceof Error ? e.message : 'error').slice(0, 200);
      log(`[balance-intent] ${attempt.providerRef} unresolved: ${msg}`);
      if (await recordIntentSweepFailure(storeId, { attempt, orderId, code, msg, now, actor: 'system:balance-intent-sweep' })) stats.flagged++;
    }
  }
  return stats;
}

/**
 * PAYMENT-TIMING §4.2 / X-9: a pre-mint row (open, provider_ref NULL, key stripe-pi-pending:<mintKey>)
 * older than the deadline means the mint either never happened or its bind was lost. Search Stripe for
 * the order's PaymentIntent carrying this mint key (metadata.mintKey, set by createPaymentIntent):
 *   found             -> bind the row to that PI (bindStripePreMint); the tracked-intent sweeps take over
 *   clean search      -> the row is cancelled (no provider object exists) and the order's holds are released
 *                        if a release was requested
 *   untracked PI with no mint key matching the row's amount -> ambiguous: fail closed (backoff / manual)
 *   search error      -> backoff, then manual after STRIPE_SWEEP_MAX_TRIES
 */
export async function sweepOrphanPreMints(storeId: string, limit: number, log: (m: string) => void = () => {}, now = new Date(), deadlineMin = paymentIntentDeadlineMin()): Promise<{ checked: number; bound: number; cancelled: number; errors: number; flagged: number }> {
  const stats = { checked: 0, bound: 0, cancelled: 0, errors: 0, flagged: 0 };
  const cutoff = new Date(now.getTime() - deadlineMin * 60_000);
  const rows = await withStore(storeId, (tx) => tx.select({
    attempt: s.paymentAttempt, code: s.order.code, orderId: s.order.id,
  }).from(s.paymentAttempt).innerJoin(s.order, eq(s.order.id, s.paymentAttempt.orderId)).where(and(
    eq(s.paymentAttempt.operation, 'intent'), eq(s.paymentAttempt.method, 'stripe'),
    eq(s.paymentAttempt.status, 'open'), isNull(s.paymentAttempt.providerRef),
    sql`${s.paymentAttempt.createdAt} < ${cutoff}`,
    sql`coalesce((${s.paymentAttempt.context}->'recovery'->>'manual')::boolean, false) = false`,
    sql`coalesce((${s.paymentAttempt.context}->'recovery'->>'nextAt')::timestamptz, '-infinity'::timestamptz) <= ${now}`,
  )).orderBy(asc(s.paymentAttempt.createdAt)).limit(limit));
  for (const { attempt, code, orderId } of rows) {
    stats.checked++;
    const mintKey = attempt.idempotencyKey.startsWith('stripe-pi-pending:') ? attempt.idempotencyKey.slice('stripe-pi-pending:'.length) : null;
    if (!mintKey) { log(`[orphan-premint] ${attempt.id} has no mint key; skipped`); continue; }
    const mode = asMode(attempt.mode);
    try {
      const intents = await searchStripeIntentsForOrder(storeId, mode, code);
      const byKey = intents.find((pi) => (pi.metadata as Record<string, string> | null)?.mintKey === mintKey);
      if (byKey) {
        await withStore(storeId, (tx) => bindStripePreMint(tx, storeId, {
          pendingAttemptId: attempt.id, orderId, intentId: byKey.id, amount: attempt.amount, currency: attempt.currency, mode,
        }));
        stats.bound++;
        continue;
      }
      // An untracked PI on this order without a mint key (minted before keys were recorded) could be ours:
      // with the same amount, never cancel blindly.
      const legacy = intents.filter((pi) => !(pi.metadata as Record<string, string> | null)?.mintKey && pi.amount === attempt.amount);
      if (legacy.length) throw new Error(`untracked PaymentIntent ${legacy[0]!.id} without mint key may be this attempt`);
      await withStore(storeId, async (tx) => {
        await tx.update(s.paymentAttempt).set({
          status: 'cancelled', result: { orphan: 'no_intent_found', resolved_at: now.toISOString() }, updatedAt: now,
        }).where(and(eq(s.paymentAttempt.id, attempt.id), eq(s.paymentAttempt.status, 'open'), isNull(s.paymentAttempt.providerRef)));
        await releaseOnProviderTerminal(tx, { storeId, orderId });
      });
      stats.cancelled++;
    } catch (e) {
      stats.errors++;
      const msg = (e instanceof Error ? e.message : 'error').slice(0, 200);
      log(`[orphan-premint] ${attempt.id} unresolved: ${msg}`);
      if (await recordIntentSweepFailure(storeId, { attempt, orderId, code, msg, now, actor: 'system:reservation-expiry' })) stats.flagged++;
    }
  }
  return stats;
}

interface DiscoveryState { tries: number; nextAt?: string; lastError?: string; hold?: boolean; manual?: boolean; checkedAt?: string }

/**
 * Untracked-intent gap: before the stale sweeper may cancel a PendingPayment
 * order that has NO intent attempt on a Stripe-enabled store, search Stripe
 * for PIs bound to it. Found → recorded as intent attempts (the tracked-intent
 * sweep then settles / holds / cancels them). Search error → the order is held
 * (order.metadata.stripeDiscovery.hold, which the cancel claim honours) with
 * backoff, and after STRIPE_SWEEP_MAX_TRIES flagged + alerted. Never cancels
 * blindly.
 */
export async function discoverStaleUntrackedIntents(storeId: string, config: unknown, cutoff: Date, limit: number, log: (m: string) => void = () => {}, now = new Date()): Promise<{ checked: number; found: number; held: number; flagged: number }> {
  const stats = { checked: 0, found: 0, held: 0, flagged: 0 };
  if (!(await stripeDiscoverable(storeId, config))) return stats;
  const rows = await withStore(storeId, (tx) => tx.select({ id: s.order.id, code: s.order.code, metadata: s.order.metadata, grandTotal: s.order.grandTotal, currency: s.order.currency })
    .from(s.order).where(and(
      eq(s.order.state, 'PendingPayment'), sql`${s.order.createdAt} < ${cutoff}`,
      sql`NOT EXISTS (SELECT 1 FROM payment_attempt pa WHERE pa.order_id = ${s.order.id} AND pa.store_id = ${s.order.storeId} AND pa.operation = 'intent')`,
      sql`coalesce((${s.order.metadata}->'stripeDiscovery'->>'manual')::boolean, false) = false`,
      sql`coalesce((${s.order.metadata}->'stripeDiscovery'->>'nextAt')::timestamptz, '-infinity'::timestamptz) <= ${now}`,
      // Already searched clean → not again.
      sql`(${s.order.metadata}->'stripeDiscovery'->>'checkedAt') IS NULL`,
    )).orderBy(asc(s.order.createdAt)).limit(limit));
  for (const o of rows) {
    stats.checked++;
    const d = await discoverStripeIntents(storeId, o.code);
    stats.found += d.found;
    const prev = ((o.metadata as { stripeDiscovery?: DiscoveryState } | null)?.stripeDiscovery) ?? { tries: 0 };
    let next: DiscoveryState;
    let flag = false;
    if (d.errors.length && !d.found) {
      const tries = prev.tries + 1;
      flag = tries >= STRIPE_SWEEP_MAX_TRIES;
      next = { tries, hold: true, lastError: d.errors.join('; ').slice(0, 200),
        ...(flag ? { manual: true } : { nextAt: new Date(now.getTime() + recoveryBackoffMs(tries, STRIPE_SWEEP_BACKOFF_MIN)).toISOString() }) };
      stats.held++;
      log(`[release-stale] stripe discovery for ${o.code} failed: ${next.lastError}`);
    } else {
      next = { tries: prev.tries, hold: false, checkedAt: now.toISOString() };
    }
    await withStore(storeId, async (tx) => {
      await tx.update(s.order).set({
        metadata: sql`coalesce(${s.order.metadata}, '{}'::jsonb) || jsonb_build_object('stripeDiscovery', ${JSON.stringify(next)}::jsonb)`,
      }).where(eq(s.order.id, o.id));
      if (flag) {
        stats.flagged++;
        await recordPaymentAlert(tx, storeId, {
          kind: 'stripe_intent_unresolvable', actor: 'system:reservation-expiry', orderId: o.id, orderCode: o.code,
          providerRef: null, amount: o.grandTotal, currency: o.currency,
          detail: `Could not check Stripe for payments on this order after ${next.tries} tries (${next.lastError}). The order is held, not cancelled, until it is reconciled.`,
          data: { tries: next.tries, discovery: true },
        });
      }
    });
  }
  return stats;
}

/**
 * Admin cancel (single + bulk): after the cancel commits, cancel the order's
 * open/failed/action_required PIs at Stripe so the shopper can no longer pay
 * a cancelled order. Best-effort and audited; a failure leaves the intent
 * open for the sweeper (which also sweeps Cancelled orders). A PI that had
 * already succeeded lands through the MONEY-4 payment_after_cancel path.
 */
export async function cancelOrderStripeIntents(storeId: string, orderId: string, actor: string): Promise<void> {
  const rows = await withStore(storeId, (tx) => tx.select({ attempt: s.paymentAttempt, code: s.order.code })
    .from(s.paymentAttempt).innerJoin(s.order, eq(s.order.id, s.paymentAttempt.orderId)).where(and(
      eq(s.paymentAttempt.orderId, orderId), eq(s.paymentAttempt.operation, 'intent'),
      inArray(s.paymentAttempt.status, [...SWEEPABLE_INTENT_STATUSES]))));
  for (const { attempt, code } of rows) {
    if (!attempt.providerRef) continue;
    let outcome: string;
    try { outcome = (await resolveIntentForCancel(storeId, code, attempt.providerRef, asMode(attempt.mode), actor)).outcome; }
    catch (e) { outcome = 'error:' + (e instanceof Error ? e.message : 'unknown').slice(0, 120); }
    await withStore(storeId, (tx) => tx.insert(s.auditLog).values({
      storeId, actor, entity: 'payment_attempt', entityId: attempt.id,
      action: outcome === 'cancelled' ? 'stripe_intent_cancelled' : 'stripe_intent_cancel_attempted',
      data: { orderCode: code, providerRef: attempt.providerRef, outcome },
    })).catch(() => undefined);
  }
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
