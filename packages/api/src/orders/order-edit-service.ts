/**
 * Order editing (spec G13 / G5) — the DB-bound half. `orders/order-edit.ts`
 * holds the pure model; this loads the facts, builds a PLAN (new totals, line
 * diff, stock check, balance) and, for a commit, applies it atomically.
 *
 *  - previewOrderEdit: stateless, read-only (no locks, no writes).
 *  - commitOrderEdit: idempotent per key, rejects a stale preview, applies the
 *    edit + the in-transaction settlement parts (manual payment, pay-link
 *    email) under the order row lock, THEN (outside any transaction, as the
 *    refund engine requires) performs a refund_now settlement.
 *  - saveOrderAddress: the direct, same-country address save (G5).
 *
 * Stock (locked architecture): no caching anywhere. Reservation is live via
 * reserveStockOrThrow; only the UNFULFILLED delta per variant moves; callers
 * run onStockChanged after the commit.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withAdvisoryLock, withStore, type Tx } from '../db/client.js';
import { LockSetUnstable, orderIdByCode, withLockedSet } from '../db/locks.js';
import { checkPlacement } from '../payments/policy/host.js';
import * as s from '../db/schema.js';
import { hasConfirmableIntent, hasUnresolvedPayment } from '../payments/hold.js';
import { cancelOrderStripeIntents } from '../payments/stripe-reconcile.js';
import { licensedLineEditViolations } from '../licensing/edit-reconcile.js';
import { amountDueForOrder, applyPaymentResult, editRefundedTotal } from '../payments/settle.js';
import { editBalanceEffects, recordSettlementOperation } from '../payments/settlement/record.js';
import { requestRefund, RefundError, isDuplicatePayment } from '../payments/refunds.js';
import { editedEarnTarget, orderLoyaltySnapshot, syncEditEarn } from '../loyalty/ledger.js';
import { editRefundReason } from '../payments/edit-refund.js';
import { calculateOrderTotals, type Promotion } from '../money/totals.js';
import { evaluateCoupon } from '../money/coupon.js';
import { couponItemsFromFacts, loadCouponMatchContext } from '../money/coupon-context.js';
import { resolveTaxRate } from '../money/tax.js';
import { selectUnitPrice, variantPriceRuleFromConfig } from '../money/pricing.js';
import { isMethodEligible, shippingRate, type ShippingCalculator } from '../shipping/calculator.js';
import { reserveStockOrThrow, StockReservationError } from './stock-reservation.js';
import { emitEvent } from '../webhooks/emit.js';
import { enqueueOrderBalanceDue, enqueueOrderUpdated, pickEmailAppKey, resolveStorefrontUrl, type StoreEmailCtx } from '../email/dispatch.js';
import { normalizeEmail } from '../auth/email.js';
import {
  OrderEditError, applyEditOps, countryChanged, diffLines, lockedQty, openQty, priceWorkingOrder, readAddress,
  referencedKeys, sameAddress, validateSettlement, allowedSettlements,
  type Address, type EditOpT, type LineDiff, type OrderSnapshot, type PromoFacts, type SettlementT,
  type ShippingMethodFacts, type VariantFacts, type WLine, type WorkingOrder,
} from './order-edit.js';

export { OrderEditError } from './order-edit.js';

type OrderRow = typeof s.order.$inferSelect;
type VariantRow = typeof s.productVariant.$inferSelect;

const EDITABLE_STATES = new Set(['PendingPayment', 'Paid', 'PartiallyRefunded']);

/** Throws unless this order may take these ops. Cancelled: nothing. Refunded:
 *  address changes only (G5 — "address edit allowed until Cancelled"). */
export function assertEditable(state: string, ops: EditOpT[]): void {
  const addressOnly = ops.length > 0 && ops.every((o) => o.op === 'set_address');
  if (state === 'Cancelled') throw new OrderEditError(409, 'ORDER_NOT_EDITABLE', 'a cancelled order cannot be edited');
  if (!EDITABLE_STATES.has(state) && !(addressOnly && state === 'Refunded')) {
    throw new OrderEditError(409, 'ORDER_NOT_EDITABLE', `a ${state} order cannot be edited (only its address can)`);
  }
}

// ── plan ─────────────────────────────────────────────────────────────────────
export interface StockCheck { sku: string; name: string; variantId: string; delta: number; available: number | null; ok: boolean }
export interface BalanceInfo {
  newGrandTotal: number; settled: number; refunded: number; netPaid: number;
  /** Money handed back by earlier order edits (already reflected in grandTotal). */
  editRefunded: number;
  /** newGrandTotal - settled + editRefunded: + the customer owes, - owed back. */
  amountDue: number;
}
export interface RefundablePayment { id: string; method: string; amount: number; available: number }
export interface EditPlan {
  order: OrderRow;
  working: WorkingOrder;
  before: OrderSnapshot;
  after: OrderSnapshot;
  lineDiffs: LineDiff[];
  priced: ReturnType<typeof priceWorkingOrder>;
  stock: StockCheck[];
  /** per-variant allocation delta (+ reserve, - release), physical non-preorder only */
  stockDeltas: Map<string, number>;
  balance: BalanceInfo;
  refundable: RefundablePayment[];
  warnings: string[];
  promotionRow: PromoFacts | null;
  shipping: { amount: number; base: number; override: boolean; methodCode: string | null; methodName: string | null };
  address: { shipping: { changed: boolean; countryChanged: boolean }; billing: { changed: boolean } };
  variantsById: Map<string, VariantRow>;
  isPreOrder: boolean;
  storeCtx: StoreEmailCtx;
  recipient: string | null;
  customerId: string | null;
  taxRate: number;
  taxInclusive: boolean;
}

type OrderMeta = {
  shipping?: { methodCode?: string | null; base?: number };
  taxInclusive?: boolean;
  loyalty?: { pointsDiscount?: number };
  contact?: { email?: string };
};

const asFacts = (v: VariantRow): VariantFacts => v;

type PricedTotals = { subtotal: number; discountTotal: number; shippingTotal: number; taxTotal: number; grandTotal: number };
/** True when the edit leaves every priced total (so the amount basis) unchanged. */
export function totalsInert(a: PricedTotals, b: PricedTotals): boolean {
  return a.subtotal === b.subtotal && a.discountTotal === b.discountTotal && a.shippingTotal === b.shippingTotal
    && a.taxTotal === b.taxTotal && a.grandTotal === b.grandTotal;
}

/** A set that cannot be taken within its restarts (lock timeout or plan churn) is a
 *  transient 503 for the caller, never a partial edit (STOREKIT §5.2). */
const orderBusy = (e: unknown): never => {
  if (e instanceof LockSetUnstable) throw new OrderEditError(503, 'ORDER_BUSY', 'the order is busy — try again in a moment');
  throw e;
};

/** Order id for a set subject (unlocked read). A missing order is the same 404 as the plan. */
async function lockableOrderId(storeId: string, code: string): Promise<string> {
  const id = await orderIdByCode(storeId, code);
  if (!id) throw new OrderEditError(404, 'ORDER_NOT_FOUND', 'order not found');
  return id;
}

