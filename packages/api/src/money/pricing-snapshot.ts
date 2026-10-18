import { createHash } from 'node:crypto';
import type { StackInput, StackLine, PromotionStackTotals, AppliedPromotion } from './promotion-stack.js';

export type MoneyTotals = Pick<PromotionStackTotals, 'subtotal' | 'discountTotal' | 'shippingTotal' | 'taxTotal' | 'grandTotal' | 'pointsDiscount'>;
type SnapshotAppliedPromotion = Omit<AppliedPromotion, 'lineAllocations'> & {
  priority: number; sequence: number; scope: 'order' | 'line';
  lineAllocations: Array<AppliedPromotion['lineAllocations'][number] & { orderLineId: string }>;
};
export interface OrderPricingSnapshotV1 {
  version: 1; currency: string; pricesIncludeTax: boolean; couponCodes: string[]; quoteHash: string;
  pricingProfile: 'captured-default-v1';
  retainedShipping?: StackInput['retainedShipping'];
  retainedShippingFinal?: PromotionStackTotals['retainedShippingFinal'];
  shippingBasis: { amount: number; taxRateBps: number; includesTax: boolean; taxable: boolean };
  pointsDiscount: number; adjustments: NonNullable<StackInput['adjustments']>;
  totals: MoneyTotals;
  lines: Array<StackLine & { orderLineId: string; proratedUnitPriceWithTax: number; lineNet: number; lineGross: number }>;
  applied: SnapshotAppliedPromotion[];
  selectedCredit: { accountId: string; promotionId: string; appliedAmount: number; allocation: Record<string, number[]> } | null;
}

const MAX = 2_147_483_647;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireValue(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`Invalid pricing snapshot: ${message}`); }
function cents(value: unknown, signed = false): asserts value is number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value <= MAX && value >= (signed ? -MAX : 0), 'money must fit integer cents');
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
function economicTotals(result: MoneyTotals): MoneyTotals {
  return { subtotal: result.subtotal, discountTotal: result.discountTotal, shippingTotal: result.shippingTotal,
    taxTotal: result.taxTotal, grandTotal: result.grandTotal, pointsDiscount: result.pointsDiscount };
}

/** Hash economic facts only. Line positions survive provisional UUID replacement. */
export function promotionQuoteHash(input: StackInput, result: Omit<PromotionStackTotals, 'quoteHash'>): string {
  const index = new Map(input.lines.map((line, i) => [line.key, i]));
  const lineIndex = (key: string) => { const n = index.get(key); requireValue(n !== undefined, 'unknown quote line'); return n; };
  const hashInput = {
    version: 1, currency: input.currency, pricesIncludeTax: input.pricesIncludeTax, couponCodes: input.couponCodes,
    pricingProfile: result.pricingProfile,
    lines: input.lines.map(({ key, ...line }) => ({ ...line, snapshot: result.lineSnapshots.find(item => item.lineKey === key) &&
      (({ lineKey: _key, sourceAdjustmentTotal: _sum, sourceAdjustmentDivisor: _divisor, ...snapshot }) => snapshot)(result.lineSnapshots.find(item => item.lineKey === key)!) })),
    shippingBasis: { amount: input.shipping, taxRateBps: input.shippingTaxRateBps, includesTax: input.shippingIncludesTax, taxable: input.shippingTaxRateBps !== 0 },
    pointsDiscount: input.pointsDiscount ?? 0, adjustments: input.adjustments ?? [], totals: economicTotals(result),
    ...(input.retainedShipping ? { retainedShipping: input.retainedShipping, retainedShippingFinal: result.retainedShippingFinal } : {}),
    applied: result.applied.map(entry => ({ ...entry,
      scope: input.promotions.find(p => p.id === entry.promotionId)?.scope,
      priority: input.promotions.find(p => p.id === entry.promotionId)?.priority,
      sequence: input.promotions.find(p => p.id === entry.promotionId)?.sequence,
      lineAllocations: entry.lineAllocations.map(({ lineKey, ...allocation }) => ({ ...allocation, line: lineIndex(lineKey) })) })),
    selectedCredit: result.selectedCredit ? { ...result.selectedCredit,
      allocation: input.lines.map(line => result.selectedCredit!.allocation[line.key] ?? []) } : null,
  };
  return createHash('sha256').update(JSON.stringify(stable(hashInput))).digest('hex');
}

