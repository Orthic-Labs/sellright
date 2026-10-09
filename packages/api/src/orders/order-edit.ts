/**
 * Order editing (spec G13 / G5) — the PURE half: operation schema, the staged
 * edit state machine, line diffing, repricing and settlement validation. No
 * I/O: the DB-bound half (orders/order-edit-service.ts) loads the facts this
 * module needs, calls it, then persists the result.
 *
 * Model (differs from the refund engine on purpose — read before changing):
 *  - An existing order_line ROW is preserved across an edit (its id keeps
 *    meaning for fulfillments / refunds / licenses). Quantity is edited IN
 *    PLACE, never below `fulfilledQty + refundedQty` (the locked units).
 *  - Removed UNFULFILLED units are removed from `quantity`; they are NOT parked
 *    in `cancelledQty`. The refund engine computes refundable units and the
 *    per-unit refund amount from `quantity`/`lineTotal`, so a unit that stayed
 *    in `quantity` after being edited out could be refunded a second time. The
 *    removal is recorded in order_edit.before/after and the audit timeline.
 *  - Added items always create NEW rows.
 *  - Stock moves only for the unfulfilled delta (open = quantity - fulfilled -
 *    cancelled), computed per variant.
 */
import { z } from '@hono/zod-openapi';
import { calculateOrderTotals, type OrderTotals, type Promotion } from '../money/totals.js';

export class OrderEditError extends Error {
  constructor(public status: 400 | 404 | 409, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
    this.name = 'OrderEditError';
  }
}

// ── operation schema ─────────────────────────────────────────────────────────
const cents = z.number().int();
export const AddressInput = z.object({
  fullName: z.string().trim().max(200).nullish(),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).nullish(),
  city: z.string().trim().min(1).max(120),
  province: z.string().trim().max(120).nullish(),
  postalCode: z.string().trim().max(40).nullish(),
  country: z.string().trim().length(2).transform((v) => v.toUpperCase()),
  phone: z.string().trim().max(60).nullish(),
});
export type AddressInputT = z.infer<typeof AddressInput>;
export type Address = {
  fullName: string | null; line1: string | null; line2: string | null; city: string | null;
  province: string | null; postalCode: string | null; country: string | null; phone: string | null;
};

export const EditOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_quantity'), lineId: z.string().uuid(), quantity: z.number().int().min(0).max(100000) }),
  z.object({ op: z.literal('remove_line'), lineId: z.string().uuid() }),
  z.object({ op: z.literal('swap_variant'), lineId: z.string().uuid(), sku: z.string().min(1), quantity: z.number().int().min(1).optional() }),
  z.object({ op: z.literal('add_item'), sku: z.string().min(1), quantity: z.number().int().min(1).max(100000), unitPrice: cents.min(0).optional() }),
  z.object({ op: z.literal('apply_coupon'), code: z.string().trim().min(1).max(100) }),
  z.object({ op: z.literal('remove_coupon') }),
  z.object({ op: z.literal('set_shipping_method'), code: z.string().min(1) }),
  z.object({ op: z.literal('set_shipping_amount'), amount: cents.min(0) }),
  z.object({ op: z.literal('remove_shipping') }),
  z.object({ op: z.literal('add_adjustment'), label: z.string().trim().min(1).max(120), amount: cents.refine((n) => n !== 0, 'amount must not be 0') }),
  z.object({ op: z.literal('remove_adjustment'), adjustmentId: z.string().uuid() }),
  z.object({ op: z.literal('set_address'), kind: z.enum(['shipping', 'billing']), address: AddressInput, saveToAddressBook: z.boolean().optional() }),
]);
export type EditOpT = z.infer<typeof EditOp>;

export const Settlement = z.discriminatedUnion('type', [
  z.object({ type: z.literal('refund_now'), paymentId: z.string().uuid().optional() }),
  z.object({ type: z.literal('leave_credit') }),
  z.object({ type: z.literal('send_pay_link') }),
  z.object({
    type: z.literal('record_payment'),
    method: z.enum(['cash', 'zelle', 'check', 'card_phone', 'other']),
    reference: z.string().trim().max(200).optional(),
    amount: z.number().int().min(1).optional(),
  }),
  z.object({ type: z.literal('leave_due') }),
]);
export type SettlementT = z.infer<typeof Settlement>;

// ── working state ────────────────────────────────────────────────────────────
export interface VariantFacts {
  id: string; sku: string; name: string; price: number; salePrice: number | null;
  isPreOrder: boolean; preOrderPrice: number | null; fulfillmentType: string; enabled: boolean;
  productId: string; deletedAt?: Date | null;
}
export interface PromoFacts { id: string; code: string | null; type: Promotion['type']; value: number; freeShipping: boolean; conditions: unknown }
export interface ShippingMethodFacts { id: string; code: string; name: string; calculator: unknown }