export async function planOrderEdit(tx: Tx, storeId: string, code: string, ops: EditOpT[], opts: { lock: boolean }): Promise<EditPlan> {
  const [order] = opts.lock
    ? await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update')
    : await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
  if (!order || order.deletedAt) throw new OrderEditError(404, 'ORDER_NOT_FOUND', 'order not found');
  assertEditable(order.state, ops);
  const addressOnly = ops.length > 0 && ops.every((o) => o.op === 'set_address');
  if (!addressOnly && await hasUnresolvedPayment(tx, order.id)) {
    throw new OrderEditError(409, 'PAYMENT_UNRESOLVED', 'resolve the pending payment before editing this order');
  }
  const meta = (order.metadata ?? {}) as OrderMeta;

  const dbLines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, order.id));
  const dbAdjustments = await tx.select().from(s.orderAdjustment).where(eq(s.orderAdjustment.orderId, order.id)).orderBy(asc(s.orderAdjustment.createdAt));
  const [storeRow] = await tx.select().from(s.store).where(eq(s.store.id, storeId)).limit(1);
  if (!storeRow) throw new OrderEditError(404, 'STORE_NOT_FOUND', 'store not found');
  const zones = await tx.select({ countries: s.taxZone.countries, rate: s.taxZone.rate, priority: s.taxZone.priority }).from(s.taxZone).where(eq(s.taxZone.enabled, true));
  const methods = await tx.select().from(s.shippingMethod).where(eq(s.shippingMethod.enabled, true));
  const refs = referencedKeys(ops);

  const lineVariantIds = [...new Set(dbLines.map((l) => l.variantId).filter((x): x is string => !!x))];
  const variantRows: VariantRow[] = [];
  if (lineVariantIds.length) variantRows.push(...await tx.select().from(s.productVariant).where(inArray(s.productVariant.id, lineVariantIds)));
  if (refs.skus.length) {
    const bySku = await tx.select().from(s.productVariant).where(and(inArray(s.productVariant.sku, refs.skus), isNull(s.productVariant.deletedAt)));
    for (const v of bySku) if (!variantRows.some((x) => x.id === v.id)) variantRows.push(v);
  }
  const variantsById = new Map(variantRows.map((v) => [v.id, v]));
  const variantsBySku = new Map(variantRows.map((v) => [v.sku, asFacts(v)]));

  const now = new Date();
  const promosByCode = new Map<string, PromoFacts>();
  if (refs.coupons.length) {
    const rows = await tx.select().from(s.promotion).where(and(
      inArray(s.promotion.code, refs.coupons), eq(s.promotion.enabled, true),
      or(isNull(s.promotion.startsAt), lte(s.promotion.startsAt, now)), or(isNull(s.promotion.endsAt), gte(s.promotion.endsAt, now)),
    ));
    for (const r of rows) if (r.code) promosByCode.set(r.code, r);
  }
  const methodsByCode = new Map<string, ShippingMethodFacts>(methods.map((m) => [m.code, m]));
  const priceRule = variantPriceRuleFromConfig(storeRow.config);

  const initial: WorkingOrder = {
    lines: dbLines.map((l): WLine => ({
      key: l.id, id: l.id, variantId: l.variantId, sku: l.variantSku, name: l.variantName, unitPrice: l.unitPrice, quantity: l.quantity,
      fulfilledQty: l.fulfilledQty, refundedQty: l.refundedQty, cancelledQty: l.cancelledQty,
      original: { variantId: l.variantId, sku: l.variantSku, name: l.variantName, unitPrice: l.unitPrice, quantity: l.quantity },
    })),
    adjustments: dbAdjustments.map((a) => ({ id: a.id, label: a.label, amount: a.amount })),
    promotion: { kind: 'keep' }, shipping: { kind: 'keep' }, saveToAddressBook: false,
  };
  const working = applyEditOps(initial, ops, { variantsBySku, promosByCode, methodsByCode, unitPriceFor: (v) => selectUnitPrice(v, priceRule) });

  // ── pricing inputs ─────────────────────────────────────────────────────────
  const warnings: string[] = [];
  const beforeShip = readAddress(order.shippingAddress);
  const beforeBill = readAddress(order.billingAddress);
  const afterShip = working.shippingAddress ?? beforeShip;
  const afterBill = working.billingAddress ?? beforeBill;
  const country = afterShip?.country ?? null;
  const taxRate = resolveTaxRate(zones, country, storeRow.taxRate);
  const taxInclusive = meta.taxInclusive ?? storeRow.taxInclusive;

  const active = working.lines.filter((l) => l.quantity > 0);
  const productIdOf = (l: WLine) => (l.variantId ? variantsById.get(l.variantId)?.productId ?? null : null);
  const preSubtotal = active.reduce((a, l) => a + l.unitPrice * l.quantity, 0);

  // Promotion.
  const [currentPromo] = order.promotionId ? await tx.select().from(s.promotion).where(eq(s.promotion.id, order.promotionId)).limit(1) : [];
  let promotion: Promotion | null = null;
  let promotionRow: PromoFacts | null = null;
  if (working.promotion.kind === 'apply') {
    const pids = active.map(productIdOf).filter((x): x is string => !!x);
    const facts = await loadCouponMatchContext(tx, pids);
    const items = couponItemsFromFacts(active.map((l) => ({ quantity: l.quantity, productId: productIdOf(l) })), facts);
    const ev = evaluateCoupon(working.promotion.promo, { subtotal: preSubtotal, activeVerifications: [], items });
    if (!ev.valid || !ev.promotion) throw new OrderEditError(409, 'COUPON_INVALID', `coupon cannot be applied: ${ev.reason ?? 'not valid for this order'}`, { code: working.promotion.promo.code });
    promotion = ev.promotion; promotionRow = working.promotion.promo;
  } else if (working.promotion.kind === 'keep' && order.promotionId) {
    // A discount the customer already received stays on the order as lines
    // change (its conditions are NOT re-run against the new cart).
    const p = currentPromo;
    if (p) { promotion = { type: p.type, value: p.value, freeShipping: p.freeShipping }; promotionRow = p; }
    else warnings.push('PROMOTION_MISSING');
  }

  // Shipping.
  const discounted = calculateOrderTotals({
    lines: active.map((l) => ({ unitPrice: l.unitPrice, quantity: l.quantity })), shipping: 0, taxRate, taxInclusive, promotion,
  });
  const storedBase = meta.shipping?.base ?? order.shippingTotal;
  let baseShipping = storedBase;
  let shippingOverride = order.shippingOverride;
  let methodCode: string | null = order.shippingMethodCode ?? meta.shipping?.methodCode ?? null;
  const storedMethodCode = methodCode;
  let calc: ShippingCalculator | undefined;
  if (working.shipping.kind === 'method') {
    const m = working.shipping.method;
    calc = m.calculator as ShippingCalculator;
    if (!isMethodEligible(calc, { subtotal: preSubtotal, country, discountedSubtotalWithTax: discounted.grandTotal })) {
      throw new OrderEditError(409, 'SHIPPING_UNAVAILABLE', `shipping method ${m.code} is not available for this order`, { code: m.code });
    }
    baseShipping = shippingRate(calc); shippingOverride = false; methodCode = m.code;
  } else if (working.shipping.kind === 'custom') {
    baseShipping = working.shipping.amount; shippingOverride = true; methodCode = null;
  } else if (working.shipping.kind === 'none') {
    baseShipping = 0; shippingOverride = true; methodCode = null;
  } else if (!shippingOverride) {
    // Unchanged shipping: use the recorded method, else infer one whose flat
    // rate equals the stored base (legacy orders never stored the method).
    const recorded = methodCode ? methodsByCode.get(methodCode) : undefined;
    const inferred = recorded ?? methods.find((m) => shippingRate(m.calculator) === storedBase);
    if (inferred) {
      calc = inferred.calculator as ShippingCalculator; methodCode = inferred.code;
      // Only a legacy order with NO stored method is guessed from its total.
      if (!storedMethodCode) warnings.push('SHIPPING_METHOD_INFERRED');
    }
    if (calc && !isMethodEligible(calc, { subtotal: preSubtotal, country, discountedSubtotalWithTax: discounted.grandTotal })) {
      warnings.push('SHIPPING_METHOD_INELIGIBLE');
    }
    // A free-shipping promotion may have zeroed a base this legacy order never
    // recorded; if that promotion is going away the shipping charge is unknown.
    if (!meta.shipping && storedBase === 0 && (currentPromo?.freeShipping || currentPromo?.type === 'free_shipping') && !(promotion?.freeShipping || promotion?.type === 'free_shipping')) {
      warnings.push('SHIPPING_BASE_UNKNOWN');
    }
  }

  const priced = priceWorkingOrder(working.lines, working.adjustments, {
    taxRate, taxInclusive, shippingTaxable: storeRow.shippingTaxable,
    shippingTaxRate: calc?.taxRate, shippingTaxInclusive: calc?.taxInclusive,
    promotion, pointsDiscount: Math.max(0, Math.floor(meta.loyalty?.pointsDiscount ?? 0)), baseShipping,
  });
  const t = priced.totals;

  // A pure address edit is exempt from the payment holds ONLY while it is
  // monetarily inert: a shipping-country change re-prices tax, so it holds and
  // retires intents exactly like an item edit. Any priced total moving changes
  // the amount basis: no Stripe intent minted at the old amount may stay
  // confirmable (commitOrderEdit retires them first; one that could not be
  // cancelled, or was minted since, blocks the edit).
  const moneyInert = totalsInert(
    { subtotal: order.subtotal, discountTotal: order.discountTotal, shippingTotal: order.shippingTotal, taxTotal: order.taxTotal, grandTotal: order.grandTotal }, t);
  if (addressOnly && !moneyInert && await hasUnresolvedPayment(tx, order.id)) {
    throw new OrderEditError(409, 'PAYMENT_UNRESOLVED', 'resolve the pending payment before editing this order');
  }
  if (opts.lock && !moneyInert && await hasConfirmableIntent(tx, storeId, order.id)) {
    throw new OrderEditError(409, 'PAYMENT_UNRESOLVED', 'an open card payment for the old amount could not be cancelled yet — retry in a moment');
  }

  // ── issued licenses: a line that already carries a non-revoked license may
  // not be removed, reduced or repointed at another variant; entitlements are
  // settled money, not editable merchandise.
  const licensed = await licensedLineEditViolations(tx, storeId, order.id,
    working.lines.filter((l) => l.id).map((l) => ({ id: l.id!, variantId: l.variantId, quantity: l.quantity })));
  if (licensed.length) {
    const skus = working.lines.filter((l) => l.id && licensed.includes(l.id)).map((l) => l.sku);
    throw new OrderEditError(409, 'LINE_LICENSED', `a line with an issued license cannot be removed, reduced or swapped: ${skus.join(', ')}`, { lineIds: licensed });
  }

  // ── stock plan: unfulfilled delta per variant ──────────────────────────────
  const stockDeltas = new Map<string, number>();
  const physical = (variantId: string) => {
    const v = variantsById.get(variantId);
    return !!v && !v.isPreOrder && v.fulfillmentType === 'physical';
  };
  const bump = (variantId: string | null, n: number) => {
    if (!variantId || n === 0 || !physical(variantId)) return;
    stockDeltas.set(variantId, (stockDeltas.get(variantId) ?? 0) + n);
  };
  for (const l of dbLines) bump(l.variantId, -openQty(l));
  for (const l of working.lines) bump(l.variantId, openQty(l));
  for (const [id, d] of [...stockDeltas]) if (d === 0) stockDeltas.delete(id);
  for (const [id, d] of stockDeltas) {
    const v = variantsById.get(id)!;
    if (d > 0 && (!v.enabled || v.deletedAt)) throw new OrderEditError(409, 'VARIANT_UNAVAILABLE', `variant is not available: ${v.sku}`, { sku: v.sku });
  }
  const stock: StockCheck[] = [];
  const growing = [...stockDeltas].filter(([, d]) => d > 0).map(([id]) => id);
  const stockRows = growing.length ? await tx.select().from(s.stock).where(and(eq(s.stock.storeId, storeId), inArray(s.stock.variantId, growing))) : [];
  for (const [id, delta] of stockDeltas) {
    const v = variantsById.get(id)!;
    const row = stockRows.find((r) => r.variantId === id);
    const available = row ? row.onHand - row.allocated : null;
    stock.push({ sku: v.sku, name: v.name, variantId: id, delta, available, ok: delta <= 0 || (available != null && available >= delta) });
  }

  // ── balance ────────────────────────────────────────────────────────────────
  const payments = await tx.select().from(s.payment).where(and(eq(s.payment.orderId, order.id), eq(s.payment.state, 'Settled')));
  const refunds = await tx.select().from(s.refund).where(and(eq(s.refund.orderId, order.id), sql`${s.refund.state} <> 'Failed'`));
  const settled = payments.reduce((n, p) => n + p.amount, 0);
  const refunded = refunds.reduce((n, r) => n + r.amount, 0);
  const amountDue = await amountDueForOrder(tx, storeId, order.id, t.grandTotal);
  const editRefunded = await editRefundedTotal(tx, storeId, order.id);
  const balance: BalanceInfo = { newGrandTotal: t.grandTotal, settled, refunded, netPaid: settled - refunded, editRefunded, amountDue };
  const refundable: RefundablePayment[] = payments.filter((p) => !isDuplicatePayment(p)).map((p) => ({
    id: p.id, method: p.method, amount: p.amount,
    available: p.amount - refunds.filter((r) => r.paymentId === p.id).reduce((n, r) => n + r.amount, 0),
  })).filter((p) => p.available > 0);

  // ── snapshots / diffs ──────────────────────────────────────────────────────
  const snapLines = dbLines.map((l) => ({ id: l.id as string | null, sku: l.variantSku, name: l.variantName, unitPrice: l.unitPrice, quantity: l.quantity, lineTotal: l.lineTotal, fulfilledQty: l.fulfilledQty, refundedQty: l.refundedQty }));
  const isPreOrderAfter = working.lines.some((l) => l.quantity > 0 && l.variantId && variantsById.get(l.variantId)?.isPreOrder === true);
  const before: OrderSnapshot = {
    totals: { subtotal: order.subtotal, discountTotal: order.discountTotal, shippingTotal: order.shippingTotal, taxTotal: order.taxTotal, grandTotal: order.grandTotal, adjustmentTotal: dbAdjustments.reduce((n, a) => n + a.amount, 0) },
    lines: snapLines, adjustments: dbAdjustments.map((a) => ({ label: a.label, amount: a.amount })),
    shipping: { amount: order.shippingTotal, override: order.shippingOverride, methodCode: order.shippingMethodCode ?? meta.shipping?.methodCode ?? null },
    promotion: currentPromo ? { id: currentPromo.id, code: currentPromo.code } : null,
    shippingAddress: beforeShip, billingAddress: beforeBill, isPreOrder: order.isPreOrder,
  };
  const after: OrderSnapshot = {
    totals: { subtotal: t.subtotal, discountTotal: t.discountTotal, shippingTotal: t.shippingTotal, taxTotal: t.taxTotal, grandTotal: t.grandTotal, adjustmentTotal: t.adjustmentTotal ?? 0 },
    lines: working.lines.map((l) => ({ id: l.id, sku: l.sku, name: l.name, unitPrice: l.unitPrice, quantity: l.quantity, lineTotal: priced.perLine.find((p) => p.key === l.key)!.lineTotal, fulfilledQty: l.fulfilledQty, refundedQty: l.refundedQty })),
    adjustments: working.adjustments.map((a) => ({ label: a.label, amount: a.amount })),
    shipping: { amount: t.shippingTotal, override: shippingOverride, methodCode },
    promotion: promotionRow ? { id: promotionRow.id, code: promotionRow.code } : null,
    shippingAddress: afterShip, billingAddress: afterBill, isPreOrder: isPreOrderAfter,
  };

  const [customer] = order.customerId ? await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, order.customerId)).limit(1) : [];
  const recipient = normalizeEmail(meta.contact?.email || customer?.email || '') || null;
  const storeCtx: StoreEmailCtx = {
    name: storeRow.name, currency: order.currency, config: storeRow.config, storeId,
    appKey: pickEmailAppKey(variantRows.map((v) => v.appKey)),
  };

  return {
    order, working, before, after, lineDiffs: diffLines(snapLines, working.lines, priced), priced, stock, stockDeltas, balance, refundable, warnings,
    promotionRow, shipping: { amount: t.shippingTotal, base: baseShipping, override: shippingOverride, methodCode, methodName: methodCode ? methodsByCode.get(methodCode)?.name ?? null : null },
    address: { shipping: { changed: !sameAddress(beforeShip, afterShip), countryChanged: countryChanged(beforeShip, afterShip) }, billing: { changed: !sameAddress(beforeBill, afterBill) } },
    variantsById, isPreOrder: isPreOrderAfter, storeCtx, recipient, customerId: order.customerId, taxRate, taxInclusive,
  };
}

