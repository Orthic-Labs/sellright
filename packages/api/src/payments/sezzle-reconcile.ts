/**
 * Sezzle out-of-band reconciliation (payments audit D15/D16).
 *
 *  - D15 resolveSezzleSessionAttempt: a webhook whose order uuid matches no
 *    attempt.providerRef (the session response was lost, so the attempt never
 *    stored its ref) falls back to the Sezzle `reference_id`, which IS our
 *    payment_attempt id (sent at session creation). The reference is read
 *    from the authoritative provider GET — never trusted from the webhook
 *    body alone — and bound once, with an audit row, exactly like the
 *    operator bind in routes/admin-gateway-payments.ts.
 *  - D16 reconcileSezzleRefunds: provider-side refunds (Sezzle dashboard, or a
 *    refund whose response we lost) converge on the ledger the same way the
 *    Stripe T15 path does: exact ref → unique unbound pending reservation
 *    (shared finalizeRefund, effects exactly once) → money-only "dashboard"
 *    refund row + order refund-state recompute + refund email.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withAdvisoryLock, withStore, type Tx } from '../db/client.js';
import { withLockedSet } from '../db/locks.js';
import * as s from '../db/schema.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import { emitEvent } from '../webhooks/emit.js';
import { resolveGatewayAccount, type GatewayMode } from './gateway-account.js';
import { sezzleProvider, type SezzleOrder } from './sezzle.js';
import { finalizeRefund, enqueueRefundSettledEmail, RefundError, orderRefundBasis, refundStateFromBasis } from './refunds.js';
import { releaseOnFullRefundInSet } from './reservation.js';
import { onStockChanged } from '../manifest/stock-hook.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Attempt = typeof s.paymentAttempt.$inferSelect;
type Fetcher = { getOrder(account: Awaited<ReturnType<typeof resolveGatewayAccount>>, ref: string): Promise<SezzleOrder> };

export interface SezzleEventRef {
  storeId: string; accountId: string; mode: string; providerRef: string;
}

/**
 * D15: find the session attempt for a Sezzle order uuid, falling back to the
 * provider's reference_id (== attempt id). Returns null when nothing can be
 * associated yet (the caller keeps the event pending). Throws on a conflicting
 * bind (the attempt already carries a DIFFERENT provider ref).
 */
export async function resolveSezzleSessionAttempt(
  ev: SezzleEventRef, provider: Fetcher = sezzleProvider,
): Promise<Attempt | null> {
  const scope = (tx: Tx) => tx.select().from(s.paymentAttempt).where(and(
    eq(s.paymentAttempt.method, 'sezzle'), eq(s.paymentAttempt.accountId, ev.accountId),
    eq(s.paymentAttempt.mode, ev.mode), eq(s.paymentAttempt.operation, 'session'),
    eq(s.paymentAttempt.providerRef, ev.providerRef),
  )).limit(1);
  const [direct] = await withStore(ev.storeId, scope);
  if (direct) return direct;
  if (ev.mode !== 'test' && ev.mode !== 'live') return null;
  // Authoritative read: the order's reference_id is what WE sent as the
  // attempt id. A webhook-body hint is never enough to bind money.
  const account = await resolveGatewayAccount(ev.storeId, 'sezzle', ev.accountId, ev.mode as GatewayMode);
  const order = await provider.getOrder(account, ev.providerRef);
  if (order.uuid !== ev.providerRef || !order.reference_id) return null;
  const reference = order.reference_id;
  return withStore(ev.storeId, async (tx) => {
    const [attempt] = await tx.select().from(s.paymentAttempt).where(and(
      eq(s.paymentAttempt.method, 'sezzle'), eq(s.paymentAttempt.accountId, ev.accountId),
      eq(s.paymentAttempt.mode, ev.mode), eq(s.paymentAttempt.operation, 'session'),
      UUID.test(reference)
        ? sql`(${s.paymentAttempt.id} = ${reference}::uuid OR ${s.paymentAttempt.context}->>'orderReference' = ${reference})`
        : sql`${s.paymentAttempt.context}->>'orderReference' = ${reference}`,
    )).limit(1).for('update');
    if (!attempt) return null;
    if (attempt.providerRef && attempt.providerRef !== ev.providerRef) {
      throw new Error('Sezzle reference belongs to an attempt bound to another order');
    }
    if (!attempt.providerRef) {
      await tx.update(s.paymentAttempt).set({ providerRef: ev.providerRef, updatedAt: new Date() })
        .where(eq(s.paymentAttempt.id, attempt.id));
      await tx.insert(s.auditLog).values({ storeId: ev.storeId, actor: 'system:gateway',
        entity: 'payment_attempt', entityId: attempt.id, action: 'bind_provider_reference',
        data: { providerRef: ev.providerRef, source: 'sezzle_reference_id' } });
      attempt.providerRef = ev.providerRef;
    }
    return attempt;
  });
}

export interface SezzleRefundReconcile { recorded: number; finalized: number; ambiguous: number }

/**
 * D16: bring every refund Sezzle reports for `orderUuid` into the ledger.
 * Idempotent: an already-Settled row for a provider refund uuid is a no-op.
 * Throws when the original payment row isn't recorded yet (caller retries).
 */
