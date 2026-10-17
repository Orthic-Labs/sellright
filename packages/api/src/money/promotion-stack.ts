import { evaluatePromotionConditions, type CouponContext } from './coupon.js';
import type { OrderTotals, TotalsInput } from './totals.js';
import { promotionQuoteHash } from './pricing-snapshot.js';

export type PricingPhase = 'AddingItems' | 'ArrangingPayment' | 'PaymentSettled';
export interface SignedAdjustment { amount: number; units?: readonly number[]; promotionId?: string; kind: 'item' | 'order' }
export interface StackLine {
  key: string; quantity: number; placedQuantity: number; unitListPrice: number;
  priceIncludesTax: boolean; taxRateBps: number; priorAdjustments?: SignedAdjustment[];
}
export interface ResolvedPromotion {
  id: string; code: string | null; kind: 'percentage' | 'fixed' | 'free_shipping' | 'account_credit';
  scope: 'order' | 'line'; value: number; priority: number; sequence: number;
  freeShipping: boolean; conditions: unknown;
  credit?: { accountId: string; availableCents: number };
}
export interface StackInput {
  lines: StackLine[]; promotions: ResolvedPromotion[]; couponCodes: string[]; phase: PricingPhase; currency: string;
  pricesIncludeTax: boolean; shipping: number; shippingTaxRateBps: number; shippingIncludesTax: boolean;
  couponContext: Pick<CouponContext, 'activeVerifications' | 'items'>;
  pointsDiscount?: number; adjustments?: TotalsInput['adjustments'];
}
export interface StackCouponStatus {
  code: string; promotionId: string | null; kind?: ResolvedPromotion['kind']; applied: boolean; reason?: string;
  appliedAmount?: number; availableAmount?: number; remainingAmount?: number;
}
export interface AppliedPromotion {
  promotionId: string; kind: ResolvedPromotion['kind']; basis: 'net' | 'gross'; amount: number; amountWithTax: number;
  /** Requested action before source line caps & placed-quantity division. */
  requestedAmount?: number;
  /** amount/units are effective rounded channel-basis deltas; source fields
   * preserve stored clamped adjustment & original pre-clamp unit provenance. */
  lineAllocations: { lineKey: string; amount: number; units: number[]; sourceAdjustmentAmount?: number; sourceUnits?: number[];
    sourceDiscountAmount?: number; sourceDiscountAmountWithTax?: number }[];
}
export interface PromotionStackTotals extends OrderTotals {
  pricingProfile: 'captured-default-v1';
  coupons: StackCouponStatus[]; applied: AppliedPromotion[];
  lineSnapshots: { lineKey: string; quantity: number; proratedUnitPriceWithTax: number; lineNet: number; lineGross: number }[];
  selectedCredit: { accountId: string; promotionId: string; appliedAmount: number; allocation: Record<string, number[]> } | null;
  quoteHash: string;
  /** Internal resolver evidence for snapshot construction; route projections
   * expose only cart-safe coupon statuses & monetary facts. */
  resolvedPromotions?: ResolvedPromotion[];
}
export type StackResult = PromotionStackTotals;
export class PromotionStackError extends Error {
  constructor(readonly code: 'CREDIT_AMOUNT_CHANGED' | 'CREDIT_ALLOCATION_INVALID', message: string) { super(message); this.name = 'PromotionStackError'; }
}