// ── preview ──────────────────────────────────────────────────────────────────
export interface RefundFeasibility { feasible: boolean; reason?: string; paymentId?: string }

/** Can a refund_now of `amount` be issued right now (and against which payment)? */
export function refundFeasibility(plan: Pick<EditPlan, 'refundable' | 'order'>, amount: number, paymentId?: string): RefundFeasibility {
  if (plan.order.state !== 'Paid' && plan.order.state !== 'PartiallyRefunded') return { feasible: false, reason: 'only a paid order can be refunded; leave the credit instead' };
  const pool = paymentId ? plan.refundable.filter((p) => p.id === paymentId) : plan.refundable;
  if (paymentId && pool.length === 0) return { feasible: false, reason: 'the selected payment has nothing left to refund' };
  if (!paymentId && pool.length === 0) return { feasible: false, reason: 'no refundable payment on this order' };
  if (!paymentId && pool.length > 1) return { feasible: false, reason: 'select which payment to refund' };
  const p = pool[0]!;
  if (amount > p.available) return { feasible: false, reason: 'the refund exceeds what is left on that payment' };
  if (amount === p.available) return { feasible: false, reason: 'this would refund the whole payment — cancel or refund the order instead' };
  return { feasible: true, paymentId: p.id };
}

export interface PreviewResult {
  code: string; state: string; currency: string; reason?: undefined;
  before: OrderSnapshot['totals']; after: OrderSnapshot['totals'];
  lines: LineDiff[]; adjustments: Array<{ id: string | null; label: string; amount: number }>;
  shipping: EditPlan['shipping']; promotion: { code: string | null; type: string; value: number } | null;
  stock: StockCheck[]; stockOk: boolean; balance: BalanceInfo; settlementOptions: string[];
  refund: { feasible: boolean; reason?: string; payments: RefundablePayment[] } | null;
  warnings: string[]; address: EditPlan['address']; isPreOrder: boolean; recipientEmail: string | null;
}

