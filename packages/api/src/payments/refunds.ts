import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { withAdvisoryLock, withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { resolveGatewayAccount, assertGatewayEnvironment, recordedNmiEnvironment } from './gateway-account.js';
import { getProvider, type RefundResult } from './provider.js';
import { creditGiftCardRefund } from '../routes/admin-order-payment-helpers.js';
import { emitEvent } from '../webhooks/emit.js';
import { enqueueRefundConfirmation, pickEmailAppKey } from '../email/dispatch.js';
import { normalizeEmail } from '../auth/email.js';
import { onStockChanged } from '../manifest/stock-hook.js';
import { reconcileRefundLoyalty } from '../loyalty/ledger.js';
import { isEditRefund } from './edit-refund.js';

export class RefundError extends Error {
  constructor(public status: 400 | 404 | 409 | 503, message: string) { super(message); }
}
type Line = { orderLineId: string; quantity: number; restock: boolean };
export interface RefundRequest {
  storeId: string; orderId: string; actor: string; idempotencyKey: string;
  paymentId?: string; amount?: number; lines?: Line[]; restock?: boolean;
  // ADMIN-ESSENTIALS: a separate shipping-refund amount, added on top of the
  // per-line items total when no explicit `amount` override is given. Stored
  // on its own ledger column (refund.shippingAmount) instead of being folded
  // into the opaque `adjustmentAmount` bucket, so the admin UI/API can show
  // "items X + shipping Y = total Z" instead of one lump sum.
  shippingAmount?: number;
  reason?: string; returnId?: string;
  /** Server-set provenance. 'order_edit' = difference refund from an admin order
   *  edit (G13): never accepted from a request body, so a typed reason can never
   *  change amount-due accounting or order state. */
  source?: 'order_edit';
}
export function refundQuantity(line: { quantity: number; metadata?: unknown }): number {
  const placed = (line.metadata as { vendure?: { placedQuantity?: number } } | null)?.vendure?.placedQuantity;
  return Math.max(line.quantity, Number.isSafeInteger(placed) ? placed! : 0);
}
function requestFingerprint(input: RefundRequest) {
  return createHash('sha256').update(JSON.stringify({
    orderId: input.orderId, paymentId: input.paymentId ?? null, amount: input.amount ?? null,
    lines: [...(input.lines ?? [])].sort((a,b) => a.orderLineId.localeCompare(b.orderLineId)),
    restock: !!input.restock, reason: input.reason ?? null, returnId: input.returnId ?? null,
    source: input.source ?? null,
  })).digest('hex');
}
async function refundView(tx: Tx, row: typeof s.refund.$inferSelect) {
  const [order] = await tx.select({ state: s.order.state }).from(s.order).where(eq(s.order.id, row.orderId));
  return { refundId: row.id, refundState: row.state, state: order!.state,
    refunded: row.state === 'Settled' ? row.amount : 0, pending: row.state === 'Pending' ? row.amount : 0 };
}

export async function requestRefund(input: RefundRequest) {
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new RefundError(400, 'A refund idempotency key is required');
  const key = 'refund:' + input.idempotencyKey, fingerprint = requestFingerprint(input);
  return withAdvisoryLock('refund:' + input.storeId + ':' + input.orderId, async () => {
    const prepared = await withStore(input.storeId, async tx => {
      const [order] = await tx.select().from(s.order).where(eq(s.order.id, input.orderId)).for('update');
      if (!order || order.deletedAt) throw new RefundError(404, 'Order not found');
      const [prior] = await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.idempotencyKey, key));
      if (prior) {
        if (prior.operation !== 'refund' || prior.orderId !== order.id || prior.fingerprint !== fingerprint) throw new RefundError(409, 'Idempotency key belongs to another refund');
        const [row] = await tx.select().from(s.refund).where(eq(s.refund.attemptId, prior.id));
        if (!row) throw new RefundError(409, 'Refund reservation requires reconciliation');
        return { existing: await refundView(tx, row) };
      }
      // A duplicate capture (D4) is refundable whatever the order's own state.
      const refundableState = ['Paid','PartiallyRefunded','Cancelled'].includes(order.state) ||
        (!!input.paymentId && order.state !== 'PendingPayment');
      if (!refundableState) throw new RefundError(409, 'Order is not refundable');
      const [rma] = input.returnId ? await tx.select().from(s.returnRequest)
        .where(and(eq(s.returnRequest.id, input.returnId), eq(s.returnRequest.orderId, order.id))).for('update') : [];
      if (input.returnId && (!rma || !['requested','approved','received'].includes(rma.status) || rma.refundId)) throw new RefundError(409, 'Return already resolved');
      const allPayments = await tx.select().from(s.payment).where(and(eq(s.payment.orderId, order.id), eq(s.payment.state, 'Settled'))).for('update');
      // D4: a duplicate capture (payment.metadata.duplicate) is money the order
      // never needed. It is refunded money-only (explicit paymentId): no lines,
      // no stock/qty effects, and it never counts toward the order's tenders.
      const payments = allPayments.filter(p => !isDuplicatePayment(p));
      const payment = input.paymentId ? allPayments.find(p => p.id === input.paymentId) : payments.length === 1 ? payments[0] : undefined;
      if (!payment) throw new RefundError(409, payments.length > 1 ? 'Select the payment to refund' : 'No settled payment to refund');
      const duplicate = isDuplicatePayment(payment);
      if (!duplicate && !['Paid','PartiallyRefunded','Cancelled'].includes(order.state)) throw new RefundError(409, 'Order is not refundable');
      if (duplicate && (input.lines?.length || input.returnId || input.restock || input.shippingAmount)) {
        throw new RefundError(409, 'A duplicate payment is refunded money-only (no lines, restock, return or shipping)');
      }
      if (!getProvider(payment.method)) throw new RefundError(409, 'Payment method does not support refunds');
      const mode = payment.gatewayMode;
      if (['nmi','sezzle','stripe'].includes(payment.method) && (mode !== 'test' && mode !== 'live')) throw new RefundError(409, 'Original payment mode is missing; reconcile it before refunding');
      if (payment.method === 'nmi' || payment.method === 'sezzle') {
        if (!payment.gatewayAccount) throw new RefundError(409, 'Original merchant account is missing');
        try {
          const account = await resolveGatewayAccount(input.storeId, payment.method, payment.gatewayAccount, mode as 'test'|'live');
          assertGatewayEnvironment(account, (payment.metadata as { gateway?: unknown } | null)?.gateway);
        }
        catch { throw new RefundError(503, 'Original merchant account is unavailable'); }
      }
      const refunds = await tx.select().from(s.refund).where(eq(s.refund.orderId, order.id));
      const reserved = refunds.filter(r => r.paymentId === payment.id && r.state !== 'Failed').reduce((n,r) => n + r.amount, 0);
      const available = payment.amount - reserved;
      const orderLines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, order.id)).for('update');
      const reservations = await tx.select({ lineId: s.refundLine.orderLineId, quantity: s.refundLine.quantity })
        .from(s.refundLine).innerJoin(s.refund, eq(s.refund.id, s.refundLine.refundId))
        .where(and(eq(s.refund.orderId, order.id), sql`${s.refund.state} <> 'Failed'`));
      const reservedQty = new Map<string, number>();
      for (const line of reservations) reservedQty.set(line.lineId, (reservedQty.get(line.lineId) ?? 0) + line.quantity);
      let lines = duplicate ? [] : input.lines ?? [];
      if (rma) lines = (await tx.select().from(s.returnLine).where(eq(s.returnLine.returnId, rma.id))).map(l => ({ orderLineId: l.orderLineId, quantity: l.quantity, restock: l.restock }));
      const explicitLines = lines.length > 0;
      if (!duplicate && !lines.length && (input.restock || input.amount == null || input.amount === available)) {
        if (payments.length > 1 || (input.amount != null && input.amount !== available)) throw new RefundError(409, 'Choose lines when restocking a partial refund');
        lines = orderLines.map(l => ({ orderLineId: l.id, quantity: refundQuantity(l) - (reservedQty.get(l.id) ?? 0), restock: !!input.restock })).filter(l => l.quantity > 0);
      }
      const ids = new Set<string>();
      const snapshots = lines.map(line => {
        const row = orderLines.find(l => l.id === line.orderLineId);
        if (!row || ids.has(line.orderLineId) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 ||
            line.quantity > refundQuantity(row) - (reservedQty.get(row.id) ?? 0)) throw new RefundError(409, 'Invalid or already reserved refund quantity');
        ids.add(line.orderLineId);
        // Current unit economics remain valid for still-refundable units after a source cancellation.
        const unit = row.quantity ? row.lineTotal / row.quantity : row.unitPrice;
        return { ...line, amount: Math.round(unit * line.quantity) };
      });
      const itemsAmount = snapshots.reduce((n,l) => n+l.amount,0);
      // A separate shipping-refund amount only makes sense alongside explicit
      // lines (a full/no-lines refund's `available` already IS the whole
      // remaining balance, shipping included — adding it again there would
      // double-count). Ignored (never silently added) outside that branch.
      const shippingAmount = explicitLines && Number.isSafeInteger(input.shippingAmount) && input.shippingAmount! > 0 ? input.shippingAmount! : 0;
      const amount = input.amount ?? (explicitLines ? itemsAmount + shippingAmount : available);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > available) throw new RefundError(409, 'Refund exceeds the payment balance');
      const attemptId = randomUUID(), refundId = randomUUID();
      await tx.insert(s.paymentAttempt).values({ id: attemptId, storeId: input.storeId, orderId: order.id, paymentId: payment.id,
        operation: 'refund', method: payment.method, accountId: payment.gatewayAccount ?? 'internal',
        mode: mode === 'test' ? 'test' : 'live', amount, currency: payment.currency ?? order.currency,
        idempotencyKey: key, fingerprint, context: { originalProviderRef: payment.providerRef, refundId, actor: input.actor, returnId: input.returnId ?? null,
          ...(payment.method === 'nmi' ? { nmiEnvironment: recordedNmiEnvironment((payment.metadata as { gateway?: unknown } | null)?.gateway, mode as 'test'|'live') } : {}) } });
      await tx.insert(s.refund).values({ id: refundId, storeId: input.storeId, orderId: order.id, paymentId: payment.id,
        attemptId, amount, itemsAmount, shippingAmount,
        adjustmentAmount: amount - itemsAmount - shippingAmount, state: 'Pending', reason: input.reason ?? rma?.reason ?? null,
        metadata: { actor: input.actor, returnId: input.returnId ?? null, effectsApplied: false, ...(input.source ? { source: input.source } : {}) } });
      for (const line of snapshots) await tx.insert(s.refundLine).values({ storeId: input.storeId, refundId, ...line });
      if (rma) await tx.update(s.returnRequest).set({ status: 'approved', refundId, updatedAt: new Date() }).where(eq(s.returnRequest.id, rma.id));
      return { attemptId, payment, amount, currency: payment.currency ?? order.currency };
    });
    if ('existing' in prepared) return prepared.existing!;
    const p = prepared.payment;
    let result: RefundResult;
    try {
      const gateway = p.method === 'nmi' || p.method === 'sezzle'
        ? await resolveGatewayAccount(input.storeId, p.method, p.gatewayAccount!, p.gatewayMode as 'test'|'live') : undefined;
      if (gateway) assertGatewayEnvironment(gateway, (p.metadata as { gateway?: unknown } | null)?.gateway);
      const provider = getProvider(p.method)!;
      result = provider.refundPayment ? await provider.refundPayment({
        providerRef: p.providerRef, amount: prepared.amount, currency: prepared.currency,
        stripeMode: p.gatewayMode as 'test'|'live', storeId: input.storeId, gateway, idempotencyKey: prepared.attemptId,
      }) : { state: 'Settled', providerRef: null };
    } catch { result = { state: 'Pending', providerRef: null, errorMessage: 'Refund requires reconciliation' }; }
    const finalized = await withStore(input.storeId, async tx => {
      const view = await finalizeRefund(tx, input.storeId, prepared.attemptId, result);
      const [store] = await tx.select({ slug: s.store.slug }).from(s.store).where(eq(s.store.id, input.storeId)).limit(1);
      return { view, storeSlug: store?.slug };
    });
    // finalizeRefund only ever touches stock.allocated/stock.onHand (unfulfilled
    // release + restock) once it reaches 'Settled' — call the zero-cache hook
    // AFTER this transaction has committed. A harmless superset: an idempotent
    // replay of an already-settled refund also lands here and re-triggers a
    // regeneration, which is safe (never wrong, just occasionally redundant).
    if (finalized.view.refundState === 'Settled' && finalized.storeSlug) onStockChanged(finalized.storeSlug);
    return finalized.view;
  });
}

