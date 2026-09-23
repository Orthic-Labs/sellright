/**
 * Reconcile Stripe events that happen OUTSIDE our app — dashboard-initiated
 * refunds and chargebacks — back into our ledger. Used by the inbound webhook.
 *
 * Tenant resolution (SR-02): PaymentIntent-derived events may carry storeId in
 * metadata (Stripe copies PI metadata onto the Charge at confirmation). Every
 * other lookup goes through resolveStoreForGatewayEvent — the narrow
 * SECURITY DEFINER seam (migration 0053) that works under the RLS nonowner
 * role. This module never queries tenant tables unscoped: FORCE RLS would
 * return zero rows to the app role and the event would be silently dropped.
 *
 * Refund correlation (SR-04): a provider refund converges on the SAME durable
 * refund attempt the request path reserved — by metadata attempt id first,
 * then by a unique unbound pending reservation — and is finalized through
 * finalizeRefund so stock/RMA/gift-card/order-state/audit/event/email effects
 * execute exactly once. Dashboard-initiated refunds (no reservation) are
 * recorded money-only as before.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import { emitEvent } from '../webhooks/emit.js';
import { resolveStoreForGatewayEvent } from './tenant-resolution.js';
import { finalizeRefund, enqueueRefundSettledEmail, RefundError } from './refunds.js';
import { recordStripeDisputeAlert } from '../disputes/disputes.js';
import { STRIPE_REFUND_ATTEMPT_KEY } from './stripe.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const piId = (v: unknown): string | null => (typeof v === 'string' ? v : (v as { id?: string } | null)?.id ?? null);
const subIdOf = (v: unknown): string | null => (typeof v === 'string' ? v : (v as { id?: string } | null)?.id ?? null);

export interface StripeEventObj {
  id?: string;
  metadata?: { storeId?: string | null } | null;
  payment_intent?: string | { id?: string } | null;
}

/** Pre-resolution facts the caller can bind. For Stripe the only trustworthy
 *  pre-resolution binding is `mode` — the webhook secret that verified the
 *  signature IS the event's cryptographically-proven mode (a test-secret-
 *  signed event can never have moved live money). Stripe objects carry no
 *  usable account ref (payment.gatewayAccount is always NULL for stripe).
 *  Effect: a wrong-mode event can no longer resolve the other mode's payment
 *  row at all — resolution returns null → the route 503s instead of reaching
 *  the in-transaction mode check; fail closed, never a cross-mode guess. */
export interface ResolveBinding {
  mode?: 'test' | 'live' | null;
}

/** Resolve the owning storeId for a Stripe event. Returns null if unresolvable
 *  (→ caller answers 5xx so Stripe retries; the event must NOT be acked away).
 *  Signed metadata.storeId is a safe fast-path; the DB anchor goes through the
 *  tenant-resolution seam — the only RLS-safe cross-store lookup. */
export async function resolveStoreIdForStripeEvent(
  obj: StripeEventObj,
  binding?: ResolveBinding,
): Promise<string | null> {
  const meta = obj.metadata?.storeId;
  if (meta && UUID.test(meta)) return meta;
  // payment_intent.* events: the object IS the intent (id is pi_...). Refund/
  // charge/dispute objects instead carry payment_intent as a field.
  const paymentRef = piId(obj.payment_intent) ??
    (typeof obj.id === 'string' && obj.id.startsWith('pi_') ? obj.id : null);
  const resolved = await resolveStoreForGatewayEvent('stripe', {
    paymentRef,
    mode: binding?.mode ?? null,
  });
  return resolved?.storeId ?? null;
}

/**
 * Tenant resolver for subscription / invoice events. DB-PRIMARY via the seam,
 * not metadata-dependent: the reliable anchor is OUR `subscription` row
 * (linked by `checkout.session.completed` from session metadata WE set) or an
 * already-recorded payment row for the invoice's payment_intent. Resolution
 * order:
 *   1. obj.metadata.storeId      (checkout.session — always present, our metadata)
 *   2. seam: subscription row by stripeSubscriptionId, then payment by PI ref
 *   3. obj.subscription_details.metadata.storeId  (bonus, if Stripe propagated it)
 * null → the caller returns 5xx so Stripe RETRIES (idempotency makes retry safe).
 */