export function previewFromPlan(plan: EditPlan): PreviewResult {
  const amountDue = plan.balance.amountDue;
  const refund = amountDue < 0 ? { ...refundFeasibility(plan, -amountDue), payments: plan.refundable } : null;
  return {
    code: plan.order.code, state: plan.order.state, currency: plan.order.currency,
    before: plan.before.totals, after: plan.after.totals, lines: plan.lineDiffs,
    adjustments: plan.working.adjustments, shipping: plan.shipping,
    promotion: plan.promotionRow ? { code: plan.promotionRow.code, type: plan.promotionRow.type, value: plan.promotionRow.value } : null,
    stock: plan.stock, stockOk: plan.stock.every((x) => x.ok), balance: plan.balance,
    settlementOptions: allowedSettlements(amountDue), refund, warnings: plan.warnings, address: plan.address,
    isPreOrder: plan.isPreOrder, recipientEmail: plan.recipient,
  };
}

export async function previewOrderEdit(storeId: string, code: string, ops: EditOpT[]): Promise<PreviewResult> {
  return withStore(storeId, async (tx) => previewFromPlan(await planOrderEdit(tx, storeId, code, ops, { lock: false })));
}

// ── commit ───────────────────────────────────────────────────────────────────
export interface CommitInput {
  storeId: string; storeSlug: string; code: string; actor: string;
  ops: EditOpT[]; expectedGrandTotal: number; expectedBalance?: number; idempotencyKey: string;
  settlement?: SettlementT; notifyCustomer: boolean; reason?: string;
}
export interface SettlementOutcome {
  type: string; status: 'none' | 'recorded' | 'settled' | 'pending' | 'failed' | 'sent' | 'due' | 'credit';
  amount?: number; paymentId?: string; refundId?: string; refundState?: string; message?: string; paymentMethod?: string; reference?: string | null;
}
/**
 * The stored settlement is a snapshot taken when the edit committed; an async
 * refund (Pending) later settles or fails in the shared refund finalizer, which
 * knows nothing about order_edit. Derive the live outcome from the linked refund
 * row so history shows the truth and a failed refund becomes retryable.
 */
export async function liveEditSettlement(tx: Tx, storeId: string, st: SettlementOutcome): Promise<SettlementOutcome> {
  if (st.type !== 'refund_now' || !st.refundId) return st;
  const [r] = await tx.select({ state: s.refund.state }).from(s.refund)
    .where(and(eq(s.refund.storeId, storeId), eq(s.refund.id, st.refundId))).limit(1);
  if (!r) return st;
  const status = r.state === 'Settled' ? 'settled' : r.state === 'Failed' ? 'failed' : 'pending';
  if (status === st.status && r.state === st.refundState) return st;
  const { message: _m, ...rest } = st;
  return { ...rest, refundState: r.state, status,
    ...(status === 'failed' ? { message: 'the gateway declined the refund — retry it from the order edit, or leave it as credit' } : {}) };
}

export interface CommitResult {
  editId: string; code: string; state: string; grandTotal: number; previousGrandTotal: number;
  /** Balance at commit time (+ owed, - credit). */
  balance: number; amountDue: number; settlement: SettlementOutcome; replay: boolean; emailQueued: boolean;
}

const fingerprintOf = (i: CommitInput) => createHash('sha256').update(JSON.stringify({
  code: i.code, ops: i.ops, settlement: i.settlement ?? null, expectedGrandTotal: i.expectedGrandTotal,
  expectedBalance: i.expectedBalance ?? null, notify: i.notifyCustomer, reason: i.reason ?? null,
})).digest('hex');

const fmt = (cents: number, cur: string) => `${(Math.abs(cents) / 100).toFixed(2)} ${cur}`;

/** Human change list for the customer email, from the line diff. */
export function describeChanges(plan: Pick<EditPlan, 'lineDiffs' | 'before' | 'after' | 'address'>, currency: string): string[] {
  const out: string[] = [];
  for (const d of plan.lineDiffs) {
    if (d.change === 'added') out.push(`Added ${d.afterQty} × ${d.name}`);
    else if (d.change === 'removed') out.push(`Removed ${d.name}`);
    else if (d.change === 'quantity') out.push(`${d.name}: quantity ${d.beforeQty} → ${d.afterQty}`);
    else if (d.change === 'swapped') out.push(`${d.fromSku} changed to ${d.name}`);
  }
  const b = plan.before.totals, a = plan.after.totals;
  if (a.discountTotal !== b.discountTotal) out.push(`Discount: ${fmt(b.discountTotal, currency)} → ${fmt(a.discountTotal, currency)}`);
  if (a.shippingTotal !== b.shippingTotal) out.push(`Shipping: ${fmt(b.shippingTotal, currency)} → ${fmt(a.shippingTotal, currency)}`);
  if (a.taxTotal !== b.taxTotal) out.push(`Tax: ${fmt(b.taxTotal, currency)} → ${fmt(a.taxTotal, currency)}`);
  if (a.adjustmentTotal !== b.adjustmentTotal) out.push(`Adjustment: ${a.adjustmentTotal - b.adjustmentTotal >= 0 ? '+' : '-'}${fmt(a.adjustmentTotal - b.adjustmentTotal, currency)}`);
  if (plan.address.shipping.changed) out.push('Shipping address updated');
  if (plan.address.billing.changed) out.push('Billing address updated');
  return out;
}

const addressRow = (a: Address) => ({ fullName: a.fullName, line1: a.line1, line2: a.line2, city: a.city, province: a.province, postalCode: a.postalCode, country: a.country, phone: a.phone });

async function saveToAddressBook(tx: Tx, storeId: string, customerId: string | null, a: Address | null | undefined): Promise<boolean> {
  if (!customerId || !a || !a.line1 || !a.city || !a.country) return false;
  const existing = await tx.select().from(s.address).where(eq(s.address.customerId, customerId));
  if (existing.some((e) => e.line1 === a.line1 && e.city === a.city && (e.postalCode ?? null) === a.postalCode && e.country === a.country && (e.fullName ?? null) === a.fullName && (e.line2 ?? null) === a.line2)) return false;
  await tx.insert(s.address).values({ storeId, customerId, fullName: a.fullName, line1: a.line1, line2: a.line2, city: a.city, province: a.province, postalCode: a.postalCode, country: a.country, phone: a.phone });
  return true;
}

/** Best-effort cancel of the order's open Stripe intents; the commit's
 *  hasConfirmableIntent guard fails closed if any survive. */
async function retireOrderIntents(storeId: string, code: string, actor: string): Promise<void> {
  const [ord] = await withStore(storeId, (tx) => tx.select({ id: s.order.id }).from(s.order)
    .where(and(eq(s.order.storeId, storeId), eq(s.order.code, code))).limit(1));
  if (ord) await cancelOrderStripeIntents(storeId, ord.id, actor);
}

