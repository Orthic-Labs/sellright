import { eq, sql } from 'drizzle-orm';
import * as s from '../db/schema.js';
import type { ImportContext } from './context.js';
import { vendureLineMoney, type VendureLineSnapshotInput } from './vendure-money.js';
import { parseDate } from './store.js';

/** Source refund references have quantities, not amounts. Allocate the exact
 * source items total proportionally with deterministic largest remainders. */
export function allocateRefundItems(total: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0 || weights.some(w => !Number.isFinite(w) || w < 0)) {
    throw new Error('Invalid refund allocation');
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) { if (total) throw new Error('Refund items have no lines'); return []; }
  if (!sum) { if (total) throw new Error('Refund items have no monetary basis'); return weights.map(() => 0); }
  const raw = weights.map(w => total * w / sum);
  const amounts = raw.map(Math.floor);
  const order = raw.map((n, i) => ({ i, remainder: n - amounts[i]! }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  let remaining = total - amounts.reduce((a, b) => a + b, 0);
  for (const row of order) { if (!remaining) break; amounts[row.i]!++; remaining--; }
  return amounts;
}

export async function importHistory(ctx: ImportContext) {
  const { tx, q, storeId } = ctx;
  const lines = new Map((await tx.select().from(s.orderLine)).map(line => [line.id, line]));
  const payments = new Map((await tx.select().from(s.payment)).map(payment => [payment.id, payment]));
  const refs = await q('SELECT * FROM order_line_reference ORDER BY id');
  const fulfillments = await q('SELECT * FROM fulfillment ORDER BY id');
  for (const fulfillment of fulfillments) {
    if (!['Pending', 'Shipped', 'Delivered', 'Cancelled'].includes(fulfillment.state)) {
      throw new Error('Unsupported fulfillment state: ' + fulfillment.state);
    }
    const matches = refs.filter(ref => ref.discriminator === 'FulfillmentLine' && ref.fulfillmentId === fulfillment.id);
    const byOrder = new Map<string, typeof matches>();
    for (const ref of matches) {
      const line = lines.get(ctx.id('order-line', ref.orderLineId));
      if (!line) continue;
      const list = byOrder.get(line.orderId) ?? [];
      list.push(ref); byOrder.set(line.orderId, list);
    }
    for (const [orderId, members] of byOrder) {
      const id = ctx.id('fulfillment', fulfillment.id + ':' + orderId);
      await tx.insert(s.fulfillment).values({ id, storeId, orderId, state: fulfillment.state,
        trackingCode: fulfillment.trackingCode || null, carrier: null,
        metadata: { vendureId: fulfillment.id, method: fulfillment.method, handlerCode: fulfillment.handlerCode },
        createdAt: parseDate(fulfillment.createdAt) ?? undefined, updatedAt: parseDate(fulfillment.updatedAt) ?? undefined });
      for (const ref of members) {
        const orderLineId = ctx.id('order-line', ref.orderLineId);
        await tx.insert(s.fulfillmentLine).values({ id: ctx.id('fulfillment-line', ref.id),
          storeId, fulfillmentId: id, orderLineId, quantity: ref.quantity });
        if (['Pending', 'Shipped', 'Delivered'].includes(fulfillment.state)) await tx.update(s.orderLine)
          .set({ fulfilledQty: sql`${s.orderLine.fulfilledQty} + ${ref.quantity}` }).where(eq(s.orderLine.id, orderLineId));
      }
    }
  }
  for (const refund of await q('SELECT * FROM refund ORDER BY id')) {
    const payment = payments.get(ctx.id('payment', refund.paymentId));
    if (!payment) continue;
    const total = Number(refund.total), items = Number(refund.items), shipping = Number(refund.shipping), adjustment = Number(refund.adjustment);
    if (![total, items, shipping, adjustment].every(Number.isSafeInteger) || items + shipping + adjustment !== total) {
      throw new Error('Refund breakdown does not reconcile: ' + refund.id);
    }
    const state = refund.state === 'Settled' ? 'Settled' : refund.state === 'Failed' ? 'Failed' : 'Pending';
    if (state === 'Pending') throw new Error('Resolve source pending refund before cutover: ' + refund.id);
    const id = ctx.id('refund', refund.id);
    await tx.insert(s.refund).values({ id, storeId, paymentId: payment.id, orderId: payment.orderId,
      amount: total, itemsAmount: items, shippingAmount: shipping, adjustmentAmount: adjustment,
      reason: refund.reason, state, providerRef: refund.transactionId || null,
      metadata: { vendureId: refund.id, sourceMetadata: refund.metadata, allocation: 'derived-largest-remainder-by-placed-line-value' },
      createdAt: parseDate(refund.createdAt) ?? undefined });
    const members = refs.filter(ref => ref.discriminator === 'RefundLine' && ref.refundId === refund.id);
    const weights = members.map(ref => {
      const line = lines.get(ctx.id('order-line', ref.orderLineId));
      if (!line || line.orderId !== payment.orderId || !Number.isSafeInteger(ref.quantity) || ref.quantity < 1) throw new Error('Invalid refund line: ' + ref.id);
      const snapshot = (line.metadata as { vendure: VendureLineSnapshotInput & { placedQuantity: number } }).vendure;
      if (ref.quantity > Math.max(snapshot.placedQuantity, line.quantity)) throw new Error('Refund exceeds placed quantity');
      const placed = vendureLineMoney({ ...snapshot, quantity: snapshot.placedQuantity, orderPlacedQuantity: snapshot.placedQuantity });
      return placed.lineTotal * ref.quantity / snapshot.placedQuantity;
    });
    const amounts = allocateRefundItems(items, weights);
    for (let i = 0; i < members.length; i++) {
      const ref = members[i]!, orderLineId = ctx.id('order-line', ref.orderLineId);
      await tx.insert(s.refundLine).values({ id: ctx.id('refund-line', ref.id), storeId,
        refundId: id, orderLineId, quantity: ref.quantity, amount: amounts[i]!, restock: false });
      if (state === 'Settled') await tx.update(s.orderLine)
        .set({ refundedQty: sql`${s.orderLine.refundedQty} + ${ref.quantity}` }).where(eq(s.orderLine.id, orderLineId));
    }
  }
  const invalid = await tx.select({ id: s.orderLine.id }).from(s.orderLine)
    .where(sql`${s.orderLine.fulfilledQty} > greatest(${s.orderLine.quantity}, coalesce((${s.orderLine.metadata}->'vendure'->>'placedQuantity')::int, 0)) OR ${s.orderLine.refundedQty} > greatest(${s.orderLine.quantity}, coalesce((${s.orderLine.metadata}->'vendure'->>'placedQuantity')::int, 0))`);
  if (invalid.length) throw new Error('Imported fulfillment/refund quantities exceed order lines');
  const orders = new Map((await tx.select().from(s.order)).map(order => [order.id, order]));
  const promotions = new Set((await tx.select({ id: s.promotion.id }).from(s.promotion)).map(row => row.id));
  for (const usage of await q('SELECT * FROM order_promotions_promotion ORDER BY "orderId", "promotionId"')) {
    const order = orders.get(ctx.id('order', usage.orderId)), promotionId = ctx.id('promotion', usage.promotionId);
    if (!order || order.state === 'Cancelled' || !order.placedAt || !promotions.has(promotionId)) continue;
    await tx.insert(s.promotionUsage).values({ id: ctx.id('promotion-usage', usage.orderId + ':' + usage.promotionId),
      storeId, promotionId, orderId: order.id, customerId: order.customerId, createdAt: order.createdAt });
    await tx.update(s.promotion).set({ usedCount: sql`${s.promotion.usedCount} + 1` }).where(eq(s.promotion.id, promotionId));
  }
  for (const order of orders.values()) {
    const refunds = await tx.select().from(s.refund).where(eq(s.refund.orderId, order.id));
    const refunded = refunds.filter(refund => refund.state === 'Settled').reduce((sum, refund) => sum + refund.amount, 0);
    const settled = [...payments.values()].filter(payment => payment.orderId === order.id && payment.state === 'Settled').reduce((sum, payment) => sum + payment.amount, 0);
    if (refunded > settled) throw new Error('Refund exceeds captured payments: ' + order.code);
    if (refunded > 0 && order.state !== 'Cancelled') await tx.update(s.order)
      .set({ state: refunded === settled ? 'Refunded' : 'PartiallyRefunded' }).where(eq(s.order.id, order.id));
  }
  // Source inventory already includes these historical operations. No stock
  // movements, payment calls, confirmation emails or webhooks run during import.
}