export function buildOrderPricingSnapshot(input: StackInput, result: PromotionStackTotals, orderLineIds: ReadonlyMap<string, string>): OrderPricingSnapshotV1 {
  requireValue(orderLineIds.size === input.lines.length && new Set(orderLineIds.values()).size === input.lines.length, 'line mapping must be bijective');
  const mapped = (key: string) => { const id = orderLineIds.get(key); requireValue(id && uuid.test(id), 'missing native line UUID'); return id; };
  requireValue(result.quoteHash === promotionQuoteHash(input, result), 'quote hash differs');
  const snapshot: OrderPricingSnapshotV1 = {
    version: 1, pricingProfile: result.pricingProfile, currency: input.currency, pricesIncludeTax: input.pricesIncludeTax,
    couponCodes: [...input.couponCodes], quoteHash: result.quoteHash, totals: economicTotals(result),
    shippingBasis: { amount: input.shipping, taxRateBps: input.shippingTaxRateBps, includesTax: input.shippingIncludesTax, taxable: input.shippingTaxRateBps !== 0 },
    pointsDiscount: input.pointsDiscount ?? 0, adjustments: structuredClone(input.adjustments ?? []),
    ...(input.retainedShipping ? { retainedShipping: structuredClone(input.retainedShipping), retainedShippingFinal: structuredClone(result.retainedShippingFinal) } : {}),
    lines: input.lines.map(line => { const facts = result.lineSnapshots.find(item => item.lineKey === line.key);
      requireValue(facts, 'missing line facts'); const { lineKey: _key, sourceAdjustmentTotal: _sum, sourceAdjustmentDivisor: _divisor, ...rest } = facts;
      return { ...structuredClone(line), ...rest, orderLineId: mapped(line.key) }; }),
    applied: result.applied.map(entry => { const promo = input.promotions.find(p => p.id === entry.promotionId); requireValue(promo, 'missing applied promotion');
      return { ...structuredClone(entry), priority: promo.priority, sequence: promo.sequence, scope: promo.scope,
        lineAllocations: entry.lineAllocations.map(a => ({ ...structuredClone(a), orderLineId: mapped(a.lineKey) })) }; }),
    selectedCredit: result.selectedCredit ? { ...result.selectedCredit,
      allocation: Object.fromEntries(Object.entries(result.selectedCredit.allocation).map(([key, units]) => [mapped(key), [...units]])) } : null,
  };
  return readOrderPricingSnapshot(snapshot, { currency: input.currency, orderLines: snapshot.lines.map(line => ({ id: line.orderLineId, quantity: line.quantity })), mode: 'settlement', totals: result })!;
}