export async function commitOrderEdit(input: CommitInput): Promise<CommitResult> {
  const { storeId } = input;
  const fp = fingerprintOf(input);
  // Retire confirmable Stripe intents (minted at the pre-edit amount) BEFORE the
  // edit: Stripe I/O must run with no pay lock held (the sweep takes it). A
  // capture that already succeeded settles against the still-unedited total.
  // Only a NEW edit (no stored replay for the key) whose preview matches and
  // whose priced totals change retires anything: an idempotent replay or a
  // stale/invalid request must never cancel a newer legitimate intent. The
  // locked commit below re-validates everything and keeps the survivor check.
  const retire = await withStore(storeId, async (tx) => {
    const [prior] = await tx.select({ id: s.orderEdit.id }).from(s.orderEdit)
      .where(and(eq(s.orderEdit.storeId, storeId), eq(s.orderEdit.idempotencyKey, input.idempotencyKey))).limit(1);
    if (prior) return false;
    const plan = await planOrderEdit(tx, storeId, input.code, input.ops, { lock: false });
    if (plan.after.totals.grandTotal !== input.expectedGrandTotal) {
      throw new OrderEditError(409, 'PREVIEW_STALE', 'the order changed since the preview — review the new totals and try again', { grandTotal: plan.after.totals.grandTotal, balance: plan.balance.amountDue });
    }
    return !totalsInert(plan.before.totals, plan.after.totals);
  });
  if (retire) await retireOrderIntents(storeId, input.code, input.actor);
  // The pay advisory lock serializes this commit with an in-flight /pay for the
  // same order, so the charge amount and the total can never disagree mid-edit.
  return withAdvisoryLock(`pay:${storeId}:${input.code}`, async () => {
    let stockChanged = false;
    type Applied = { result: CommitResult; plan: EditPlan | null; refundPlan?: { amount: number; paymentId: string } };
    // STOREKIT §5.8 #15: the order's licences (L2) are planned and locked before the
    // order row (L3); the plan/lock/verify set owns the transaction.
    const orderId = await lockableOrderId(storeId, input.code);
    const applied: Applied = await withLockedSet(storeId, { kind: 'order', orderId }, async (tx): Promise<Applied> => {
      // Replay: the stored edit wins over re-applying (the total already moved).
      const [prior] = await tx.select().from(s.orderEdit).where(and(eq(s.orderEdit.storeId, storeId), eq(s.orderEdit.idempotencyKey, input.idempotencyKey))).limit(1);
      if (prior) {
        const [o] = await tx.select().from(s.order).where(eq(s.order.id, prior.orderId)).limit(1);
        if (!o || o.code !== input.code || prior.fingerprint !== fp) throw new OrderEditError(409, 'IDEMPOTENCY_KEY_REUSED', 'this idempotency key was used for a different edit');
        const st = await liveEditSettlement(tx, storeId, (prior.settlement ?? { type: 'none', status: 'none' }) as SettlementOutcome);
        const dueNow = await amountDueForOrder(tx, storeId, o.id, o.grandTotal);
        const before = prior.before as OrderSnapshot;
        const result: CommitResult = { editId: prior.id, code: o.code, state: o.state, grandTotal: o.grandTotal, previousGrandTotal: before.totals.grandTotal, balance: prior.balance, amountDue: dueNow, settlement: st, replay: true, emailQueued: false };
        // A refund_now that did not finish is re-driven (idempotent by key).
        if (st.type === 'refund_now' && st.status !== 'settled' && prior.balance < 0) {
          const [pay] = st.paymentId ? await tx.select().from(s.payment).where(eq(s.payment.id, st.paymentId)).limit(1) : [];
          if (pay) return { result, plan: null, refundPlan: { amount: -prior.balance, paymentId: pay.id } };
        }
        return { result, plan: null };
      }

      const plan = await planOrderEdit(tx, storeId, input.code, input.ops, { lock: true });
      const o = plan.order;
      if (plan.after.totals.grandTotal !== input.expectedGrandTotal || (input.expectedBalance != null && plan.balance.amountDue !== input.expectedBalance)) {
        throw new OrderEditError(409, 'PREVIEW_STALE', 'the order changed since the preview — review the new totals and try again', { grandTotal: plan.after.totals.grandTotal, balance: plan.balance.amountDue });
      }
      const balance = plan.balance.amountDue;
      const settlement = validateSettlement(balance, input.settlement);
      // Pre-flight everything that can refuse, before any write.
      let refundPlan: { amount: number; paymentId: string } | undefined;
      if (settlement?.type === 'refund_now') {
        const f = refundFeasibility(plan, -balance, settlement.paymentId);
        if (!f.feasible) throw new OrderEditError(409, 'REFUND_NOT_POSSIBLE', f.reason ?? 'refund not possible', { reason: f.reason });
        refundPlan = { amount: -balance, paymentId: f.paymentId! };
      }
      if (settlement?.type === 'send_pay_link' && !plan.recipient) throw new OrderEditError(409, 'NO_RECIPIENT', 'this order has no customer email to send a pay link to');

      // ── stock (live; only the unfulfilled delta) ──────────────────────────
      const reserve: Array<{ sku: string; quantity: number }> = [];
      const reserveMap = new Map<string, VariantFacts>();
      for (const [variantId, delta] of plan.stockDeltas) {
        const v = plan.variantsById.get(variantId)!;
        if (delta < 0) {
          await tx.update(s.stock).set({ allocated: sql`greatest(${s.stock.allocated} - ${-delta}, 0)` }).where(and(eq(s.stock.variantId, variantId), eq(s.stock.storeId, storeId)));
          stockChanged = true;
        } else {
          reserve.push({ sku: v.sku, quantity: delta }); reserveMap.set(v.sku, v);
        }
      }
      if (reserve.length) {
        try { stockChanged = (await reserveStockOrThrow(tx, storeId, reserve, reserveMap)) || stockChanged; }
        catch (e) {
          if (e instanceof StockReservationError) { stockChanged = false; throw new OrderEditError(409, 'OUT_OF_STOCK', 'insufficient stock for the added quantity', { skus: e.skus }); }
          throw e;
        }
      }

      // ── lines ─────────────────────────────────────────────────────────────
      const dbLines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      for (const l of plan.working.lines) {
        const p = plan.priced.perLine.find((x) => x.key === l.key)!;
        if (!l.id) {
          await tx.insert(s.orderLine).values({
            storeId, orderId: o.id, variantId: l.variantId, variantSku: l.sku, variantName: l.name, quantity: l.quantity, unitPrice: l.unitPrice,
            lineSubtotal: p.lineSubtotal, lineDiscount: p.lineDiscount, lineTax: 0, lineTotal: p.lineTotal,
          });
          continue;
        }
        const cur = dbLines.find((x) => x.id === l.id)!;
        const placed = (cur.metadata as { vendure?: { placedQuantity?: number } } | null)?.vendure?.placedQuantity;
        const metadata = Number.isSafeInteger(placed) && placed! > l.quantity
          ? { ...(cur.metadata as object), vendure: { ...(cur.metadata as { vendure?: object }).vendure, placedQuantity: l.quantity } } : cur.metadata;
        if (cur.quantity === l.quantity && cur.unitPrice === l.unitPrice && cur.variantId === l.variantId && cur.lineSubtotal === p.lineSubtotal && cur.lineDiscount === p.lineDiscount && cur.lineTotal === p.lineTotal && cur.metadata === metadata) continue;
        await tx.update(s.orderLine).set({
          quantity: l.quantity, unitPrice: l.unitPrice, variantId: l.variantId, variantSku: l.sku, variantName: l.name,
          lineSubtotal: p.lineSubtotal, lineDiscount: p.lineDiscount, lineTax: 0, lineTotal: p.lineTotal, metadata,
        }).where(eq(s.orderLine.id, l.id));
      }

      // ── adjustments (replaced as a set; history lives in order_edit) ───────
      const keep = new Set(plan.working.adjustments.map((a) => a.id).filter((x): x is string => !!x));
      const existingAdj = await tx.select({ id: s.orderAdjustment.id }).from(s.orderAdjustment).where(eq(s.orderAdjustment.orderId, o.id));
      const drop = existingAdj.map((a) => a.id).filter((id) => !keep.has(id));
      if (drop.length) await tx.delete(s.orderAdjustment).where(inArray(s.orderAdjustment.id, drop));
      const fresh = plan.working.adjustments.filter((a) => !a.id);
      if (fresh.length) await tx.insert(s.orderAdjustment).values(fresh.map((a) => ({ storeId, orderId: o.id, label: a.label, amount: a.amount, actor: input.actor })));

      // ── promotion usage ledger ────────────────────────────────────────────
      const newPromoId = plan.promotionRow?.id ?? null;
      if ((o.promotionId ?? null) !== newPromoId) {
        if (o.promotionId) {
          const del = await tx.delete(s.promotionUsage).where(and(eq(s.promotionUsage.orderId, o.id), eq(s.promotionUsage.promotionId, o.promotionId))).returning({ id: s.promotionUsage.id });
          if (del.length) await tx.update(s.promotion).set({ usedCount: sql`greatest(${s.promotion.usedCount} - 1, 0)` }).where(eq(s.promotion.id, o.promotionId));
        }
        if (newPromoId) {
          const ins = await tx.insert(s.promotionUsage).values({ storeId, promotionId: newPromoId, customerId: o.customerId, orderId: o.id }).onConflictDoNothing().returning({ id: s.promotionUsage.id });
          if (ins.length) await tx.update(s.promotion).set({ usedCount: sql`${s.promotion.usedCount} + 1` }).where(eq(s.promotion.id, newPromoId));
        }
      }

      // ── the order row ─────────────────────────────────────────────────────
      const meta = (o.metadata ?? {}) as OrderMeta & Record<string, unknown>;
      const t = plan.priced.totals;
      let receiptToken = o.receiptToken;
      if (settlement?.type === 'send_pay_link' && !receiptToken) receiptToken = randomBytes(32).toString('base64url');
      await tx.update(s.order).set({
        subtotal: t.subtotal, discountTotal: t.discountTotal, shippingTotal: t.shippingTotal, taxTotal: t.taxTotal, grandTotal: t.grandTotal,
        isPreOrder: plan.isPreOrder, promotionId: newPromoId, shippingOverride: plan.shipping.override, receiptToken,
        // Persisted method (0086): set/cleared only when this edit changed the shipping line.
        ...(plan.working.shipping.kind !== 'keep' ? { shippingMethodCode: plan.shipping.methodCode, shippingMethodName: plan.shipping.methodName } : {}),
        shippingAddress: plan.working.shippingAddress ? addressRow(plan.working.shippingAddress) : o.shippingAddress,
        billingAddress: plan.working.billingAddress ? addressRow(plan.working.billingAddress) : o.billingAddress,
        // Record the shipping basis only when this edit set it (or one already
        // existed): a legacy order's unrecorded base is never cemented from a guess.
        metadata: plan.working.shipping.kind !== 'keep' || meta.shipping
          ? { ...meta, shipping: { methodCode: plan.shipping.methodCode, base: plan.shipping.base, override: plan.shipping.override } } : o.metadata,
        updatedAt: new Date(),
      }).where(eq(s.order.id, o.id));
      if (plan.working.saveToAddressBook) {
        if (plan.working.shippingAddress) await saveToAddressBook(tx, storeId, o.customerId, plan.working.shippingAddress);
        if (plan.working.billingAddress) await saveToAddressBook(tx, storeId, o.customerId, plan.working.billingAddress);
      }

      // ── the edit record ───────────────────────────────────────────────────
      const outcome: SettlementOutcome = { type: settlement?.type ?? 'none', status: 'none' };
      const [edit] = await tx.insert(s.orderEdit).values({
        storeId, orderId: o.id, idempotencyKey: input.idempotencyKey, fingerprint: fp,
        before: plan.before as object, after: plan.after as object, balance, settlement: outcome as object,
        reason: input.reason ?? null, actor: input.actor,
      }).returning({ id: s.orderEdit.id });
      const editId = edit!.id;

      // ── settlement parts that live inside the transaction ──────────────────
      const storefrontUrl = resolveStorefrontUrl(plan.storeCtx);
      let payUrl: string | undefined;
      if (settlement?.type === 'record_payment') {
        const amount = settlement.amount ?? balance;
        // PAYMENT-TIMING §4.6: the placement hook for an edit-recorded tender (provider 'manual') runs before the tender.
        await checkPlacement(tx, storeId, { id: o.id, storeId, code: o.code, state: o.state, currency: o.currency, grandTotal: t.grandTotal, customerId: o.customerId, metadata: o.metadata }, 'manual');
        const r = await applyPaymentResult(tx, {
          storeId, method: 'manual', amount, editId,
          order: { id: o.id, state: o.state, grandTotal: t.grandTotal, currency: o.currency, customerId: o.customerId, code: o.code },
          result: { state: 'Settled', providerRef: `manual:${editId}`, metadata: { manual: { method: settlement.method, reference: settlement.reference ?? null, recordedBy: input.actor, editId } } },
        });
        const [pay] = await tx.select({ id: s.payment.id }).from(s.payment).where(and(eq(s.payment.orderId, o.id), eq(s.payment.providerRef, `manual:${editId}`))).limit(1);
        outcome.status = 'recorded'; outcome.amount = amount; outcome.paymentId = pay?.id; outcome.paymentMethod = settlement.method; outcome.reference = settlement.reference ?? null;
        await tx.insert(s.auditLog).values({ storeId, actor: input.actor, entity: 'order', entityId: o.id, action: 'record_payment', fromState: o.state, toState: r.orderState, data: { editId, method: settlement.method, reference: settlement.reference ?? null, amount } });
      } else if (settlement?.type === 'send_pay_link') {
        payUrl = `${storefrontUrl}/orders/${encodeURIComponent(o.code)}?rt=${encodeURIComponent(receiptToken!)}&pay=balance`;
        outcome.status = 'sent';
      } else if (settlement?.type === 'leave_due') outcome.status = 'due';
      else if (settlement?.type === 'leave_credit') outcome.status = 'credit';
      else if (settlement?.type === 'refund_now') { outcome.status = 'pending'; outcome.paymentId = refundPlan!.paymentId; outcome.amount = refundPlan!.amount; }

      // ── loyalty: keep the earn on the edited merchandise ───────────────────
      // Unpaid order: the checkout snapshot is rewritten so the later payment
      // earns on the edited lines. Paid order: post the delta, but a POSITIVE
      // delta is held back until the balance is settled (see syncEditEarn).
      // Points redeemed on the order stay as stored (pointsDiscount is carried
      // into the new totals); only the earn moves with the merchandise.
      let loyaltyEarn: { delta: number; posted: number; shortfall: number; deferred?: boolean; snapshotUpdated?: boolean } | null = null;
      if (o.customerId) {
        const snap = orderLoyaltySnapshot(o.metadata);
        if (snap) {
          const target = editedEarnTarget(snap, {
            subtotal: t.subtotal, discountTotal: t.discountTotal, taxRate: plan.taxRate, taxInclusive: plan.taxInclusive,
            lines: plan.working.lines.filter((l) => l.quantity > 0 && l.variantId && plan.variantsById.get(l.variantId))
              .map((l) => ({ productId: plan.variantsById.get(l.variantId!)!.productId, cents: plan.priced.perLine.find((p) => p.key === l.key)!.lineSubtotal })),
          });
          if (target != null) {
            const dueAfter = await amountDueForOrder(tx, storeId, o.id, t.grandTotal);
            const r = await syncEditEarn(tx, { storeId, orderId: o.id, editId, targetEarn: target, actor: input.actor, settled: dueAfter <= 0 });
            if (r.delta !== 0) loyaltyEarn = r;
          }
        }
      }

      // ── customer email (one message: the summary carries the pay link) ─────
      let emailQueued = false;
      const changes = describeChanges(plan, o.currency);
      if (plan.recipient) {
        if (input.notifyCustomer) {
          emailQueued = await enqueueOrderUpdated(tx, storeId, plan.storeCtx, plan.recipient, {
            code: o.code, currency: o.currency, beforeTotal: o.grandTotal, afterTotal: t.grandTotal, changes, balance,
            payUrl, reason: input.reason ?? null, dedupeKey: `order_updated:${editId}`,
          });
        } else if (payUrl) {
          emailQueued = await enqueueOrderBalanceDue(tx, storeId, plan.storeCtx, plan.recipient, {
            code: o.code, currency: o.currency, amountDue: balance, payUrl, dedupeKey: `order_balance_due:${editId}`,
          });
        }
      }

      // ── timeline, event, settlement record ─────────────────────────────────
      const [afterRow] = await tx.select({ state: s.order.state }).from(s.order).where(eq(s.order.id, o.id)).limit(1);
      await tx.update(s.orderEdit).set({ settlement: outcome as object }).where(eq(s.orderEdit.id, editId));
      await tx.insert(s.auditLog).values({
        storeId, actor: input.actor, entity: 'order', entityId: o.id, action: 'edit', fromState: o.state, toState: afterRow?.state ?? o.state,
        data: { editId, reason: input.reason ?? null, changes, previousGrandTotal: o.grandTotal, grandTotal: t.grandTotal, balance, settlement: outcome.type, notifyCustomer: input.notifyCustomer, ...(loyaltyEarn ? { loyaltyEarn } : {}) },
      });
      await emitEvent(tx, storeId, 'order.updated', { code: o.code, editId, previousGrandTotal: o.grandTotal, grandTotal: t.grandTotal, balance, currency: o.currency, reason: input.reason ?? null });

      const dueNow = await amountDueForOrder(tx, storeId, o.id, t.grandTotal);
      // Entitlements follow money: a Paid/PartiallyRefunded order that is fully
      // funded after this edit (zero-balance swaps, credit-covered additions,
      // manual payments) gets licenses for its licensed lines now — no later
      // balance payment will ever call the settle-side reconcile. Idempotent.
      const finalState = afterRow?.state ?? o.state;
      if ((finalState === 'Paid' || finalState === 'PartiallyRefunded') && dueNow <= 0) {
        await recordSettlementOperation(tx, { storeId, kind: 'order_edit_balance_settled', operationId: editId, mutations: [], effects: editBalanceEffects({ orderId: o.id, customerId: o.customerId ?? null, deferredEarn: false }) });
      }
      return {
        plan, refundPlan,
        result: { editId, code: o.code, state: afterRow?.state ?? o.state, grandTotal: t.grandTotal, previousGrandTotal: o.grandTotal, balance, amountDue: dueNow, settlement: outcome, replay: false, emailQueued },
      };
    }).catch((e: unknown) => { stockChanged = false; return orderBusy(e); });

    if (stockChanged) { const { onStockChanged } = await import('../manifest/stock-hook.js'); onStockChanged(input.storeSlug); }

    // ── refund_now: the refund engine does gateway I/O, so it runs with no
    // transaction open. The edit is already committed; a refund that fails or
    // stays pending is reported (and recorded) rather than undoing the edit.
    if (applied.refundPlan) {
      const rp = applied.refundPlan;
      const [ord] = await withStore(storeId, (tx) => tx.select({ id: s.order.id }).from(s.order).where(eq(s.order.code, input.code)).limit(1));
      let out: SettlementOutcome = { ...applied.result.settlement, type: 'refund_now', paymentId: rp.paymentId, amount: rp.amount };
      try {
        const r = await requestRefund({
          storeId, orderId: ord!.id, actor: input.actor, idempotencyKey: `order-edit:${input.idempotencyKey}`,
          paymentId: rp.paymentId, amount: rp.amount, reason: editRefundReason(input.reason), source: 'order_edit',
        });
        out = { ...out, refundId: r.refundId, refundState: r.refundState, status: r.refundState === 'Settled' ? 'settled' : r.refundState === 'Pending' ? 'pending' : 'failed' };
        if (r.refundState === 'Failed') out.message = 'the gateway declined the refund — retry it from the order edit, or leave it as credit';
      } catch (e) {
        out = { ...out, status: 'failed', message: e instanceof RefundError ? e.message : 'refund could not be issued' };
        if (!(e instanceof RefundError)) throw e;
      }
      const final = await withStore(storeId, async (tx) => {
        await tx.update(s.orderEdit).set({ settlement: out as object }).where(eq(s.orderEdit.id, applied.result.editId));
        await tx.insert(s.auditLog).values({ storeId, actor: input.actor, entity: 'order', entityId: ord!.id, action: 'edit_refund', data: { editId: applied.result.editId, ...out } });
        const [o2] = await tx.select().from(s.order).where(eq(s.order.id, ord!.id)).limit(1);
        return { state: o2!.state, due: await amountDueForOrder(tx, storeId, ord!.id, o2!.grandTotal) };
      });
      applied.result.settlement = out; applied.result.state = final.state; applied.result.amountDue = final.due;
    }
    return applied.result;
  });
}