const MAX_CENTS = 2_147_483_647;
function integer(value: number, label: string, min = 0, max = MAX_CENTS): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must fit integer cents`);
  return value;
}
function sum(values: readonly number[]): number { return integer(values.reduce((total, value) => total + value, 0), 'Money sum', -MAX_CENTS); }
const rounded = (value: number) => integer(Math.round(value) || 0, 'Rounded money', -MAX_CENTS);

/** Coupon identity is case-insensitive; whitespace belongs to generic codes. */
export function canonicalCouponCodes(codes: readonly string[]): string[] {
  const seen = new Set<string>();
  return codes.filter(code => {
    if (typeof code !== 'string' || !code.length || code.length > 255) throw new Error('Invalid coupon code');
    const key = code.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** Captured Vendure default prorate: floor SIGNED shares, then +1 to greatest
 * fractional error, with original sequence breaking ties. Never negate first. */
export function prorateSigned(weights: readonly number[], amount: number): number[] {
  integer(amount, 'Proration amount', -MAX_CENTS);
  if (!weights.length) {
    if (amount !== 0) throw new Error('Cannot distribute money without units');
    return [];
  }
  for (const weight of weights) integer(weight, 'Proration weight');
  const total = sum(weights);
  const actual = weights.map(weight => total === 0 ? amount / weights.length : amount * (weight / total));
  const shares = actual.map(value => Math.floor(value));
  let missing = amount - sum(shares);
  const order = actual.map((value, index) => ({ index, error: value - shares[index]! }))
    .sort((a, b) => b.error - a.error || a.index - b.index);
  for (const part of order) {
    if (missing <= 0) break;
    shares[part.index]! += 1; missing -= 1;
  }
  if (missing !== 0 || sum(shares) !== amount) throw new Error('Signed proration did not conserve money');
  return shares.map(value => value || 0);
}

interface WorkingLine { input: StackLine; adjustments: number[] }
function facts(line: WorkingLine) {
  const { input } = line;
  const adjustment = input.quantity === 0 ? 0 : sum(line.adjustments) / Math.max(input.placedQuantity, input.quantity);
  const list = input.unitListPrice + adjustment;
  if (list < 0) throw new Error('Discount distribution exceeds line basis');
  const factor = 1 + input.taxRateBps / 10000;
  const net = input.priceIncludesTax ? list / factor : list;
  const gross = input.priceIncludesTax ? list : list * factor;
  return { lineNet: rounded(net * input.quantity), lineGross: rounded(gross * input.quantity),
    unitNet: rounded(net), unitGross: rounded(gross), list };
}
const totals = (lines: readonly WorkingLine[]) => ({ net: sum(lines.map(line => facts(line).lineNet)), gross: sum(lines.map(line => facts(line).lineGross)) });

/** Pure captured-default profile. Runtime provenance must be established by
 * integration before claiming a merchant's custom strategy matches this one. */
export function calculatePromotionStack(input: StackInput): PromotionStackTotals {
  if (!['AddingItems', 'ArrangingPayment', 'PaymentSettled'].includes(input.phase) || !/^[A-Z]{3}$/.test(input.currency)) throw new Error('Invalid pricing context');
  integer(input.shipping, 'Shipping'); integer(input.shippingTaxRateBps, 'Shipping tax rate');
  const codes = canonicalCouponCodes(input.couponCodes);
  const keys = new Set<string>();
  const lines: WorkingLine[] = input.lines.map(line => {
    if (!line.key || keys.has(line.key)) throw new Error('Line keys must be unique');
    keys.add(line.key);
    integer(line.quantity, 'Quantity'); integer(line.placedQuantity, 'Placed quantity');
    integer(line.unitListPrice, 'Unit price'); integer(line.taxRateBps, 'Tax rate');
    integer(line.unitListPrice * line.quantity, 'Line price');
    const adjustments = (line.priorAdjustments ?? []).map(adjustment => integer(adjustment.amount, 'Prior adjustment', -MAX_CENTS, 0));
    return { input: line, adjustments };
  });
  const before = totals(lines.map(line => ({ ...line, adjustments: [] })));
  const promotions = [...input.promotions].sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
  const identities = new Set<string>();
  for (const promotion of promotions) {
    if (!promotion.id || identities.has(promotion.id)) throw new Error('Promotion identities must be unique');
    identities.add(promotion.id);
    integer(promotion.priority, 'Promotion priority', -MAX_CENTS); integer(promotion.sequence, 'Promotion sequence');
    if (!['percentage', 'fixed', 'free_shipping', 'account_credit'].includes(promotion.kind) || !['order', 'line'].includes(promotion.scope)) throw new Error('Unsupported promotion');
    if (promotion.kind === 'percentage') {
      if (!Number.isFinite(promotion.value) || promotion.value < 0 || promotion.value > 100) throw new Error('Invalid percentage');
    } else integer(promotion.value, 'Promotion value');
    if (promotion.kind === 'account_credit') {
      if (!promotion.credit || promotion.scope !== 'order') throw new Error('Credit must be an order action');
      integer(promotion.credit.availableCents, 'Credit budget');
    }
  }
  for (const line of input.lines) for (const adjustment of line.priorAdjustments ?? []) {
    if (adjustment.kind !== 'item' && adjustment.kind !== 'order') throw new Error('Invalid prior adjustment kind');
    if (adjustment.kind === 'order' && adjustment.promotionId && identities.has(adjustment.promotionId)) throw new Error('Current order promotion already present in prior adjustments');
  }
  const applied: AppliedPromotion[] = [];
  const accepted = new Set<string>();
  const reasons = new Map<string, string>();
  const eligible = (promotion: ResolvedPromotion) => {
    if (promotion.code != null && !codes.some(code => code.toLowerCase() === promotion.code!.toLowerCase())) return false;
    if (promotion.code != null && promotions.filter(item => item.code?.toLowerCase() === promotion.code!.toLowerCase()).length !== 1) {
      reasons.set(promotion.id, 'Ambiguous coupon code'); return false;
    }
    if (promotion.kind === 'account_credit' && promotion.credit!.availableCents <= 0) {
      reasons.set(promotion.id, 'Credit unavailable'); return false;
    }
    const current = totals(lines);
    const check = evaluatePromotionConditions(promotion.conditions, { ...input.couponContext,
      subtotal: input.pricesIncludeTax ? current.gross : current.net, netSubtotal: current.net, grossSubtotal: current.gross });
    if (!check.valid) reasons.set(promotion.id, check.reason ?? 'Promotion conditions not met');
    return check.valid;
  };
  const record = (promotion: ResolvedPromotion, amount: number, grossBefore: number, allocations: AppliedPromotion['lineAllocations'], requestedAmount = amount) => {
    let entry = applied.find(item => item.promotionId === promotion.id);
    if (!entry) {
      entry = { promotionId: promotion.id, kind: promotion.kind, basis: input.pricesIncludeTax ? 'gross' : 'net', amount: 0, amountWithTax: 0, lineAllocations: [] };
      applied.push(entry);
    }
    entry.amount = sum([entry.amount, amount]);
    entry.requestedAmount = sum([entry.requestedAmount ?? 0, requestedAmount]);
    entry.amountWithTax = sum([entry.amountWithTax, totals(lines).gross - grossBefore]);
    for (const allocation of allocations) {
      const existing = entry.lineAllocations.find(item => item.lineKey === allocation.lineKey);
      if (!existing) entry.lineAllocations.push(allocation);
      else {
        existing.amount = sum([existing.amount, allocation.amount]);
        existing.units = existing.units.map((unit, index) => sum([unit, allocation.units[index] ?? 0]));
        existing.sourceAdjustmentAmount = sum([existing.sourceAdjustmentAmount ?? 0, allocation.sourceAdjustmentAmount ?? 0]);
        existing.sourceUnits = (existing.sourceUnits ?? []).map((unit, index) => sum([unit, allocation.sourceUnits?.[index] ?? 0]));
        existing.sourceDiscountAmount = sum([existing.sourceDiscountAmount ?? 0, allocation.sourceDiscountAmount ?? 0]);
        existing.sourceDiscountAmountWithTax = sum([existing.sourceDiscountAmountWithTax ?? 0, allocation.sourceDiscountAmountWithTax ?? 0]);
      }
    }
    accepted.add(promotion.id);
  };
  const addAdjustment = (line: WorkingLine, requested: number): AppliedPromotion['lineAllocations'][number] => {
    const before = facts(line);
    const sourceAdjustmentAmount = Math.max(-(line.input.priceIncludesTax ? before.lineGross : before.lineNet), requested);
    const sourceUnits = prorateSigned(Array(line.input.quantity).fill(1), requested);
    if (sourceAdjustmentAmount !== 0) line.adjustments.push(sourceAdjustmentAmount);
    const after = facts(line);
    const amount = input.pricesIncludeTax ? after.lineGross - before.lineGross : after.lineNet - before.lineNet;
    const exposed = sourceAdjustmentAmount * line.input.quantity / Math.max(line.input.placedQuantity, line.input.quantity);
    const factor = 1 + line.input.taxRateBps / 10000;
    return { lineKey: line.input.key, amount, units: prorateSigned(Array(line.input.quantity).fill(1), amount), sourceAdjustmentAmount, sourceUnits,
      sourceDiscountAmount: rounded(line.input.priceIncludesTax ? exposed / factor : exposed),
      sourceDiscountAmountWithTax: rounded(line.input.priceIncludesTax ? exposed : exposed * factor) };
  };
  // Item stage: preserve line sequence & re-test conditions after each action.
  for (const line of lines) for (const promotion of promotions) {
    if (promotion.scope !== 'line' || promotion.kind === 'free_shipping' || !line.input.quantity || !eligible(promotion)) continue;
    const current = facts(line); const grossBefore = totals(lines).gross;
    const basis = line.input.priceIncludesTax ? current.lineGross : current.lineNet;
    const requested = promotion.kind === 'percentage' ? rounded(-basis * promotion.value / 100) : -Math.min(promotion.value, basis);
    const allocation = addAdjustment(line, requested);
    record(promotion, allocation.amount, grossBefore, [allocation], requested);
  }
  // Order stage: each earlier promotion changes later conditions & credit caps.
  for (const promotion of promotions) {
    if (promotion.scope !== 'order' || promotion.kind === 'free_shipping' || !eligible(promotion)) continue;
    const current = totals(lines);
    const basis = input.pricesIncludeTax ? current.gross : current.net;
    const budget = promotion.kind === 'account_credit' ? promotion.credit!.availableCents : promotion.value;
    const amount = promotion.kind === 'percentage' ? rounded(-basis * budget / 100) : -Math.min(budget, Math.max(0, basis));
    const active = lines.filter(line => line.input.quantity > 0);
    const shares = active.length ? prorateSigned(active.map(line => facts(line).lineGross), amount) : [];
    const allocations = active.map((line, index) => addAdjustment(line, shares[index]!));
    record(promotion, sum(allocations.map(allocation => allocation.amount)), current.gross, allocations, amount);
  }
  const afterPromotions = totals(lines);
  const merchandiseBasis = input.pricesIncludeTax ? afterPromotions.gross : afterPromotions.net;
  let pointsDiscount = Math.min(integer(input.pointsDiscount ?? 0, 'Points discount'), merchandiseBasis);
  if (pointsDiscount) {
    const active = lines.filter(line => line.input.quantity > 0);
    const shares = prorateSigned(active.map(line => facts(line).lineGross), -pointsDiscount);
    pointsDiscount = -sum(active.map((line, index) => addAdjustment(line, shares[index]!).amount));
  }
  const final = totals(lines);
  // Shipping is quoted by caller from discounted merchandise, then its actions
  // re-test current conditions. A combined action may lose its shipping benefit.
  let shippingTotal = input.shipping;
  for (const promotion of promotions) {
    if ((promotion.kind !== 'free_shipping' && !promotion.freeShipping) || !eligible(promotion)) continue;
    const old = shippingTotal; shippingTotal = 0;
    record(promotion, -old, final.gross, []);
    const entry = applied.find(item => item.promotionId === promotion.id)!;
    entry.amountWithTax = sum([entry.amountWithTax, -(input.shippingIncludesTax ? old : rounded(old * (1 + input.shippingTaxRateBps / 10000)))]);
  }
  const shippingNet = input.shippingIncludesTax ? rounded(shippingTotal / (1 + input.shippingTaxRateBps / 10000)) : shippingTotal;
  const shippingGross = input.shippingIncludesTax ? shippingTotal : rounded(shippingTotal * (1 + input.shippingTaxRateBps / 10000));
  const adjustmentTotal = sum((input.adjustments ?? []).map(adjustment => integer(adjustment.amount, 'Order adjustment', -MAX_CENTS)));
  const taxableAdjustment = sum((input.adjustments ?? []).filter(adjustment => adjustment.taxable).map(adjustment => adjustment.amount));
  const adjustmentRate = lines[0]?.input.taxRateBps ?? 0;
  const adjustmentTax = input.pricesIncludeTax
    ? taxableAdjustment - rounded(taxableAdjustment / (1 + adjustmentRate / 10000))
    : rounded(taxableAdjustment * adjustmentRate / 10000);
  const coupons = codes.map((code): StackCouponStatus => {
    const matches = promotions.filter(promotion => promotion.code?.toLowerCase() === code.toLowerCase());
    const promotion = matches.length === 1 ? matches[0] : undefined;
    const entry = promotion ? applied.find(item => item.promotionId === promotion.id) : undefined;
    const discount = entry ? -entry.amount || 0 : 0;
    return promotion ? { code, promotionId: promotion.id, kind: promotion.kind, applied: accepted.has(promotion.id), appliedAmount: discount,
      ...(promotion.credit ? { availableAmount: promotion.credit.availableCents, remainingAmount: Math.max(0, promotion.credit.availableCents - discount) } : {}),
      ...(!accepted.has(promotion.id) ? { reason: reasons.get(promotion.id) ?? 'Promotion not applicable' } : {}) }
      : { code, promotionId: null, applied: false, reason: matches.length > 1 ? 'Ambiguous coupon code' : 'Coupon unavailable' };
  });
  const selectedPromotion = codes.map(code => promotions.find(promotion => promotion.kind === 'account_credit' && promotion.code?.toLowerCase() === code.toLowerCase())).find(Boolean);
  const selectedEntry = selectedPromotion ? applied.find(entry => entry.promotionId === selectedPromotion.id) : undefined;
  let selectedCredit: PromotionStackTotals['selectedCredit'] = null;
  if (selectedPromotion && selectedEntry && selectedPromotion.credit) {
    const sourceDebit = -sum(selectedEntry.lineAllocations.map(allocation => input.pricesIncludeTax ? allocation.sourceDiscountAmountWithTax ?? 0 : allocation.sourceDiscountAmount ?? 0)) || 0;
    if (sourceDebit < 1 || sourceDebit > selectedPromotion.credit.availableCents) throw new PromotionStackError('CREDIT_AMOUNT_CHANGED', 'Credit amount changed; remove & reapply coupon');
    const allocation = Object.fromEntries(lines.map(line => {
      const original = selectedEntry.lineAllocations.find(part => part.lineKey === line.input.key);
      const purchased = Math.max(line.input.placedQuantity, line.input.quantity);
      const units = original?.sourceAdjustmentAmount ? original.sourceUnits : Array(purchased).fill(0);
      if (!units || units.length !== purchased || units.some(unit => !Number.isSafeInteger(unit) || unit > 0)) throw new PromotionStackError('CREDIT_ALLOCATION_INVALID', 'Credit unit allocation unavailable');
      return [line.input.key, units.map(unit => -unit || 0)];
    }));
    if (sum(Object.values(allocation).flat()) !== sourceDebit) throw new PromotionStackError('CREDIT_ALLOCATION_INVALID', 'Credit allocation does not match source debit');
    selectedCredit = { accountId: selectedPromotion.credit.accountId, promotionId: selectedPromotion.id, appliedAmount: sourceDebit, allocation };
  }
  const subtotal = input.pricesIncludeTax ? before.gross : before.net;
  const discountTotal = subtotal - (input.pricesIncludeTax ? final.gross : final.net);
  const result: PromotionStackTotals = {
    pricingProfile: 'captured-default-v1',
    lines: lines.map(line => { const current = facts(line); const original = line.input.unitListPrice * line.input.quantity;
      return { unitPrice: line.input.unitListPrice, quantity: line.input.quantity, lineSubtotal: original,
        lineDiscount: original - (line.input.priceIncludesTax ? current.lineGross : current.lineNet),
        lineTotal: line.input.priceIncludesTax ? current.lineGross : current.lineNet }; }),
    subtotal, discountTotal, shippingTotal, taxTotal: sum([final.gross - final.net, shippingGross - shippingNet, adjustmentTax]),
    grandTotal: Math.max(0, sum([final.gross, shippingGross, adjustmentTotal, input.pricesIncludeTax ? 0 : adjustmentTax])), pointsDiscount,
    ...(input.adjustments ? { adjustmentTotal } : {}), coupons, applied,
    lineSnapshots: lines.map(line => { const current = facts(line); return { lineKey: line.input.key, quantity: line.input.quantity,
      proratedUnitPriceWithTax: current.unitGross, lineNet: current.lineNet, lineGross: current.lineGross }; }),
    selectedCredit, quoteHash: '', resolvedPromotions: promotions,
  };
  result.quoteHash = promotionQuoteHash({ ...input, couponCodes: codes }, result);
  return result;
}