/**
 * SR-04/PAR-03: enqueue the customer refund-confirmation email at DEFINITIVE
 * settlement. Shared by the request-path finalizer (finalizeRefund) and the
 * webhook reconcile path for provider-initiated refunds — both run inside the
 * settlement transaction so a rollback drops the email, and the per-refund
 * dedupeKey makes replayed/double settlement a no-op (migration 0057). Missing
 * recipient (guest order, no contact email) skips the send silently — the
 * ledger row + audit trail still commit.
 */
export async function enqueueRefundSettledEmail(
  tx: Tx, storeId: string, refundRow: { id: string; orderId: string; amount: number },
): Promise<void> {
  const [order] = await tx.select().from(s.order).where(eq(s.order.id, refundRow.orderId)).limit(1);
  const [store] = await tx.select({ name: s.store.name, currency: s.store.currency, config: s.store.config })
    .from(s.store).where(eq(s.store.id, storeId)).limit(1);
  if (!order || !store) return;
  const [customer] = order.customerId
    ? await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, order.customerId)).limit(1) : [];
  const contact = (order.metadata as { contact?: { email?: string } } | null)?.contact;
  const recipient = normalizeEmail(contact?.email || customer?.email || '');
  if (!recipient) return;
  const lines = await tx.select({ appKey: s.productVariant.appKey })
    .from(s.orderLine).leftJoin(s.productVariant, eq(s.productVariant.id, s.orderLine.variantId))
    .where(eq(s.orderLine.orderId, order.id));
  const [agg] = await tx.select({ total: sql<number>`coalesce(sum(${s.refund.amount}), 0)::int` })
    .from(s.refund).where(and(eq(s.refund.orderId, order.id), eq(s.refund.state, 'Settled')));
  await enqueueRefundConfirmation(tx, storeId,
    { name: store.name, currency: order.currency, appKey: pickEmailAppKey(lines.map((l) => l.appKey)), config: store.config },
    recipient,
    { code: order.code, amount: refundRow.amount, currency: order.currency,
      refundedTotal: agg?.total ?? refundRow.amount, grandTotal: order.grandTotal,
      dedupeKey: `refund_confirmation:${refundRow.id}` });
}