// ── failed edit-refund recovery ──────────────────────────────────────────────
export interface RetryEditRefundInput {
  storeId: string; code: string; editId: string; actor: string; action: 'retry' | 'credit'; paymentId?: string;
}

/**
 * An edit's refund_now that the gateway declined (settlement.status 'failed')
 * cannot be recovered from the generic Refund panel: that refund would not
 * carry source=order_edit, so the order would read as owing the money again.
 * 'retry' issues a NEW refund with the same provenance (source order_edit,
 * fresh deterministic idempotency key per attempt) for the amount currently
 * owed back; 'credit' abandons the refund and leaves the amount as store credit
 * on the order. Either updates the edit's settlement record.
 */
export async function retryOrderEditRefund(input: RetryEditRefundInput): Promise<{ editId: string; state: string; amountDue: number; settlement: SettlementOutcome }> {
  const { storeId } = input;
  return withAdvisoryLock(`pay:${storeId}:${input.code}`, async () => {
    const orderId = await lockableOrderId(storeId, input.code);
    const ctx = await withLockedSet(storeId, { kind: 'order', orderId }, async (tx) => {
      const [o] = await tx.select().from(s.order).where(and(eq(s.order.storeId, storeId), eq(s.order.code, input.code))).limit(1).for('update');
      if (!o || o.deletedAt) throw new OrderEditError(404, 'ORDER_NOT_FOUND', 'order not found');
      const [edit] = await tx.select().from(s.orderEdit).where(and(eq(s.orderEdit.storeId, storeId), eq(s.orderEdit.orderId, o.id), eq(s.orderEdit.id, input.editId))).limit(1);
      if (!edit) throw new OrderEditError(404, 'EDIT_NOT_FOUND', 'order edit not found');
      const st = await liveEditSettlement(tx, storeId, (edit.settlement ?? {}) as SettlementOutcome);
      if (st.type !== 'refund_now' || st.status !== 'failed') throw new OrderEditError(409, 'REFUND_NOT_RETRYABLE', 'this edit has no failed refund to recover');
      const amountDue = await amountDueForOrder(tx, storeId, o.id, o.grandTotal);
      if (amountDue >= 0) throw new OrderEditError(409, 'NOTHING_OWED', 'nothing is currently owed back on this order');
      const payments = await tx.select().from(s.payment).where(and(eq(s.payment.orderId, o.id), eq(s.payment.state, 'Settled')));
      const refunds = await tx.select().from(s.refund).where(and(eq(s.refund.orderId, o.id), sql`${s.refund.state} <> 'Failed'`));
      const refundable: RefundablePayment[] = payments.filter((p) => !isDuplicatePayment(p)).map((p) => ({
        id: p.id, method: p.method, amount: p.amount,
        available: p.amount - refunds.filter((r) => r.paymentId === p.id).reduce((n, r) => n + r.amount, 0),
      })).filter((p) => p.available > 0);
      const attempts = await tx.select({ id: s.paymentAttempt.id }).from(s.paymentAttempt)
        .where(and(eq(s.paymentAttempt.storeId, storeId), sql`${s.paymentAttempt.idempotencyKey} like ${`refund:order-edit:${edit.idempotencyKey}:retry:%`}`));
      return { o, edit, st, amountDue, refundable, attempt: attempts.length + 1 };
    }).catch(orderBusy);
    const { o, edit, st } = ctx;
    const finish = async (out: SettlementOutcome, auditAction: string) => withStore(storeId, async (tx) => {
      await tx.update(s.orderEdit).set({ settlement: out as object }).where(eq(s.orderEdit.id, edit.id));
      await tx.insert(s.auditLog).values({ storeId, actor: input.actor, entity: 'order', entityId: o.id, action: auditAction, data: { editId: edit.id, ...out } });
      const [o2] = await tx.select().from(s.order).where(eq(s.order.id, o.id)).limit(1);
      return { editId: edit.id, state: o2!.state, amountDue: await amountDueForOrder(tx, storeId, o.id, o2!.grandTotal), settlement: out };
    });
    if (input.action === 'credit') {
      return finish({ type: 'leave_credit', status: 'credit', amount: -ctx.amountDue, message: 'refund abandoned; left as credit on the order' }, 'edit_refund_credit');
    }
    const f = refundFeasibility({ order: o, refundable: ctx.refundable }, -ctx.amountDue, input.paymentId ?? st.paymentId);
    if (!f.feasible) throw new OrderEditError(409, 'REFUND_NOT_POSSIBLE', f.reason ?? 'refund not possible', { reason: f.reason });
    let out: SettlementOutcome = { ...st, type: 'refund_now', paymentId: f.paymentId, amount: -ctx.amountDue };
    try {
      const r = await requestRefund({
        storeId, orderId: o.id, actor: input.actor, idempotencyKey: `order-edit:${edit.idempotencyKey}:retry:${ctx.attempt}`,
        paymentId: f.paymentId, amount: -ctx.amountDue, reason: editRefundReason(edit.reason), source: 'order_edit',
      });
      out = { ...out, refundId: r.refundId, refundState: r.refundState, status: r.refundState === 'Settled' ? 'settled' : r.refundState === 'Pending' ? 'pending' : 'failed' };
      out.message = r.refundState === 'Failed' ? 'the gateway declined the refund again — retry later or leave it as credit' : undefined;
    } catch (e) {
      if (!(e instanceof RefundError)) throw e;
      out = { ...out, status: 'failed', message: e.message };
    }
    return finish(out, 'edit_refund_retry');
  });
}

