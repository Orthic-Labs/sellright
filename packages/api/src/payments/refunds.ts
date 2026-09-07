import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { withAdvisoryLock, withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { gatewayAccount } from './gateway-account.js';
import { getProvider, type RefundResult } from './provider.js';
import { creditGiftCardRefund } from '../routes/admin-order-payment-helpers.js';
import { emitEvent } from '../webhooks/emit.js';

export class RefundError extends Error {
  constructor(public status: 400 | 404 | 409 | 503, message: string) { super(message); }
}
type Line = { orderLineId: string; quantity: number; restock: boolean };
export interface RefundRequest {
  storeId: string; orderId: string; actor: string; idempotencyKey: string;
  paymentId?: string; amount?: number; lines?: Line[]; restock?: boolean;
  reason?: string; returnId?: string;
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
      if (!['Paid','PartiallyRefunded','Cancelled'].includes(order.state)) throw new RefundError(409, 'Order is not refundable');
      const [rma] = input.returnId ? await tx.select().from(s.returnRequest)
        .where(and(eq(s.returnRequest.id, input.returnId), eq(s.returnRequest.orderId, order.id))).for('update') : [];
      if (input.returnId && (!rma || !['requested','approved','received'].includes(rma.status) || rma.refundId)) throw new RefundError(409, 'Return already resolved');
      const payments = await tx.select().from(s.payment).where(and(eq(s.payment.orderId, order.id), eq(s.payment.state, 'Settled'))).for('update');
      const payment = input.paymentId ? payments.find(p => p.id === input.paymentId) : payments.length === 1 ? payments[0] : undefined;
      if (!payment) throw new RefundError(409, payments.length > 1 ? 'Select the payment to refund' : 'No settled payment to refund');
      if (!getProvider(payment.method)) throw new RefundError(409, 'Payment method does not support refunds');
      const mode = payment.gatewayMode;
      if (['nmi','sezzle','stripe'].includes(payment.method) && (mode !== 'test' && mode !== 'live')) throw new RefundError(409, 'Original payment mode is missing; reconcile it before refunding');
      if (payment.method === 'nmi' || payment.method === 'sezzle') {
        if (!payment.gatewayAccount) throw new RefundError(409, 'Original merchant account is missing');
        try { gatewayAccount(input.storeId, payment.method, payment.gatewayAccount, mode as 'test'|'live'); }
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
      let lines = input.lines ?? [];
      if (rma) lines = (await tx.select().from(s.returnLine).where(eq(s.returnLine.returnId, rma.id))).map(l => ({ orderLineId: l.orderLineId, quantity: l.quantity, restock: l.restock }));
      const explicitLines = lines.length > 0;
      if (!lines.length && (input.restock || input.amount == null || input.amount === available)) {
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
      const amount = input.amount ?? (explicitLines ? snapshots.reduce((n,l) => n+l.amount,0) : available);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > available) throw new RefundError(409, 'Refund exceeds the payment balance');
      const attemptId = randomUUID(), refundId = randomUUID();
      await tx.insert(s.paymentAttempt).values({ id: attemptId, storeId: input.storeId, orderId: order.id, paymentId: payment.id,
        operation: 'refund', method: payment.method, accountId: payment.gatewayAccount ?? 'internal',
        mode: mode === 'test' ? 'test' : 'live', amount, currency: payment.currency ?? order.currency,
        idempotencyKey: key, fingerprint, context: { originalProviderRef: payment.providerRef, refundId, actor: input.actor, returnId: input.returnId ?? null } });
      await tx.insert(s.refund).values({ id: refundId, storeId: input.storeId, orderId: order.id, paymentId: payment.id,
        attemptId, amount, itemsAmount: snapshots.reduce((n,l) => n+l.amount,0), shippingAmount: 0,
        adjustmentAmount: amount - snapshots.reduce((n,l) => n+l.amount,0), state: 'Pending', reason: input.reason ?? rma?.reason ?? null,
        metadata: { actor: input.actor, returnId: input.returnId ?? null, effectsApplied: false } });
      for (const line of snapshots) await tx.insert(s.refundLine).values({ storeId: input.storeId, refundId, ...line });
      if (rma) await tx.update(s.returnRequest).set({ status: 'approved', refundId, updatedAt: new Date() }).where(eq(s.returnRequest.id, rma.id));
      return { attemptId, payment, amount, currency: payment.currency ?? order.currency };
    });
    if ('existing' in prepared) return prepared.existing!;
    const p = prepared.payment;
    let result: RefundResult;
    try {
      const gateway = p.method === 'nmi' || p.method === 'sezzle'
        ? gatewayAccount(input.storeId, p.method, p.gatewayAccount!, p.gatewayMode as 'test'|'live') : undefined;
      const provider = getProvider(p.method)!;
      result = provider.refundPayment ? await provider.refundPayment({
        providerRef: p.providerRef, amount: prepared.amount, currency: prepared.currency,
        stripeMode: p.gatewayMode as 'test'|'live', gateway, idempotencyKey: prepared.attemptId,
      }) : { state: 'Settled', providerRef: null };
    } catch { result = { state: 'Pending', providerRef: null, errorMessage: 'Refund requires reconciliation' }; }
    return withStore(input.storeId, tx => finalizeRefund(tx, input.storeId, prepared.attemptId, result));
  });
}