export async function resolveStoreIdForSubscriptionEvent(obj: {
  id?: string;
  metadata?: { storeId?: string | null } | null;
  subscription?: string | { id?: string } | null;
  payment_intent?: string | { id?: string } | null;
  subscription_details?: { metadata?: { storeId?: string | null } | null } | null;
}, binding?: ResolveBinding): Promise<string | null> {
  const m = obj.metadata?.storeId;
  if (m && UUID.test(m)) return m;
  // customer.subscription.* events: the object IS the subscription (id is sub_...).
  const subscriptionRef = subIdOf(obj.subscription) ??
    (typeof obj.id === 'string' && obj.id.startsWith('sub_') ? obj.id : null);
  const resolved = await resolveStoreForGatewayEvent('stripe', {
    subscriptionRef,
    paymentRef: piId(obj.payment_intent),
    mode: binding?.mode ?? null,
  });
  if (resolved) return resolved.storeId;
  const sm = obj.subscription_details?.metadata?.storeId;
  return sm && UUID.test(sm) ? sm : null;
}

export const refundStateFromStripe = (status: string): 'Settled' | 'Pending' | 'Failed' =>
  status === 'succeeded' ? 'Settled' : status === 'pending' ? 'Pending' : 'Failed';

/** Order state implied by total settled refunds vs the order total. null = no
 *  transition (nothing settled yet). Pure — money-critical, so it's unit-tested. */
export function refundTargetState(refundedTotal: number, grandTotal: number): OrderState | null {
  if (refundedTotal <= 0) return null;
  return refundedTotal >= grandTotal ? 'Refunded' : 'PartiallyRefunded';
}

export interface RefundDescriptor {
  reId: string;
  amount: number;
  status: string;
  piId: string;
  /** Our payment_attempt id when the provider refund carries our stamped
   *  metadata (api-initiated refunds; see STRIPE_REFUND_ATTEMPT_KEY). */
  attemptId?: string | null;
}
export interface ReconcileOpts {
  /** The webhook signature's verified mode — recorded on quarantine rows. */
  mode?: 'test' | 'live';
}

/** Durable, operator-visible quarantine for a refund event we cannot bind
 *  safely. The row surfaces on GET /v1/admin/payment-reconciliation (status
 *  'manual'); eventId is stable per provider refund so retries dedupe. */
async function quarantineRefundEvent(
  tx: Tx, storeId: string, r: RefundDescriptor, reason: string,
  pay: { gatewayAccount: string | null; gatewayMode: string | null }, opts?: ReconcileOpts,
): Promise<void> {
  const mode = pay.gatewayMode === 'test' || pay.gatewayMode === 'live' ? pay.gatewayMode : opts?.mode ?? 'test';
  await tx.insert(s.gatewayEvent).values({
    storeId, method: 'stripe', accountId: pay.gatewayAccount ?? 'stripe', mode,
    eventId: `stripe_refund:${r.reId}`, eventType: 'refund.reconcile',
    providerRef: r.reId, status: 'manual',
    details: { reason, amount: r.amount, status: r.status, paymentIntent: r.piId, attemptId: r.attemptId ?? null, receivedAt: new Date().toISOString() },
    lastError: reason,
  }).onConflictDoNothing();
  await tx.insert(s.auditLog).values({
    storeId, actor: 'stripe:webhook', entity: 'refund', entityId: r.reId,
    action: 'refund_reconcile_quarantined',
    data: { reason, amount: r.amount, status: r.status, paymentIntent: r.piId, attemptId: r.attemptId ?? null },
  });
}

/**
 * Idempotently record/update a Stripe refund (dashboard or API) in our ledger
 * and recompute the order's refund state.
 *
 * Correlation order (SR-04):
 *   1. refund.provider_ref = reId          → known refund; attempt-bound rows
 *      finalize through finalizeRefund (shared monotonic finalizer — effects
 *      run once); unbound rows apply a monotonic state update.
 *   2. refund.attempt_id = metadata stamp  → the provider refund our request
 *      path created but whose response was lost before provider_ref persisted.
 *      finalizeRefund binds reId and applies the reserved effects.
 *   3. exactly ONE pending reservation on the payment matches by amount and is
 *      still unbound (providerRef IS NULL) → same finalize path. Several
 *      matches → quarantine for an operator rather than guess (a wrong bind
 *      would apply another refund's stock/RMA effects — irreversible).
 *   4. otherwise → a provider-side refund we never requested: record a
 *      money-only dashboard refund row (no stock effects — no line data).
 */
