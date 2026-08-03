/**
 * Reconcile Stripe events that happen OUTSIDE our app — dashboard-initiated
 * refunds and chargebacks — back into our ledger. Used by the inbound webhook.
 *
 * Tenant resolution: PaymentIntent-derived events carry storeId in metadata
 * (Stripe copies PI metadata onto the Charge at confirmation). Refund/Dispute
 * objects may not, so we fall back to the object's payment_intent looked up
 * against our payment ledger — an UNSCOPED read by necessity (we don't yet know
 * the tenant). This lives outside routes/ so the no-unscoped-db-in-routes rule
 * still holds for handler code.
 */
import { and, eq, sql } from 'drizzle-orm';
import { unsafeUnscopedDb, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import { emitEvent } from '../webhooks/emit.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const piId = (v: unknown): string | null => (typeof v === 'string' ? v : (v as { id?: string } | null)?.id ?? null);

export interface StripeEventObj {
  metadata?: { storeId?: string | null } | null;
  payment_intent?: string | { id?: string } | null;
}

/** Resolve the owning storeId for a Stripe event. Returns null if unresolvable
 *  (→ caller acks + ignores). UNSCOPED payment lookup is intentional here. */
export async function resolveStoreIdForStripeEvent(obj: StripeEventObj): Promise<string | null> {
  const meta = obj.metadata?.storeId;
  if (meta && UUID.test(meta)) return meta;
  const pi = piId(obj.payment_intent);
  if (!pi) return null;
  const [row] = await unsafeUnscopedDb.select({ storeId: s.payment.storeId }).from(s.payment).where(eq(s.payment.providerRef, pi)).limit(1);
  return row?.storeId && UUID.test(row.storeId) ? row.storeId : null;
}

/**
 * Tenant resolver for subscription / invoice events. DB-PRIMARY, not
 * metadata-dependent: the reliable anchor is OUR `subscription` row (linked by
 * `checkout.session.completed` from session metadata WE set on a session WE
 * created — no propagation assumption). Resolution order:
 *   1. obj.metadata.storeId      (checkout.session — always present, our metadata)
 *   2. our subscription row by stripeSubscriptionId = invoice.subscription
 *   3. obj.subscription_details.metadata.storeId  (bonus, if Stripe propagated it)
 * null → the caller returns 5xx so Stripe RETRIES (idempotency makes retry safe).
 * UNSCOPED read is intentional here (we don't yet know the tenant).
 */
export async function resolveStoreIdForSubscriptionEvent(obj: {
  metadata?: { storeId?: string | null } | null;
  subscription?: string | { id?: string } | null;
  subscription_details?: { metadata?: { storeId?: string | null } | null } | null;
}): Promise<string | null> {
  const m = obj.metadata?.storeId;
  if (m && UUID.test(m)) return m;
  const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id ?? null;
  if (subId) {
    const [row] = await unsafeUnscopedDb
      .select({ storeId: s.subscription.storeId })
      .from(s.subscription)
      .where(eq(s.subscription.stripeSubscriptionId, subId))
      .limit(1);
    if (row?.storeId && UUID.test(row.storeId)) return row.storeId;
  }
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

export interface RefundDescriptor { reId: string; amount: number; status: string; piId: string }

/** Idempotently record/update a Stripe refund (dashboard or API) in our ledger
 *  and recompute the order's refund state. Money-only — does NOT restock (no line
 *  data on a dashboard refund); inventory stays the admin's call via Returns. */
export async function reconcileStripeRefund(tx: Tx, storeId: string, r: RefundDescriptor): Promise<void> {
  const [pay] = await tx.select({ id: s.payment.id, orderId: s.payment.orderId })
    .from(s.payment).where(and(eq(s.payment.providerRef, r.piId), eq(s.payment.method, 'stripe'))).limit(1);
  if (!pay) {
    // FIX (unmatched refund silently dropped): Stripe does not guarantee
    // delivery order, so refund.* can arrive before payment_intent.succeeded —
    // the matching `payment` row doesn't exist YET, not never. The old code
    // silently `return`ed here and the caller still returned 200, but the
    // caller (routes/payment-webhooks.ts) claims the event id (INSERT INTO
    // processed_event) in the SAME `withStore` transaction as this call, so a
    // silent return left the event marked processed forever — the refund was
    // lost, with no retry and no record of it ever having arrived.
    //
    // Throwing instead: this function runs inside that same transaction, so
    // the throw rolls back the processed_event claim too (the event becomes
    // reprocessable) and the uncaught error propagates past the route's
    // `return c.json(...,200)` to app.onError, which answers non-2xx —
    // Stripe's own retry/backoff redelivers the event later, by which point
    // payment_intent.succeeded will normally have landed. This mirrors the
    // existing pattern for subscription events with an unresolved tenant
    // (payment-webhooks.ts: unresolved subscription store → 503 → retry)
    // rather than inventing a new outbox table for what is, in practice, a
    // transient ordering race that self-heals on redelivery.
    throw Object.assign(
      new Error(`refund ${r.reId} references payment_intent ${r.piId} with no matching payment row yet — retrying`),
      { kind: 'unmatched_refund' as const },
    );
  }
  const state = refundStateFromStripe(r.status);
  const [existing] = await tx.select({ id: s.refund.id, state: s.refund.state }).from(s.refund).where(eq(s.refund.providerRef, r.reId)).limit(1);
  if (existing) {
    if (existing.state !== state) await tx.update(s.refund).set({ state }).where(eq(s.refund.id, existing.id));
  } else {
    await tx.insert(s.refund).values({ storeId, paymentId: pay.id, orderId: pay.orderId, amount: r.amount, reason: 'stripe_dashboard', state, providerRef: r.reId });
    await tx.insert(s.auditLog).values({ storeId, actor: 'stripe:webhook', entity: 'order', entityId: pay.orderId, action: 'refund_reconciled', data: { refundId: r.reId, amount: r.amount, status: r.status } });
  }
  await recomputeOrderRefundState(tx, storeId, pay.orderId);
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

/** Record a chargeback for operator visibility. Deliberately does NOT auto-refund
 *  or cancel — disputes need human handling. */
export async function recordStripeDispute(tx: Tx, storeId: string, d: DisputeDescriptor): Promise<void> {
  let orderId: string | null = null;
  let code: string | null = null;
  if (d.piId) {
    const [pay] = await tx.select({ orderId: s.payment.orderId }).from(s.payment).where(eq(s.payment.providerRef, d.piId)).limit(1);
    orderId = pay?.orderId ?? null;
    if (orderId) {
      const [o] = await tx.select({ code: s.order.code }).from(s.order).where(eq(s.order.id, orderId)).limit(1);
      code = o?.code ?? null;
    }
  }
  await tx.insert(s.auditLog).values({ storeId, actor: 'stripe:webhook', entity: 'order', entityId: orderId ?? d.disputeId, action: 'dispute_opened', data: { disputeId: d.disputeId, amount: d.amount, reason: d.reason, status: d.status, orderCode: code } });
  if (orderId) await emitEvent(tx, storeId, 'order.dispute_opened', { code, disputeId: d.disputeId, amount: d.amount, reason: d.reason });
}