export interface WLine {
  /** Stable key: the order_line id, or `new:<n>` for a row this edit creates. */
  key: string;
  id: string | null;
  variantId: string | null;
  sku: string;
  name: string;
  unitPrice: number;
  quantity: number;
  fulfilledQty: number;
  refundedQty: number;
  cancelledQty: number;
  /** Quantity/variant as stored before this edit (null for a new row). */
  original: { variantId: string | null; sku: string; name: string; unitPrice: number; quantity: number } | null;
  /** True when add_item supplied an explicit unit price. */
  customPrice?: boolean;
}
export interface WAdjustment { id: string | null; label: string; amount: number }

export interface WorkingOrder {
  lines: WLine[];
  adjustments: WAdjustment[];
  promotion: { kind: 'keep' } | { kind: 'none' } | { kind: 'apply'; promo: PromoFacts };
  shipping: { kind: 'keep' } | { kind: 'method'; method: ShippingMethodFacts } | { kind: 'custom'; amount: number } | { kind: 'none' };
  shippingAddress?: Address;
  billingAddress?: Address;
  saveToAddressBook: boolean;
}

export interface EditLookups {
  variantsBySku: Map<string, VariantFacts>;
  promosByCode: Map<string, PromoFacts>;
  methodsByCode: Map<string, ShippingMethodFacts>;
  unitPriceFor: (v: VariantFacts) => number;
}

/** Units that can never be removed: shipped or refunded. */
export const lockedQty = (l: { fulfilledQty: number; refundedQty: number }): number => l.fulfilledQty + l.refundedQty;
/** Units still open to ship/cancel (the stock allocation). */
export const openQty = (l: { quantity: number; fulfilledQty: number; cancelledQty: number }): number =>
  Math.max(0, l.quantity - l.fulfilledQty - l.cancelledQty);

export function normalizeAddress(a: AddressInputT): Address {
  const n = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  return {
    fullName: n(a.fullName), line1: n(a.line1), line2: n(a.line2), city: n(a.city), province: n(a.province),
    postalCode: n(a.postalCode), country: n(a.country)?.toUpperCase() ?? null, phone: n(a.phone),
  };
}

/** Read an order's stored address JSON (canonical or Vendure-ish keys) as Address. */
export function readAddress(raw: unknown): Address | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const g = (...ks: string[]) => { for (const k of ks) if (a[k] != null && String(a[k]).trim()) return String(a[k]).trim(); return null; };
  return {
    fullName: g('fullName') ?? ([g('firstName'), g('lastName')].filter(Boolean).join(' ') || null),
    line1: g('line1', 'streetLine1'), line2: g('line2', 'streetLine2'), city: g('city'),
    province: g('province', 'state'), postalCode: g('postalCode', 'postal_code', 'zip'),
    country: g('country', 'countryCode')?.toUpperCase() ?? null, phone: g('phone', 'phoneNumber'),
  };
}

export const sameAddress = (a: Address | null, b: Address | null): boolean => JSON.stringify(a) === JSON.stringify(b);
export const countryChanged = (before: Address | null, after: Address | null): boolean =>
  (before?.country ?? '') !== (after?.country ?? '');

const lineByKey = (w: WorkingOrder, id: string): WLine => {
  const l = w.lines.find((x) => x.id === id);
  if (!l) throw new OrderEditError(400, 'LINE_NOT_FOUND', 'order line not found on this order', { lineId: id });
  return l;
};

function requireVariant(lookups: EditLookups, sku: string): VariantFacts {
  const v = lookups.variantsBySku.get(sku);
  if (!v || !v.enabled || v.deletedAt) throw new OrderEditError(409, 'VARIANT_UNAVAILABLE', `variant is not available: ${sku}`, { sku });
  return v;
}

/** SKUs / coupon codes / shipping codes an op list refers to (for pre-fetching). */
export function referencedKeys(ops: EditOpT[]) {
  const skus = new Set<string>(); const coupons = new Set<string>(); const methods = new Set<string>();
  for (const op of ops) {
    if (op.op === 'add_item' || op.op === 'swap_variant') skus.add(op.sku);
    if (op.op === 'apply_coupon') coupons.add(op.code);
    if (op.op === 'set_shipping_method') methods.add(op.code);
  }
  return { skus: [...skus], coupons: [...coupons], methods: [...methods] };
}