/** Transactional and monotonic: money, stock, RMA, audit and outbox commit together.
 *  THE shared finalizer (SR-04): the synchronous request path and the inbound
 *  webhook reconcile path both converge here, so stock/RMA/gift-card/order-state/
 *  audit/event/email effects run exactly once per refund attempt — whichever
 *  caller settles it first wins; later calls are observed no-ops. */
export async function finalizeRefund(tx: Tx, storeId: string, attemptId: string, result: RefundResult) {
  const [ref] = await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.id, attemptId));
  if (!ref || ref.operation !== 'refund') throw new RefundError(404, 'Refund attempt not found');
  const [order] = await tx.select().from(s.order).where(eq(s.order.id, ref.orderId)).for('update');
  const [attempt] = await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.id, attemptId)).for('update');
  const [refund] = await tx.select().from(s.refund).where(eq(s.refund.attemptId, attemptId)).for('update');
  if (!order || !attempt || !refund) throw new RefundError(409, 'Refund reservation is incomplete');
  // Already settled: never downgrade on a delayed/out-of-order status. A late
  // providerRef (e.g. internal tender reconciled by webhook) is still adopted.
  if (refund.state === 'Settled') {
    if (!refund.providerRef && result.providerRef) {
      await tx.update(s.refund).set({ providerRef: result.providerRef }).where(eq(s.refund.id, refund.id));
      await tx.update(s.paymentAttempt).set({ providerRef: result.providerRef, updatedAt: new Date() })
        .where(eq(s.paymentAttempt.id, attempt.id));
    }
    return refundView(tx, refund);
  }
  if (refund.providerRef && result.providerRef && refund.providerRef !== result.providerRef) throw new RefundError(409, 'Refund reference mismatch');
  if (refund.state === 'Failed' && result.state !== 'Settled') return refundView(tx, refund);
  const providerRef = result.providerRef ?? refund.providerRef;
  await tx.update(s.refund).set({ state: result.state, providerRef }).where(eq(s.refund.id, refund.id));
  // 'pending' vs 'unknown' tells operators whether a provider reference exists
  // at all: 'pending' = provider acknowledged a ref (awaiting settlement),
  // 'unknown' = the response was lost before any ref was persisted.
  await tx.update(s.paymentAttempt).set({ status: result.state === 'Settled' ? 'settled' : result.state === 'Failed' ? 'failed' : providerRef ? 'pending' : 'unknown',
    providerRef, result: { state: result.state }, updatedAt: new Date() }).where(eq(s.paymentAttempt.id, attempt.id));
  if (result.state !== 'Settled') return refundView(tx, { ...refund, state: result.state, providerRef });
  const details = refund.metadata as { actor?: string; returnId?: string | null } | null;
  const lines = await tx.select().from(s.refundLine).where(eq(s.refundLine.refundId, refund.id));
  for (const line of lines) {
    const [row] = await tx.select().from(s.orderLine).where(eq(s.orderLine.id, line.orderLineId)).for('update');
    if (!row || row.orderId !== order.id) throw new RefundError(409, 'Refund line is missing');
    const unfulfilled = Math.min(line.quantity, Math.max(0, row.quantity - row.fulfilledQty - row.cancelledQty));
    const returned = line.quantity - unfulfilled;
    await tx.update(s.orderLine).set({ refundedQty: sql`${s.orderLine.refundedQty} + ${line.quantity}`,
      cancelledQty: sql`${s.orderLine.cancelledQty} + ${unfulfilled}` }).where(eq(s.orderLine.id, row.id));
    if (row.variantId) {
      if (unfulfilled) await tx.update(s.stock).set({ allocated: sql`greatest(0, ${s.stock.allocated} - ${unfulfilled})` }).where(eq(s.stock.variantId, row.variantId));
      if (line.restock && returned) {
        await tx.update(s.stock).set({ onHand: sql`${s.stock.onHand} + ${returned}` }).where(eq(s.stock.variantId, row.variantId));
        await tx.insert(s.stockMovement).values({ storeId, variantId: row.variantId, delta: returned, reason: 'refund_restock', refOrderId: order.id, actor: details?.actor ?? null });
      }
    }
  }
  if (attempt.method === 'gift_card') await creditGiftCardRefund(tx, storeId, order.id, refund.amount);
  const [refundedPayment] = await tx.select().from(s.payment).where(eq(s.payment.id, refund.paymentId));
  if (refundedPayment && isDuplicatePayment(refundedPayment)) {
    // D4 money-only: returning a duplicate capture leaves the order, its
    // lines, stock, loyalty and licenses exactly as they were.
    await tx.update(s.refund).set({ metadata: { ...details, effectsApplied: true, duplicate: true } }).where(eq(s.refund.id, refund.id));
    await tx.insert(s.auditLog).values({ storeId, actor: details?.actor ?? 'gateway:reconciliation', entity: 'order', entityId: order.id,
      action: 'duplicate_payment_refunded', fromState: order.state, toState: order.state,
      data: { refundId: refund.id, paymentId: refundedPayment.id, amount: refund.amount, providerRef: refundedPayment.providerRef } });
    await enqueueRefundSettledEmail(tx, storeId, refund);
    return { refundId: refund.id, refundState: 'Settled' as const, state: order.state, refunded: refund.amount, pending: 0 };
  }
  const { captured, refunded } = await orderRefundBasis(tx, storeId, order.id);
  // LOYALTY-1: restore redeemed points and reverse earned points in
  // proportion to the money refunded so far (cumulative + idempotent per
  // refund; a reversal the balance can't cover is recorded as shortfall).
  // Skipped for an edit difference refund: the edit already posted its own earn
  // adjustment (order_edit_earn) and redeemed points stay as stored.
  if (!isEditRefund(refund.metadata)) await reconcileRefundLoyalty(tx, { storeId, orderId: order.id, refundId: refund.id, refunded, captured,
    actor: details?.actor ?? 'gateway:reconciliation' });
  if (captured > 0 && refunded >= captured) {
    const now = new Date();
    const licenses = await tx.update(s.license).set({ status: 'revoked', updatedAt: now })
      .where(and(eq(s.license.storeId, storeId), eq(s.license.orderId, order.id)))
      .returning({ id: s.license.id });
    // Keep device tombstones and invalidate pre-refund leases without bumping
    // generations again on an already-revoked/removed activation.
    if (licenses.length) await tx.update(s.licenseActivation).set({
      state: 'revoked', revokedAt: now, updatedAt: now,
      generation: sql`${s.licenseActivation.generation} + 1`,
    }).where(and(eq(s.licenseActivation.storeId, storeId),
      inArray(s.licenseActivation.licenseId, licenses.map(l => l.id)), eq(s.licenseActivation.state, 'active')));
  }
  // Order editing (G13): a refund that only hands back the difference of a
  // LOWERED edit total is not an item/return refund — the order keeps its state.
  // `null` = keep the current state (never writes a state value that could be 'Paid').
  const state: 'Cancelled' | 'Refunded' | 'PartiallyRefunded' | null = order.state === 'Cancelled' ? 'Cancelled'
    : isEditRefund(refund.metadata) && refunded < captured ? null
    : refunded >= captured ? 'Refunded' : 'PartiallyRefunded';
  await tx.update(s.order).set({ updatedAt: new Date(), ...(state ? { state } : {}) }).where(eq(s.order.id, order.id));
  if (details?.returnId) await tx.update(s.returnRequest).set({ status: 'refunded', refundId: refund.id, updatedAt: new Date() })
    .where(and(eq(s.returnRequest.id, details.returnId), eq(s.returnRequest.orderId, order.id)));
  await tx.update(s.refund).set({ metadata: { ...details, effectsApplied: true } }).where(eq(s.refund.id, refund.id));
  await tx.insert(s.auditLog).values({ storeId, actor: details?.actor ?? 'gateway:reconciliation', entity: 'order', entityId: order.id,
    action: 'refund', fromState: order.state, toState: state, data: { refundId: refund.id, amount: refund.amount } });
  await emitEvent(tx, storeId, 'order.refunded', { code: order.code, amount: refund.amount, state, refundId: refund.id });
  // PAR-03: definitive settlement — customer refund-confirmation email in the
  // same transaction, deduped by refund id (a replayed finalize can never
  // send twice; the early-return above already covered already-settled rows).
  await enqueueRefundSettledEmail(tx, storeId, refund);
  return { refundId: refund.id, refundState: 'Settled' as const, state, refunded: refund.amount, pending: 0 };
}