/**
 * Zero-cache stock rule: `tx` is supplied by the CALLER (routes/payment-webhooks.ts,
 * inside its own webhook-claim transaction) — this function never owns a
 * transaction boundary itself, so it must never call the manifest hook
 * directly (the caller's txn could still roll back after this returns, e.g.
 * on a downstream error). Instead it reports whether a stock-affecting
 * settlement happened via the returned `stockChanged` flag; the caller MUST
 * call `onStockChanged(storeSlug)` (from `../manifest/stock-hook.js`) right
 * after ITS transaction commits when this returns `stockChanged: true`. Only
 * the `finalizeAttempt` branches below can ever set it — the money-only
 * dashboard-refund paths (no line data) never touch `stock`.
 */
export async function reconcileStripeRefund(
  tx: Tx, storeId: string, r: RefundDescriptor, opts?: ReconcileOpts,
): Promise<{ stockChanged: boolean }> {
  const [pay] = await tx.select({ id: s.payment.id, orderId: s.payment.orderId,
    gatewayAccount: s.payment.gatewayAccount, gatewayMode: s.payment.gatewayMode })
    .from(s.payment).where(and(eq(s.payment.providerRef, r.piId), eq(s.payment.method, 'stripe')))
    .limit(1).for('update');
  if (!pay) {
    // Stripe does not guarantee delivery order, so refund.* can arrive before
    // payment_intent.succeeded — the matching `payment` row doesn't exist YET,
    // not never. Throwing rolls back the caller's processed_event claim, so the
    // route answers non-2xx and Stripe redelivers (self-healing on retry).
    throw Object.assign(
      new Error(`refund ${r.reId} references payment_intent ${r.piId} with no matching payment row yet — retrying`),
      { kind: 'unmatched_refund' as const },
    );
  }
  const state = refundStateFromStripe(r.status);
  const finalizeAttempt = async (attemptId: string): Promise<{ stockChanged: boolean }> => {
    try {
      const view = await finalizeRefund(tx, storeId, attemptId, { state, providerRef: r.reId });
      return { stockChanged: view.refundState === 'Settled' };
    } catch (err) {
      // Permanent binding conflicts (wrong ref family, corrupt reservation)
      // cannot self-heal — quarantine for an operator instead of 5xx-looping
      // the webhook forever. Transient 404s (row not visible yet) rethrow.
      if (err instanceof RefundError && err.status === 409) {
        await quarantineRefundEvent(tx, storeId, r, err.message, pay, opts);
        return { stockChanged: false };
      }
      throw err;
    }
  };

  // 1) Exact provider-ref dedupe — idempotent + out-of-order safe.
  const [existing] = await tx.select().from(s.refund)
    .where(and(eq(s.refund.providerRef, r.reId), eq(s.refund.paymentId, pay.id))).limit(1);
  if (existing) {
    if (existing.attemptId) return finalizeAttempt(existing.attemptId);
    // Unbound (dashboard-recorded) row: monotonic update — never downgrade a
    // settled refund on a delayed 'pending'/'failed' status.
    if (existing.state !== 'Settled' && existing.state !== state) {
      await tx.update(s.refund).set({ state }).where(eq(s.refund.id, existing.id));
      if (state === 'Settled') {
        await recomputeOrderRefundState(tx, storeId, pay.orderId);
        await enqueueRefundSettledEmail(tx, storeId, existing);
      }
    }
    return { stockChanged: false };
  }

  // 2) Attempt-bound correlation via the stamped provider metadata.
  const attemptId = r.attemptId && UUID.test(r.attemptId) ? r.attemptId : null;
  if (attemptId) {
    const [bound] = await tx.select({ id: s.refund.id }).from(s.refund)
      .where(and(eq(s.refund.attemptId, attemptId), eq(s.refund.paymentId, pay.id))).limit(1);
    if (bound) return finalizeAttempt(attemptId);
    // A stamped attempt id that resolves to no reservation on THIS payment is
    // a foreign/leftover refund — the stamp is authoritative, so it must NOT
    // fall through to amount-matching (that could hijack this payment's own
    // unbound reservation). It records as a provider-initiated refund below.
  } else {
    // 3) Correlate to a unique unbound pending reservation (timeout-after-
    //    acceptance on a pre-metadata refund, or an operator-bound attempt).
    const pendings = await tx.select({ id: s.refund.id, attemptId: s.refund.attemptId, amount: s.refund.amount })
      .from(s.refund)
      .where(and(eq(s.refund.paymentId, pay.id), eq(s.refund.state, 'Pending'),
        isNull(s.refund.providerRef), sql`${s.refund.attemptId} IS NOT NULL`));
    const matching = pendings.filter((p) => p.amount === r.amount);
    if (matching.length === 1) return finalizeAttempt(matching[0]!.attemptId!);
    if (matching.length > 1) {
      await quarantineRefundEvent(tx, storeId, r, 'ambiguous_pending_reservations', pay, opts);
      return { stockChanged: false };
    }
  }

  // 4) Provider-initiated refund (dashboard/API outside our flow) — money-only.
  const [inserted] = await tx.insert(s.refund).values({
    storeId, paymentId: pay.id, orderId: pay.orderId, amount: r.amount,
    reason: 'stripe_dashboard', state, providerRef: r.reId,
    metadata: { source: 'stripe_reconcile' },
  }).onConflictDoNothing().returning();
  if (inserted) {
    await tx.insert(s.auditLog).values({ storeId, actor: 'stripe:webhook', entity: 'order', entityId: pay.orderId,
      action: 'refund_reconciled', data: { refundId: r.reId, amount: r.amount, status: r.status } });
    if (state === 'Settled') {
      await recomputeOrderRefundState(tx, storeId, pay.orderId);
      await enqueueRefundSettledEmail(tx, storeId, inserted);
    }
    return { stockChanged: false };
  }
  // Lost a concurrent-insert race on (store_id, payment_id, provider_ref) —
  // apply the monotonic update to the winner's row instead.
  const [winner] = await tx.select().from(s.refund)
    .where(and(eq(s.refund.providerRef, r.reId), eq(s.refund.paymentId, pay.id))).limit(1);
  if (winner) {
    if (winner.attemptId) return finalizeAttempt(winner.attemptId);
    if (winner.state !== 'Settled' && winner.state !== state) {
      await tx.update(s.refund).set({ state }).where(eq(s.refund.id, winner.id));
      if (state === 'Settled') {
        await recomputeOrderRefundState(tx, storeId, pay.orderId);
        await enqueueRefundSettledEmail(tx, storeId, winner);
      }
    }
  }
  return { stockChanged: false };
}