// ── direct address save (G5) ─────────────────────────────────────────────────
export interface SaveAddressInput {
  storeId: string; code: string; actor: string; kind: 'shipping' | 'billing';
  address: Address; saveToAddressBook?: boolean; reason?: string;
}
export interface SaveAddressResult { code: string; kind: 'shipping' | 'billing'; address: Address; changed: boolean; savedToAddressBook: boolean }

/** Same-country (or billing) address edit on any non-cancelled order. A
 *  shipping COUNTRY change re-derives tax/shipping eligibility, so it is refused
 *  here (409 COUNTRY_CHANGE_REQUIRES_EDIT) and must go through the edit
 *  preview/commit flow that shows the resulting balance. */
export async function saveOrderAddress(input: SaveAddressInput): Promise<SaveAddressResult> {
  const { storeId } = input;
  return withStore(storeId, async (tx) => {
    const [o] = await tx.select().from(s.order).where(eq(s.order.code, input.code)).limit(1).for('update');
    if (!o || o.deletedAt) throw new OrderEditError(404, 'ORDER_NOT_FOUND', 'order not found');
    assertEditable(o.state, [{ op: 'set_address', kind: input.kind, address: input.address as never }]);
    const before = readAddress(input.kind === 'shipping' ? o.shippingAddress : o.billingAddress);
    if (input.kind === 'shipping' && countryChanged(before, input.address)) {
      throw new OrderEditError(409, 'COUNTRY_CHANGE_REQUIRES_EDIT', 'changing the shipping country changes tax and shipping — use the order edit preview', { requiresPreview: true });
    }
    const changed = !sameAddress(before, input.address);
    let saved = false;
    if (changed) {
      await tx.update(s.order).set(input.kind === 'shipping' ? { shippingAddress: addressRow(input.address), updatedAt: new Date() } : { billingAddress: addressRow(input.address), updatedAt: new Date() }).where(eq(s.order.id, o.id));
    }
    if (input.saveToAddressBook) saved = await saveToAddressBook(tx, storeId, o.customerId, input.address);
    if (changed) {
      const snap = (a: Address | null) => ({ addresses: { [input.kind]: a } });
      await tx.insert(s.orderEdit).values({ storeId, orderId: o.id, before: snap(before) as object, after: snap(input.address) as object, balance: 0, reason: input.reason ?? null, actor: input.actor });
      await tx.insert(s.auditLog).values({ storeId, actor: input.actor, entity: 'order', entityId: o.id, action: 'edit_address', fromState: o.state, toState: o.state, data: { kind: input.kind, before, after: input.address, reason: input.reason ?? null, savedToAddressBook: saved } });
      await emitEvent(tx, storeId, 'order.updated', { code: o.code, address: input.kind, currency: o.currency, reason: input.reason ?? null });
    }
    return { code: o.code, kind: input.kind, address: input.address, changed, savedToAddressBook: saved };
  });
}