/** D4: a Stripe capture recorded as a duplicate of an already-covered order. */
export function isDuplicatePayment(p: { metadata: unknown }): boolean {
  return (p.metadata as { duplicate?: unknown } | null)?.duplicate === true;
}

/**
 * ONE refund-state calculation, shared by the refund finalizer and the
 * Stripe/Sezzle dashboard reconcilers. Duplicate captures (and their refunds)
 * are money-only and excluded; order-edit difference refunds are netted out of
 * `captured` (the edit already lowered grandTotal) and never count as `refunded`.
 * Order state is Refunded only when merchandise refunds cover the NET captured.
 */
export async function orderRefundBasis(tx: Tx, storeId: string, orderId: string): Promise<{ captured: number; refunded: number; editRefunded: number }> {
  const allRefunds = await tx.select().from(s.refund)
    .where(and(eq(s.refund.storeId, storeId), eq(s.refund.orderId, orderId), eq(s.refund.state, 'Settled')));
  const payments = (await tx.select().from(s.payment)
    .where(and(eq(s.payment.storeId, storeId), eq(s.payment.orderId, orderId), eq(s.payment.state, 'Settled'))))
    .filter(p => !isDuplicatePayment(p));
  const counted = new Set(payments.map(p => p.id));
  const refunds = allRefunds.filter(r => counted.has(r.paymentId));
  const editRefunded = refunds.filter(r => isEditRefund(r.metadata)).reduce((n, r) => n + r.amount, 0);
  const refunded = refunds.filter(r => !isEditRefund(r.metadata)).reduce((n, r) => n + r.amount, 0);
  return { captured: payments.reduce((n, p) => n + p.amount, 0) - editRefunded, refunded, editRefunded };
}

/** Order state implied by net-captured vs merchandise-refunded; null = nothing refunded. */
export function refundStateFromBasis(b: { captured: number; refunded: number }): 'Refunded' | 'PartiallyRefunded' | null {
  if (b.refunded <= 0) return null;
  return b.captured > 0 && b.refunded >= b.captured ? 'Refunded' : 'PartiallyRefunded';
}