/** Null is legacy; malformed or unproven snapshots fail closed. */
export function readOrderPricingSnapshot(raw: unknown, context: { currency: string; orderLines: Array<{ id: string; quantity: number }>; mode: 'settlement' | 'refund'; totals?: MoneyTotals }): OrderPricingSnapshotV1 | null {
  if (raw == null) return null;
  requireValue(typeof raw === 'object' && !Array.isArray(raw), 'object required');
  const snap = raw as OrderPricingSnapshotV1;
  requireValue(snap.version === 1 && snap.pricingProfile === 'captured-default-v1' && snap.currency === context.currency && /^[A-Z]{3}$/.test(snap.currency), 'version/currency/profile');
  requireValue(typeof snap.pricesIncludeTax === 'boolean' && Array.isArray(snap.couponCodes) && snap.couponCodes.every(code => typeof code === 'string' && code.length > 0), 'coupon stack');
  requireValue(new Set(snap.couponCodes.map(code => code.toLowerCase())).size === snap.couponCodes.length, 'duplicate code');
  requireValue(snap.totals && snap.shippingBasis && Array.isArray(snap.lines) && Array.isArray(snap.applied) && Array.isArray(snap.adjustments), 'economic facts');
  // Negative taxable surcharges can outweigh positive merchandise tax.
  for (const [key, amount] of Object.entries(economicTotals(snap.totals))) cents(amount, key === 'taxTotal' || (key === 'shippingTotal' && !!snap.retainedShipping) || (key === 'grandTotal' && (!!snap.retainedShipping || snap.adjustments.some(a=>a.sourceSurcharge))));
  cents(snap.shippingBasis.amount, !!snap.retainedShipping); cents(snap.shippingBasis.taxRateBps); cents(snap.pointsDiscount);
  requireValue(typeof snap.shippingBasis.includesTax === 'boolean' && typeof snap.shippingBasis.taxable === 'boolean', 'shipping tax basis');
  for (const a of snap.adjustments) { requireValue(a && typeof a === 'object', 'adjustment'); cents(a.amount, true); }
  if (snap.retainedShipping) {
    const shipping = snap.retainedShipping, final = snap.retainedShippingFinal;
    requireValue(/^[a-f0-9]{64}$/.test(shipping.sourceDigest) && ['keep', 'revalidate-promotions', 'recalculate-keep-promotions'].includes(shipping.mode) && Array.isArray(shipping.lines) && Array.isArray(final) && final.length === shipping.lines.length, 'retained shipping vector');
    const ids = new Set<string>();
    shipping.lines.forEach((l, i) => { requireValue(typeof l.sourceId === 'string' && l.sourceId && !ids.has(l.sourceId) && final[i]?.sourceId === l.sourceId, 'retained shipping identity'); ids.add(l.sourceId); cents(l.net, true); cents(l.gross, true); cents(final[i]!.net, true); cents(final[i]!.gross, true); });
    requireValue(shipping.lines.reduce((n,l)=>n+l.net,0) === snap.shippingBasis.amount && final.reduce((n,l)=>n+l.net,0) === snap.totals.shippingTotal, 'retained shipping sums');
    const actions = snap.applied.filter(e => e.shippingAdjustment !== undefined);
    for (const e of actions) { cents(e.shippingAdjustment!.net, true); cents(e.shippingAdjustment!.gross, true); requireValue(e.shippingAdjustment!.net === e.amount - e.lineAllocations.reduce((n,l)=>n+l.amount,0), 'shipping action net'); }
    const waived = actions.length > 0;
    requireValue(shipping.mode === 'revalidate-promotions' || !waived, 'kept shipping action');
    if (shipping.repricedBasis !== undefined || shipping.mode === 'recalculate-keep-promotions') {
      requireValue(shipping.mode !== 'keep', 'unexpected shipping repricing basis');
      requireValue(Array.isArray(shipping.repricedBasis) && shipping.repricedBasis.length === shipping.lines.length, 'shipping repricing basis');
      shipping.repricedBasis.forEach((b,i)=>{ requireValue(b.sourceId === shipping.lines[i]!.sourceId && typeof b.includesTax === 'boolean', 'shipping repricing identity'); cents(b.amount,true); cents(b.taxRateBps); });
    }
    if (shipping.carriers !== undefined) {
      requireValue(Array.isArray(shipping.carriers) && shipping.carriers.length === shipping.lines.length, 'shipping carrier closure');
      const members = new Set<string>(), keys = new Set(snap.lines.map(line=>line.key));
      shipping.carriers.forEach((carrier,index)=>{
        requireValue(carrier.sourceId === shipping.lines[index]!.sourceId && (carrier.methodCode === null || typeof carrier.methodCode === 'string' && carrier.methodCode.length > 0) && Array.isArray(carrier.lineKeys), 'shipping carrier identity');
        for (const key of carrier.lineKeys) { requireValue(typeof key === 'string' && keys.has(key) && !members.has(key), 'shipping carrier membership'); members.add(key); }
      });
    }
    requireValue(final.every((l,i) => l.net === (waived ? 0 : shipping.lines[i]!.net) && l.gross === (waived ? 0 : shipping.lines[i]!.gross)), 'shipping final action');
    requireValue(actions.reduce((n,e)=>n+e.shippingAdjustment!.net,0) === final.reduce((n,l)=>n+l.net,0)-shipping.lines.reduce((n,l)=>n+l.net,0) && actions.reduce((n,e)=>n+e.shippingAdjustment!.gross,0) === final.reduce((n,l)=>n+l.gross,0)-shipping.lines.reduce((n,l)=>n+l.gross,0), 'shipping action vector');
  } else requireValue(snap.retainedShippingFinal === undefined && !snap.applied.some(e=>e.shippingAdjustment !== undefined), 'unbound source shipping');
  const chargeIds = new Set<string>();
  for (const a of snap.adjustments) if (a.sourceSurcharge) { const charge = a.sourceSurcharge; requireValue(charge.sourceId && !chargeIds.has(charge.sourceId) && /^[a-f0-9]{64}$/.test(charge.sourceDigest), 'source surcharge identity'); chargeIds.add(charge.sourceId); cents(charge.net, true); cents(charge.gross, true); requireValue(a.amount === charge.net, 'source surcharge amount'); }
  const native = new Map(context.orderLines.map(line => [line.id, line.quantity]));
  requireValue(native.size === context.orderLines.length && native.size === snap.lines.length, 'same-order line closure');
  const lines = new Map<string, typeof snap.lines[number]>(); const ids = new Set<string>();
  for (const line of snap.lines) {
    requireValue(typeof line.key === 'string' && line.key && !lines.has(line.key) && uuid.test(line.orderLineId) && !ids.has(line.orderLineId) && native.has(line.orderLineId), 'line identity');
    for (const n of [line.quantity, line.placedQuantity, line.unitListPrice, line.taxRateBps, line.proratedUnitPriceWithTax, line.lineNet, line.lineGross]) cents(n);
    requireValue(typeof line.priceIncludesTax === 'boolean' && (context.mode === 'settlement' ? native.get(line.orderLineId) === line.quantity : native.get(line.orderLineId)! <= line.quantity), 'purchased quantity');
    for (const a of line.priorAdjustments ?? []) { cents(a.amount, true); if (a.units) { requireValue(a.units.length === line.quantity, 'prior unit count'); a.units.forEach(n => cents(n, true)); requireValue(a.units.reduce((n, v) => n + v, 0) === a.amount, 'prior sum'); } }
    lines.set(line.key, line); ids.add(line.orderLineId);
  }
  const promotionIds = new Set<string>(); let shippingDiscount = 0;
  for (const entry of snap.applied) {
    requireValue(typeof entry.promotionId === 'string' && !promotionIds.has(entry.promotionId) && ['percentage', 'fixed', 'free_shipping', 'account_credit'].includes(entry.kind) && ['net', 'gross'].includes(entry.basis) && ['order', 'line'].includes(entry.scope), 'applied promotion');
    cents(entry.amount, true); cents(entry.amountWithTax, true); cents(entry.priority, true); cents(entry.sequence);
    if (entry.requestedAmount !== undefined) { cents(entry.requestedAmount, true); requireValue(entry.requestedAmount <= 0 || (snap.retainedShipping && entry.shippingAdjustment), 'signed requested discount'); }
    requireValue(((snap.retainedShipping && entry.shippingAdjustment) || (entry.amount <= 0 && entry.amountWithTax <= 0)) && Array.isArray(entry.lineAllocations), 'signed discounts');
    const seen = new Set<string>(); let amount = 0;
    for (const a of entry.lineAllocations) { const line = lines.get(a.lineKey);
      requireValue(line && a.orderLineId === line.orderLineId && !seen.has(a.lineKey) && Array.isArray(a.units) && a.units.length === line.quantity, 'allocation line');
      cents(a.amount, true); a.units.forEach(n => { cents(n, true); requireValue(n <= 0, 'signed unit'); });
      requireValue(a.amount <= 0, 'signed allocation');
      for (const value of [a.sourceAdjustmentAmount, a.sourceDiscountAmount, a.sourceDiscountAmountWithTax]) {
        if (value !== undefined) { cents(value, true); requireValue(value <= 0, 'signed source discount'); }
      }
      if (a.sourceUnits !== undefined) {
        requireValue(Array.isArray(a.sourceUnits) && a.sourceUnits.length === line.quantity, 'source unit count');
        a.sourceUnits.forEach(n => { cents(n, true); requireValue(n <= 0, 'signed source unit'); });
      }
      requireValue(a.units.reduce((n, v) => n + v, 0) === a.amount, 'allocation sum'); amount += a.amount; seen.add(a.lineKey);
    }
    requireValue((snap.retainedShipping && entry.shippingAdjustment) || amount >= entry.amount, 'promotion allocation sum');
    shippingDiscount += entry.amount - amount; promotionIds.add(entry.promotionId);
  }
  requireValue(shippingDiscount === snap.totals.shippingTotal - snap.shippingBasis.amount, 'shipping discount sum');
  if (snap.selectedCredit) {
    const credit = snap.selectedCredit; cents(credit.appliedAmount); requireValue(uuid.test(credit.accountId) && uuid.test(credit.promotionId) && credit.allocation && typeof credit.allocation === 'object', 'credit identity');
    const applied = snap.applied.find(entry => entry.promotionId === credit.promotionId && entry.kind === 'account_credit');
    requireValue(applied && credit.appliedAmount > 0, 'credit applied sum');
    const sourceDiscounts = applied.lineAllocations.map(a => snap.pricesIncludeTax ? a.sourceDiscountAmountWithTax : a.sourceDiscountAmount);
    requireValue(sourceDiscounts.every(n => n !== undefined) && -sourceDiscounts.reduce<number>((n, v) => n + v!, 0) === credit.appliedAmount, 'credit source debit'); let sum = 0;
    requireValue(Object.keys(credit.allocation).length === snap.lines.length, 'credit line closure');
    for (const [id, units] of Object.entries(credit.allocation)) { const line = snap.lines.find(l => l.orderLineId === id); requireValue(line && Array.isArray(units) && units.length === Math.max(line.quantity, line.placedQuantity), 'credit line'); units.forEach(n => cents(n)); sum += units.reduce((n, v) => n + v, 0);
      const original = applied.lineAllocations.find(a => a.orderLineId === id);
      requireValue(original?.sourceAdjustmentAmount ? Array.isArray(original.sourceUnits) && original.sourceUnits.length === units.length && original.sourceUnits.every((n, i) => -n === units[i]) : units.every(n => n === 0), 'credit vector provenance'); }
    requireValue(sum === credit.appliedAmount, 'credit total');
  } else requireValue(!snap.applied.some(entry => entry.kind === 'account_credit' && entry.amount < 0), 'missing selected credit');
  if (snap.retainedShipping || snap.adjustments.some(a=>a.sourceSurcharge)) {
    const factor = 1 + snap.shippingBasis.taxRateBps / 10000;
    const shippingNet = snap.retainedShippingFinal ? snap.retainedShippingFinal.reduce((n,l)=>n+l.net,0) : snap.shippingBasis.includesTax ? Math.round(snap.totals.shippingTotal/factor) : snap.totals.shippingTotal;
    const shippingGross = snap.retainedShippingFinal ? snap.retainedShippingFinal.reduce((n,l)=>n+l.gross,0) : snap.shippingBasis.includesTax ? snap.totals.shippingTotal : Math.round(snap.totals.shippingTotal*factor);
    const taxable = snap.adjustments.filter(a=>a.taxable && !a.sourceSurcharge).reduce((n,a)=>n+a.amount,0), rate = snap.lines[0]?.taxRateBps ?? 0;
    const scalarTax = snap.pricesIncludeTax ? taxable-Math.round(taxable/(1+rate/10000)) : Math.round(taxable*rate/10000);
    const exactTax = snap.adjustments.reduce((n,a)=>n+(a.sourceSurcharge ? a.sourceSurcharge.gross-a.sourceSurcharge.net : 0),0);
    const lineNet = snap.lines.reduce((n,l)=>n+l.lineNet,0), lineGross = snap.lines.reduce((n,l)=>n+l.lineGross,0);
    requireValue(snap.totals.taxTotal === lineGross-lineNet+shippingGross-shippingNet+scalarTax+exactTax &&
      snap.totals.grandTotal === lineGross+shippingGross+snap.adjustments.reduce((n,a)=>n+a.amount,0)+exactTax+(snap.pricesIncludeTax ? 0 : scalarTax), 'exact source component arithmetic');
  }
  if (context.totals) requireValue(JSON.stringify(economicTotals(context.totals)) === JSON.stringify(economicTotals(snap.totals)), 'stored order totals');
  const input: StackInput = { lines: snap.lines.map(({ orderLineId: _id, proratedUnitPriceWithTax: _unit, lineNet: _net, lineGross: _gross, ...line }) => line),
    promotions: snap.applied.map(entry => ({ id: entry.promotionId, kind: entry.kind, priority: entry.priority, sequence: entry.sequence, code: null, scope: entry.scope, value: 0, freeShipping: false, conditions: null })),
    couponCodes: snap.couponCodes, phase: 'PaymentSettled', currency: snap.currency, pricesIncludeTax: snap.pricesIncludeTax,
    shipping: snap.shippingBasis.amount, shippingTaxRateBps: snap.shippingBasis.taxRateBps, shippingIncludesTax: snap.shippingBasis.includesTax,
    ...(snap.retainedShipping ? { retainedShipping: snap.retainedShipping } : {}),
    couponContext: { activeVerifications: [] }, pointsDiscount: snap.pointsDiscount, adjustments: snap.adjustments };
  const result = { ...snap.totals, ...(snap.retainedShippingFinal ? { retainedShippingFinal: snap.retainedShippingFinal } : {}), lines: [], pricingProfile: snap.pricingProfile, coupons: [], applied: snap.applied.map(({ priority: _p, sequence: _s, scope: _scope, lineAllocations, ...entry }) => ({ ...entry, lineAllocations: lineAllocations.map(({ orderLineId: _id, ...a }) => a) })),
    lineSnapshots: snap.lines.map(line => ({ lineKey: line.key, quantity: line.quantity, proratedUnitPriceWithTax: line.proratedUnitPriceWithTax, lineNet: line.lineNet, lineGross: line.lineGross })),
    selectedCredit: snap.selectedCredit ? { ...snap.selectedCredit, allocation: Object.fromEntries(snap.lines.filter(line => snap.selectedCredit!.allocation[line.orderLineId]).map(line => [line.key, snap.selectedCredit!.allocation[line.orderLineId]!])) } : null };
  requireValue(typeof snap.quoteHash === 'string' && snap.quoteHash === promotionQuoteHash(input, result), 'economic hash');
  return structuredClone(snap);
}
