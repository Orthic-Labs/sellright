/**
 * Shared order-detail facts (R18/R20 parity): every surface that shows a
 * customer their own order — the public receipt (orders.ts), guest tracking
 * (shop-extra.ts /v1/shop/track), and the signed-in account history
 * (account.ts) — must agree on what "the order" actually contains: real
 * payment facts (method/state/decline reason, not an invented method or a
 * pending-looks-like-paid guess), fulfillment/tracking, preorder/ship-date,
 * and line images. Centralized here so the four call sites can't drift.
 */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { deriveFulfillmentStatus, derivePaymentStatus, wirePaymentState, type OrderFulfillmentStatus, type OrderPaymentStatus, type OrderStatus } from '../orders/status.js';

export interface OrderPaymentFact {
  method: string;
  /** Wire-facing (`wirePaymentState`) — `Settled` reads as `captured`.
   *  BREAKING (pre-1.0, see CHANGELOG.md). */
  state: string;
  amount: number;
  providerRef: string | null;
  errorMessage: string | null;
  createdAt: string;
}

/** Real payment records for an order — the API's own ground truth for
 *  pending/paid/failed/cancelled, not a state the caller infers from polling
 *  order.state alone. Newest first (a retried/declined attempt followed by a
 *  successful one is common; the confirmation UI wants both, most recent first). */
export async function loadOrderPayments(tx: Tx, orderId: string): Promise<OrderPaymentFact[]> {
  const rows = await tx
    .select({
      method: s.payment.method, state: s.payment.state, amount: s.payment.amount,
      providerRef: s.payment.providerRef, errorMessage: s.payment.errorMessage, createdAt: s.payment.createdAt,
    })
    .from(s.payment)
    .where(eq(s.payment.orderId, orderId))
    .orderBy(desc(s.payment.createdAt));
  return rows.map((r) => ({ ...r, state: wirePaymentState(r.state), createdAt: r.createdAt.toISOString() }));
}

export interface OrderFulfillmentFact {
  state: string;
  trackingCode: string | null;
  carrier: string | null;
  updatedAt: string | null;
}

export async function loadOrderFulfillments(tx: Tx, orderId: string): Promise<OrderFulfillmentFact[]> {
  const rows = await tx.select().from(s.fulfillment).where(eq(s.fulfillment.orderId, orderId)).orderBy(desc(s.fulfillment.createdAt));
  return rows.map((f) => ({ state: f.state, trackingCode: f.trackingCode, carrier: f.carrier, updatedAt: f.updatedAt?.toISOString() ?? null }));
}

export interface OrderStatusFacts {
  /** Mirrors the `order.status` STORED GENERATED column — see orders/status.ts. */
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  fulfillmentStatus: OrderFulfillmentStatus;
}

/** The three wire-facing status fields (order/payment/fulfillment — see
 *  orders/status.ts) for one order, computed at read time from its OWN
 *  payment/order_line/fulfillment rows — the same sources of truth every
 *  other order-detail surface already reads, so this can't drift from them.
 *  `order` only needs `state`+`deletedAt`+`status` (the last one is read
 *  straight off the generated column rather than re-derived). `order.status`
 *  is typed `string` at the drizzle level (it's a `text()` column — see
 *  schema-core.ts's note on why it can't be a pgEnum) but is guaranteed one
 *  of the four OrderStatus values by the DB's own CHECK constraint. */
export async function loadOrderStatusFacts(
  tx: Tx,
  order: { id: string; state: 'PendingPayment' | 'Paid' | 'PartiallyRefunded' | 'Refunded' | 'Cancelled'; status: string },
): Promise<OrderStatusFacts> {
  const [payments, lines, fulfillments] = await Promise.all([
    tx.select({ state: s.payment.state }).from(s.payment).where(eq(s.payment.orderId, order.id)).orderBy(desc(s.payment.createdAt)),
    tx.select({ quantity: s.orderLine.quantity, fulfilledQty: s.orderLine.fulfilledQty, cancelledQty: s.orderLine.cancelledQty }).from(s.orderLine).where(eq(s.orderLine.orderId, order.id)),
    tx.select({ state: s.fulfillment.state }).from(s.fulfillment).where(eq(s.fulfillment.orderId, order.id)),
  ]);
  return {
    status: order.status as OrderStatus,
    paymentStatus: derivePaymentStatus(order.state, payments),
    fulfillmentStatus: deriveFulfillmentStatus(lines, fulfillments),
  };
}

