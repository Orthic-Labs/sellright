/**
 * Shared order-detail facts (R18/R20 parity): every surface that shows a
 * customer their own order — the public receipt (orders.ts), guest tracking
 * (shop-extra.ts /v1/shop/track), and the signed-in account history
 * (account.ts) — must agree on what "the order" actually contains: real
 * payment facts (method/state/decline reason, not an invented method or a
 * pending-looks-like-paid guess), fulfillment/tracking, preorder/ship-date,
 * and line images. Centralized here so the four call sites can't drift.
 */
import { desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';

export interface OrderPaymentFact {
  method: string;
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
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
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