/** Apply the staged ops in order to a copy of the working order. */
export function applyEditOps(initial: WorkingOrder, ops: EditOpT[], lookups: EditLookups): WorkingOrder {
  const w: WorkingOrder = {
    ...initial,
    lines: initial.lines.map((l) => ({ ...l })),
    adjustments: initial.adjustments.map((a) => ({ ...a })),
  };
  let seq = 0;
  for (const op of ops) {
    switch (op.op) {
      case 'set_quantity': {
        const l = lineByKey(w, op.lineId);
        const min = lockedQty(l);
        if (op.quantity < min) throw new OrderEditError(409, 'LINE_LOCKED', `${l.sku}: ${min} unit(s) already shipped or refunded and cannot be removed`, { lineId: l.id, min });
        l.quantity = op.quantity;
        break;
      }
      case 'remove_line': {
        const l = lineByKey(w, op.lineId);
        l.quantity = lockedQty(l); // everything not shipped/refunded goes
        break;
      }
      case 'swap_variant': {
        const l = lineByKey(w, op.lineId);
        const v = requireVariant(lookups, op.sku);
        const movable = l.quantity - lockedQty(l);
        if (movable <= 0) throw new OrderEditError(409, 'LINE_LOCKED', `${l.sku}: every unit is already shipped or refunded`, { lineId: l.id });
        const moved = op.quantity ?? movable;
        if (moved > movable) throw new OrderEditError(409, 'LINE_LOCKED', `${l.sku}: only ${movable} unit(s) can be swapped`, { lineId: l.id, movable });
        if (v.id === l.variantId && moved === movable) break; // swapping to itself
        const price = lookups.unitPriceFor(v);
        if (lockedQty(l) === 0 && moved === l.quantity) {
          // Nothing shipped/refunded: re-point the existing row (keeps its id).
          l.variantId = v.id; l.sku = v.sku; l.name = v.name; l.unitPrice = price;
        } else {
          l.quantity -= moved;
          w.lines.push({
            key: `new:${++seq}`, id: null, variantId: v.id, sku: v.sku, name: v.name, unitPrice: price, quantity: moved,
            fulfilledQty: 0, refundedQty: 0, cancelledQty: 0, original: null,
          });
        }
        break;
      }
      case 'add_item': {
        const v = requireVariant(lookups, op.sku);
        w.lines.push({
          key: `new:${++seq}`, id: null, variantId: v.id, sku: v.sku, name: v.name,
          unitPrice: op.unitPrice ?? lookups.unitPriceFor(v), quantity: op.quantity,
          fulfilledQty: 0, refundedQty: 0, cancelledQty: 0, original: null, customPrice: op.unitPrice != null,
        });
        break;
      }
      case 'apply_coupon': {
        const promo = lookups.promosByCode.get(op.code);
        if (!promo) throw new OrderEditError(409, 'COUPON_NOT_FOUND', `coupon not found or not active: ${op.code}`, { code: op.code });
        w.promotion = { kind: 'apply', promo };
        break;
      }
      case 'remove_coupon': w.promotion = { kind: 'none' }; break;
      case 'set_shipping_method': {
        const m = lookups.methodsByCode.get(op.code);
        if (!m) throw new OrderEditError(409, 'SHIPPING_METHOD_NOT_FOUND', `shipping method not found: ${op.code}`, { code: op.code });
        w.shipping = { kind: 'method', method: m };
        break;
      }
      case 'set_shipping_amount': w.shipping = { kind: 'custom', amount: op.amount }; break;
      case 'remove_shipping': w.shipping = { kind: 'none' }; break;
      case 'add_adjustment': w.adjustments.push({ id: null, label: op.label, amount: op.amount }); break;
      case 'remove_adjustment': {
        const i = w.adjustments.findIndex((a) => a.id === op.adjustmentId);
        if (i < 0) throw new OrderEditError(400, 'ADJUSTMENT_NOT_FOUND', 'adjustment not found on this order', { adjustmentId: op.adjustmentId });
        w.adjustments.splice(i, 1);
        break;
      }
      case 'set_address': {
        const a = normalizeAddress(op.address);
        if (op.kind === 'shipping') w.shippingAddress = a; else w.billingAddress = a;
        if (op.saveToAddressBook) w.saveToAddressBook = true;
        break;
      }
    }
  }
  return w;
}

// ── repricing ────────────────────────────────────────────────────────────────
export interface PricingInputs {
  taxRate: number; taxInclusive: boolean; shippingTaxable: boolean;
  shippingTaxRate?: number; shippingTaxInclusive?: boolean;
  promotion: Promotion | null; pointsDiscount: number; baseShipping: number;
}
export interface PricedOrder {
  totals: OrderTotals;
  /** Per working line (same order as `lines`): the stored price columns. */
  perLine: Array<{ key: string; lineSubtotal: number; lineDiscount: number; lineTotal: number }>;
}

/** Reprice the working lines through the ONE canonical totals function. Lines
 *  reduced to 0 stay on the order with zero money and are excluded from tax. */