// ── context for the admin UI ─────────────────────────────────────────────────
export async function loadEditContext(storeId: string, code: string) {
  return withStore(storeId, async (tx) => {
    const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
    if (!o || o.deletedAt) throw new OrderEditError(404, 'ORDER_NOT_FOUND', 'order not found');
    const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
    const adjustments = await tx.select().from(s.orderAdjustment).where(eq(s.orderAdjustment.orderId, o.id)).orderBy(asc(s.orderAdjustment.createdAt));
    const methods = await tx.select().from(s.shippingMethod).where(eq(s.shippingMethod.enabled, true));
    const history = await tx.select({ id: s.orderEdit.id, actor: s.orderEdit.actor, reason: s.orderEdit.reason, balance: s.orderEdit.balance, settlement: s.orderEdit.settlement, createdAt: s.orderEdit.createdAt, before: s.orderEdit.before, after: s.orderEdit.after })
      .from(s.orderEdit).where(eq(s.orderEdit.orderId, o.id)).orderBy(desc(s.orderEdit.createdAt)).limit(25);
    const meta = (o.metadata ?? {}) as OrderMeta;
    const amountDue = await amountDueForOrder(tx, storeId, o.id, o.grandTotal);
    const unresolved = await hasUnresolvedPayment(tx, o.id);
    const items = EDITABLE_STATES.has(o.state);
    return {
      code: o.code, state: o.state, currency: o.currency,
      editable: { items: items && !unresolved, addressOnly: !items && o.state !== 'Cancelled', address: o.state !== 'Cancelled', blockedReason: o.state === 'Cancelled' ? 'This order is cancelled.' : unresolved ? 'A payment on this order is unresolved — resolve it before editing items.' : !items ? `A ${o.state} order can only have its address edited.` : null },
      lines: lines.map((l) => ({ id: l.id, sku: l.variantSku, name: l.variantName, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal, fulfilledQty: l.fulfilledQty, refundedQty: l.refundedQty, minQuantity: lockedQty(l) })),
      adjustments: adjustments.map((a) => ({ id: a.id, label: a.label, amount: a.amount, actor: a.actor, createdAt: a.createdAt.toISOString() })),
      shipping: { amount: o.shippingTotal, override: o.shippingOverride, methodCode: o.shippingMethodCode ?? meta.shipping?.methodCode ?? null },
      shippingMethods: methods.map((m) => ({ code: m.code, name: m.name, rate: shippingRate(m.calculator) })),
      amountDue, shippingAddress: readAddress(o.shippingAddress), billingAddress: readAddress(o.billingAddress), hasCustomer: !!o.customerId,
      history: await Promise.all(history.map(async (h) => ({ id: h.id, actor: h.actor, reason: h.reason, balance: h.balance, settlement: h.settlement ? await liveEditSettlement(tx, storeId, h.settlement as SettlementOutcome) : h.settlement, createdAt: h.createdAt.toISOString(), grandTotalBefore: (h.before as { totals?: { grandTotal?: number } }).totals?.grandTotal ?? null, grandTotalAfter: (h.after as { totals?: { grandTotal?: number } }).totals?.grandTotal ?? null }))),
    };
  });
}

/** Variant picker for add / swap: enabled variants matching sku/name, with live availability. */
export async function searchEditVariants(storeId: string, q: string, limit = 20) {
  const term = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  return withStore(storeId, async (tx) => {
    const rows = await tx.select({ id: s.productVariant.id, sku: s.productVariant.sku, name: s.productVariant.name, productName: s.product.name, price: s.productVariant.price, salePrice: s.productVariant.salePrice, isPreOrder: s.productVariant.isPreOrder, preOrderPrice: s.productVariant.preOrderPrice, onHand: s.stock.onHand, allocated: s.stock.allocated })
      .from(s.productVariant).innerJoin(s.product, eq(s.product.id, s.productVariant.productId))
      .leftJoin(s.stock, eq(s.stock.variantId, s.productVariant.id))
      .where(and(eq(s.productVariant.enabled, true), isNull(s.productVariant.deletedAt), or(ilike(s.productVariant.sku, term), ilike(s.productVariant.name, term), ilike(s.product.name, term))))
      .orderBy(asc(s.productVariant.sku)).limit(Math.min(50, Math.max(1, limit)));
    const [storeRow] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
    const rule = variantPriceRuleFromConfig(storeRow?.config);
    return rows.map((r) => ({ sku: r.sku, name: r.name, productName: r.productName, unitPrice: selectUnitPrice(r, rule), available: r.onHand == null ? null : r.onHand - (r.allocated ?? 0) }));
  });
}