async function recomputeOrderRefundState(tx: Tx, storeId: string, orderId: string): Promise<void> {
  const [ord] = await tx.select({ state: s.order.state, grandTotal: s.order.grandTotal, code: s.order.code }).from(s.order).where(eq(s.order.id, orderId)).limit(1);
  if (!ord) return;
  const [agg] = await tx.select({ total: sql<number>`coalesce(sum(${s.refund.amount}), 0)::int` })
    .from(s.refund).where(and(eq(s.refund.orderId, orderId), eq(s.refund.state, 'Settled')));
  const refunded = agg?.total ?? 0;
  const target = refundTargetState(refunded, ord.grandTotal);
  if (!target) return; // nothing settled yet — no state write, no event
  // FIX (second partial refund suppresses order.refunded): the FSM has no
  // PartiallyRefunded->PartiallyRefunded self-edge (canTransition(X, X) is
  // deliberately false for every state), so a SECOND still-partial dashboard
  // refund computes target === ord.state and the old combined guard
  // (`!target || !canTransition(...)`) skipped BOTH the (correctly a no-op)
  // state write AND the event emission — downstream email/analytics/sync
  // never learned the ledger row was recorded. Emit for every refund that
  // reconcileStripeRefund actually recorded; only gate the state WRITE on
  // canTransition (writing a state the order is already in would be a
  // meaningless no-op update, not an error).
  if (canTransition(ord.state as OrderState, target)) {
    await tx.update(s.order).set({ state: target, updatedAt: new Date() }).where(eq(s.order.id, orderId));
  }
  await emitEvent(tx, storeId, 'order.refunded', { code: ord.code, amount: refunded, state: target, source: 'stripe_dashboard' });
}

export interface DisputeDescriptor { disputeId: string; amount: number; reason: string; status: string; piId: string | null }

/** Record a chargeback for operator visibility. Deliberately does NOT
 *  auto-refund or cancel — disputes need human handling. Delegates to the
 *  canonical dispute record (disputes lane seam): durable dispute row +
 *  audit + order.dispute_opened event + operator email, all idempotent on
 *  (store, provider, disputeId) so provider retries are no-ops. */
export async function recordStripeDispute(tx: Tx, storeId: string, d: DisputeDescriptor): Promise<void> {
  await recordStripeDisputeAlert(tx, storeId, d);
}

export { STRIPE_REFUND_ATTEMPT_KEY };