export async function reconcileSezzleRefunds(
  ev: SezzleEventRef, provider: Fetcher = sezzleProvider,
): Promise<SezzleRefundReconcile> {
  const [pay] = await withStore(ev.storeId, (tx) => tx.select().from(s.payment).where(and(
    eq(s.payment.providerRef, ev.providerRef), eq(s.payment.method, 'sezzle'),
    sql`coalesce(${s.payment.gatewayAccount}, ${ev.accountId}) = ${ev.accountId}`,
    sql`coalesce(${s.payment.gatewayMode}, ${ev.mode}) = ${ev.mode}`,
  )).limit(1));
  if (!pay) throw new Error('Sezzle payment is not recorded yet');
  if (ev.mode !== 'test' && ev.mode !== 'live') throw new Error('Invalid Sezzle mode');
  const account = await resolveGatewayAccount(ev.storeId, 'sezzle', ev.accountId, ev.mode as GatewayMode);
  const order = await provider.getOrder(account, ev.providerRef);
  if (order.uuid !== ev.providerRef) throw new Error('Sezzle order identity mismatch');
  const refunds = (order.authorization?.refunds ?? []).filter((r) =>
    typeof r?.uuid === 'string' && r.uuid && Number.isSafeInteger(r.amount?.amount_in_cents) &&
    r.amount.amount_in_cents > 0 && r.amount.currency === (pay.currency ?? r.amount.currency));
  const out: SezzleRefundReconcile = { recorded: 0, finalized: 0, ambiguous: 0 };
  let stockChanged = false;
  let storeSlug: string | undefined;
  // X-45: the refund loop records money Sezzle already moved, so its order set runs with mustCommit.
  await withAdvisoryLock('refund:' + ev.storeId + ':' + pay.orderId, () => withLockedSet(ev.storeId, { kind: 'order', orderId: pay.orderId }, async (tx) => {
    const [st] = await tx.select({ slug: s.store.slug }).from(s.store).where(eq(s.store.id, ev.storeId)).limit(1);
    storeSlug = st?.slug;
    for (const r of refunds) {
      const amount = r.amount.amount_in_cents;
      const [existing] = await tx.select().from(s.refund)
        .where(and(eq(s.refund.paymentId, pay.id), eq(s.refund.providerRef, r.uuid))).limit(1);
      if (existing) {
        if (existing.state === 'Settled') continue;
        if (existing.attemptId) {
          const view = await finalizeRefund(tx, ev.storeId, existing.attemptId, { state: 'Settled', providerRef: r.uuid });
          if (view.refundState === 'Settled') { stockChanged = true; out.finalized++; }
        } else {
          await tx.update(s.refund).set({ state: 'Settled' }).where(eq(s.refund.id, existing.id));
          await recomputeOrderRefundState(tx, ev.storeId, pay.orderId);
          await enqueueRefundSettledEmail(tx, ev.storeId, existing);
          out.recorded++;
        }
        continue;
      }
      const pendings = await tx.select({ attemptId: s.refund.attemptId, amount: s.refund.amount }).from(s.refund)
        .where(and(eq(s.refund.paymentId, pay.id), eq(s.refund.state, 'Pending'),
          isNull(s.refund.providerRef), sql`${s.refund.attemptId} IS NOT NULL`));
      const matching = pendings.filter((p) => p.amount === amount);
      if (matching.length > 1) { out.ambiguous++; continue; }
      if (matching.length === 1) {
        try {
          const view = await finalizeRefund(tx, ev.storeId, matching[0]!.attemptId!, { state: 'Settled', providerRef: r.uuid });
          if (view.refundState === 'Settled') { stockChanged = true; out.finalized++; }
        } catch (error) {
          if (error instanceof RefundError && error.status === 409) { out.ambiguous++; continue; }
          throw error;
        }
        continue;
      }
      // Provider-initiated refund (Sezzle dashboard) — money-only, no stock
      // effects (no line data), same as the Stripe dashboard path.
      const [inserted] = await tx.insert(s.refund).values({
        storeId: ev.storeId, paymentId: pay.id, orderId: pay.orderId, amount,
        reason: 'sezzle_dashboard', state: 'Settled', providerRef: r.uuid,
        metadata: { source: 'sezzle_reconcile' },
      }).onConflictDoNothing().returning();
      if (!inserted) continue;
      await tx.insert(s.auditLog).values({ storeId: ev.storeId, actor: 'sezzle:webhook', entity: 'order',
        entityId: pay.orderId, action: 'refund_reconciled', data: { refundId: r.uuid, amount, provider: 'sezzle' } });
      await recomputeOrderRefundState(tx, ev.storeId, pay.orderId);
      await enqueueRefundSettledEmail(tx, ev.storeId, inserted);
      out.recorded++;
    }
  }, { mustCommit: true }));
  // Zero-cache stock rule: only after the transaction committed.
  if (stockChanged && storeSlug) onStockChanged(storeSlug);
  return out;
}

async function recomputeOrderRefundState(tx: Tx, storeId: string, orderId: string): Promise<void> {
  const [ord] = await tx.select({ state: s.order.state, grandTotal: s.order.grandTotal, code: s.order.code })
    .from(s.order).where(eq(s.order.id, orderId)).limit(1).for('update');
  if (!ord) return;
  const basis = await orderRefundBasis(tx, storeId, orderId);
  const refunded = basis.refunded;
  const target = refundStateFromBasis(basis);
  if (!target) return;
  if (canTransition(ord.state as OrderState, target)) {
    await tx.update(s.order).set({ state: target, updatedAt: new Date() }).where(eq(s.order.id, orderId));
  }
  // PAYMENT-TIMING §3.3 R5 (R2-6): a full refund releases consumed holds that asked for it.
  if (target === 'Refunded') await releaseOnFullRefundInSet(tx, { storeId, orderId });
  await emitEvent(tx, storeId, 'order.refunded', { code: ord.code, amount: refunded, state: target, source: 'sezzle_dashboard' });
}