/** Transactional and monotonic: money, stock, RMA, audit and outbox commit together. */
export async function finalizeRefund(tx: Tx, storeId: string, attemptId: string, result: RefundResult) {
  const [ref] = await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.id, attemptId));
  if (!ref || ref.operation !== 'refund') throw new RefundError(404, 'Refund attempt not found');
  const [order] = await tx.select().from(s.order).where(eq(s.order.id, ref.orderId)).for('update');
  const [attempt] = await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.id, attemptId)).for('update');
  const [refund] = await tx.select().from(s.refund).where(eq(s.refund.attemptId, attemptId)).for('update');
  if (!order || !attempt || !refund) throw new RefundError(409, 'Refund reservation is incomplete');
  if (refund.state === 'Settled') return refundView(tx, refund);
  if (refund.providerRef && result.providerRef && refund.providerRef !== result.providerRef) throw new RefundError(409, 'Refund reference mismatch');
  if (refund.state === 'Failed' && result.state !== 'Settled') return refundView(tx, refund);
  const providerRef = result.providerRef ?? refund.providerRef;
  await tx.update(s.refund).set({ state: result.state, providerRef }).where(eq(s.refund.id, refund.id));
  await tx.update(s.paymentAttempt).set({ status: result.state === 'Settled' ? 'settled' : result.state === 'Failed' ? 'failed' : 'unknown',
    providerRef, result: { state: result.state }, updatedAt: new Date() }).where(eq(s.paymentAttempt.id, attempt.id));
  if (result.state !== 'Settled') return refundView(tx, { ...refund, state: result.state });
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
        await tx.insert(s.stockMovement).values({ storeId, variantId: row.variantId, delta: returned, reason: 'refund_restock', refOrderId: order.id });
      }
    }
  }
  if (attempt.method === 'gift_card') await creditGiftCardRefund(tx, storeId, order.id, refund.amount);
  const refunds = await tx.select().from(s.refund).where(and(eq(s.refund.orderId, order.id), eq(s.refund.state, 'Settled')));
  const payments = await tx.select().from(s.payment).where(and(eq(s.payment.orderId, order.id), eq(s.payment.state, 'Settled')));
  const refunded = refunds.reduce((n,r) => n+r.amount,0), captured = payments.reduce((n,p) => n+p.amount,0);
  const state = order.state === 'Cancelled' ? 'Cancelled' : refunded >= captured ? 'Refunded' : 'PartiallyRefunded';
  await tx.update(s.order).set({ state, updatedAt: new Date() }).where(eq(s.order.id, order.id));
  if (details?.returnId) await tx.update(s.returnRequest).set({ status: 'refunded', refundId: refund.id, updatedAt: new Date() })
    .where(and(eq(s.returnRequest.id, details.returnId), eq(s.returnRequest.orderId, order.id)));
  await tx.update(s.refund).set({ metadata: { ...details, effectsApplied: true } }).where(eq(s.refund.id, refund.id));
  await tx.insert(s.auditLog).values({ storeId, actor: details?.actor ?? 'gateway:reconciliation', entity: 'order', entityId: order.id,
    action: 'refund', fromState: order.state, toState: state, data: { refundId: refund.id, amount: refund.amount } });
  await emitEvent(tx, storeId, 'order.refunded', { code: order.code, amount: refund.amount, state, refundId: refund.id });
  return { refundId: refund.id, refundState: 'Settled' as const, state, refunded: refund.amount, pending: 0 };
}