/**
 * Batched counterpart of `loadOrderStatusFacts` for LIST endpoints (admin
 * order list, account order list) — 3 queries total (payments/order_line/
 * fulfillment rows for every order id on the page), not 3 per row, then the
 * exact same pure `derivePaymentStatus`/`deriveFulfillmentStatus` functions
 * every other surface uses. Deliberately NOT a hand-rolled SQL CASE
 * replicating that logic — one implementation, no risk of the two drifting.
 */
export async function loadOrderStatusFactsBatch(
  tx: Tx,
  orders: Array<{ id: string; state: 'PendingPayment' | 'Paid' | 'PartiallyRefunded' | 'Refunded' | 'Cancelled'; status: string }>,
): Promise<Map<string, OrderStatusFacts>> {
  const out = new Map<string, OrderStatusFacts>();
  if (!orders.length) return out;
  const ids = orders.map((o) => o.id);
  const [payments, lines, fulfillments] = await Promise.all([
    tx.select({ orderId: s.payment.orderId, state: s.payment.state })
      .from(s.payment).where(inArray(s.payment.orderId, ids)).orderBy(desc(s.payment.createdAt)),
    tx.select({ orderId: s.orderLine.orderId, quantity: s.orderLine.quantity, fulfilledQty: s.orderLine.fulfilledQty, cancelledQty: s.orderLine.cancelledQty })
      .from(s.orderLine).where(inArray(s.orderLine.orderId, ids)),
    tx.select({ orderId: s.fulfillment.orderId, state: s.fulfillment.state })
      .from(s.fulfillment).where(inArray(s.fulfillment.orderId, ids)),
  ]);
  const bucket = <T extends { orderId: string }>(rows: T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of rows) { const list = m.get(r.orderId); if (list) list.push(r); else m.set(r.orderId, [r]); }
    return m;
  };
  const paymentsByOrder = bucket(payments);
  const linesByOrder = bucket(lines);
  const fulfillmentsByOrder = bucket(fulfillments);
  for (const order of orders) {
    out.set(order.id, {
      status: order.status as OrderStatus,
      paymentStatus: derivePaymentStatus(order.state, paymentsByOrder.get(order.id) ?? []),
      fulfillmentStatus: deriveFulfillmentStatus(linesByOrder.get(order.id) ?? [], fulfillmentsByOrder.get(order.id) ?? []),
    });
  }
  return out;
}

export interface OrderLineFact {
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  image: string | null;
  isPreOrder: boolean;
  shipDate: string | null;
}

/** Line snapshot (sku/name/price survive the variant being edited/deleted)
 *  + best-effort CURRENT variant image/preorder/ship-date. Preorder/ship-date
 *  are read from the live variant (not snapshotted at order time), so they
 *  go null once the variant itself is gone — documented tradeoff, not a bug:
 *  see the deploy notes for why adding order-time snapshot columns is a
 *  separate, larger schema change deferred out of this fix. */
export async function loadOrderLines(tx: Tx, orderId: string): Promise<OrderLineFact[]> {
  const rows = await tx
    .select({
      sku: s.orderLine.variantSku, name: s.orderLine.variantName, quantity: s.orderLine.quantity,
      unitPrice: s.orderLine.unitPrice, lineTotal: s.orderLine.lineTotal,
      isPreOrder: s.productVariant.isPreOrder, shipDate: s.productVariant.shipDate,
      image: sql<string | null>`coalesce(
        (select a.path from ${s.variantAsset} va join ${s.asset} a on a.id = va.asset_id where va.variant_id = ${s.orderLine.variantId} order by va.position asc limit 1),
        (select a.path from ${s.productVariant} pv join ${s.productAsset} pa on pa.product_id = pv.product_id join ${s.asset} a on a.id = pa.asset_id where pv.id = ${s.orderLine.variantId} order by pa.position asc limit 1)
      )`,
    })
    .from(s.orderLine)
    .leftJoin(s.productVariant, eq(s.orderLine.variantId, s.productVariant.id))
    .where(eq(s.orderLine.orderId, orderId));
  return rows.map((l) => ({ ...l, isPreOrder: l.isPreOrder ?? false, shipDate: l.shipDate?.toISOString() ?? null }));
}

/** The coupon code behind order.promotionId, if any (null for an automatic
 *  promotion with no code, or no promotion at all). */
export async function loadOrderPromotionCode(tx: Tx, promotionId: string | null): Promise<string | null> {
  if (!promotionId) return null;
  const [p] = await tx.select({ code: s.promotion.code }).from(s.promotion).where(eq(s.promotion.id, promotionId)).limit(1);
  return p?.code ?? null;
}