export function priceWorkingOrder(lines: WLine[], adjustments: WAdjustment[], p: PricingInputs): PricedOrder {
  const active = lines.filter((l) => l.quantity > 0);
  const totals = calculateOrderTotals({
    lines: active.map((l) => ({ unitPrice: l.unitPrice, quantity: l.quantity })),
    shipping: p.baseShipping, taxRate: p.taxRate, taxInclusive: p.taxInclusive, shippingTaxable: p.shippingTaxable,
    shippingTaxRate: p.shippingTaxRate, shippingTaxInclusive: p.shippingTaxInclusive,
    promotion: p.promotion, pointsDiscount: p.pointsDiscount,
    adjustments: adjustments.map((a) => ({ label: a.label, amount: a.amount })),
  });
  let i = 0;
  const perLine = lines.map((l) => {
    if (l.quantity <= 0) return { key: l.key, lineSubtotal: 0, lineDiscount: 0, lineTotal: 0 };
    const t = totals.lines[i++]!;
    return { key: l.key, lineSubtotal: t.lineSubtotal, lineDiscount: t.lineDiscount, lineTotal: t.lineTotal };
  });
  return { totals, perLine };
}

// ── snapshots + diff ─────────────────────────────────────────────────────────
export interface TotalsSnap { subtotal: number; discountTotal: number; shippingTotal: number; taxTotal: number; adjustmentTotal: number; grandTotal: number }
export interface LineSnap { id: string | null; sku: string; name: string; unitPrice: number; quantity: number; lineTotal: number; fulfilledQty: number; refundedQty: number }
export interface OrderSnapshot {
  totals: TotalsSnap; lines: LineSnap[]; adjustments: Array<{ label: string; amount: number }>;
  shipping: { amount: number; override: boolean; methodCode: string | null };
  promotion: { id: string; code: string | null } | null;
  shippingAddress: Address | null; billingAddress: Address | null; isPreOrder: boolean;
}

export type LineChange = 'unchanged' | 'added' | 'removed' | 'quantity' | 'swapped' | 'repriced';
export interface LineDiff {
  lineId: string | null; sku: string; name: string; change: LineChange;
  beforeQty: number; afterQty: number; beforeTotal: number; afterTotal: number; fromSku?: string;
}

/** Per-line diff between the stored lines and the repriced working lines. */
export function diffLines(before: LineSnap[], working: WLine[], priced: PricedOrder): LineDiff[] {
  const byId = new Map(before.map((l) => [l.id, l]));
  const out: LineDiff[] = [];
  for (const l of working) {
    const t = priced.perLine.find((x) => x.key === l.key)!;
    const b = l.id ? byId.get(l.id) : undefined;
    if (!b) {
      out.push({ lineId: null, sku: l.sku, name: l.name, change: 'added', beforeQty: 0, afterQty: l.quantity, beforeTotal: 0, afterTotal: t.lineTotal });
      continue;
    }
    let change: LineChange = 'unchanged';
    if (l.original && (l.sku !== l.original.sku)) change = 'swapped';
    else if (l.quantity === 0 && b.quantity > 0) change = 'removed';
    else if (l.quantity !== b.quantity) change = 'quantity';
    else if (t.lineTotal !== b.lineTotal) change = 'repriced';
    out.push({
      lineId: l.id, sku: l.sku, name: l.name, change, beforeQty: b.quantity, afterQty: l.quantity,
      beforeTotal: b.lineTotal, afterTotal: t.lineTotal, ...(change === 'swapped' ? { fromSku: b.sku } : {}),
    });
  }
  return out;
}

// ── settlement ───────────────────────────────────────────────────────────────
export type SettlementKind = SettlementT['type'];
/** Which settlement choices are valid for a balance (+ owed, - credit owed back). */
export function allowedSettlements(balance: number): SettlementKind[] {
  if (balance < 0) return ['refund_now', 'leave_credit'];
  if (balance > 0) return ['send_pay_link', 'record_payment', 'leave_due'];
  return [];
}

/** Validate a settlement against the balance and normalise it. balance === 0
 *  needs no settlement — any supplied choice is ignored (returns null). */
export function validateSettlement(balance: number, settlement: SettlementT | undefined): SettlementT | null {
  if (balance === 0) return null;
  const allowed = allowedSettlements(balance);
  if (!settlement) throw new OrderEditError(400, 'SETTLEMENT_REQUIRED', `choose how to settle the ${balance > 0 ? 'amount due' : 'credit'}`, { allowed });
  if (!allowed.includes(settlement.type)) {
    throw new OrderEditError(400, 'SETTLEMENT_INVALID', `${settlement.type} is not valid when the balance is ${balance > 0 ? 'due' : 'a credit'}`, { allowed });
  }
  if (settlement.type === 'record_payment' && settlement.amount != null && settlement.amount > balance) {
    throw new OrderEditError(400, 'SETTLEMENT_INVALID', 'recorded payment exceeds the amount due', { balance });
  }
  return settlement;
}
