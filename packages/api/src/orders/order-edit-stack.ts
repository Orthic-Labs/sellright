/** Pure ordinary-promotion edit candidate. Admission never authorizes persistence or settlement. */
import { calculatePromotionStack, canonicalCouponCodes, type StackInput, type StackLine, type PromotionStackTotals } from '../money/promotion-stack.js';
import { promotionQuoteHash, readOrderPricingSnapshot, type OrderPricingSnapshotV1 } from '../money/pricing-snapshot.js';

export type EditStackMoney = Pick<PromotionStackTotals, 'subtotal' | 'discountTotal' | 'shippingTotal' | 'taxTotal' | 'grandTotal' | 'pointsDiscount'>;
export interface EditStackNativeLine { key: string; id: string; quantity: number }
export type EditStackBasis =
  | { kind: 'snapshot'; snapshot: unknown }
  | { kind: 'legacy' | 'imported'; input: StackInput; result: PromotionStackTotals };
export type EditStackLineBasis = Omit<StackLine, 'key' | 'quantity'>;
export type EditStackWorkingLine =
  | { key: string; quantity: number; change: 'untouched' }
  | { key: string; quantity: number; change: 'touched' | 'new'; basis: EditStackLineBasis };
export type EditStackCouponItem = NonNullable<StackInput['couponContext']['items']>[number] & { lineKey: string };
export type EditStackCouponContext = Omit<StackInput['couponContext'], 'items'> & { items?: EditStackCouponItem[] };
export interface OrderEditStackInput {
  before: { basis: EditStackBasis; currency: string; orderLines: EditStackNativeLine[]; totals: EditStackMoney; economicHash: string };
  /** Caller must load ledger evidence explicitly; absence is not proof of no credit. */
  creditLedgerEvidence: readonly unknown[];
  lines: EditStackWorkingLine[];
  pricing: Omit<StackInput, 'lines' | 'phase' | 'currency' | 'couponContext'> & { couponContext: EditStackCouponContext };
}
export interface OrderEditStackCandidate {
  input: StackInput;
  result: PromotionStackTotals;
  perLine: ReadonlyMap<string, PromotionStackTotals['lines'][number]>;
  couponCodes: string[];
  beforeEconomicHash: string;
  afterEconomicHash: string;
  balance: number;
  /** Commit owner supplies persisted UUID mapping to buildOrderPricingSnapshot. */
  snapshotDraft: { input: StackInput; result: PromotionStackTotals };
}
export class OrderEditStackError extends Error {
  constructor(readonly code: 'ORDER_EDIT_STACK_CREDIT_UNSUPPORTED' | 'ORDER_EDIT_STACK_BASIS_INVALID', message: string) {
    super(message); this.name = 'OrderEditStackError';
  }
}
const MAX = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireFact(ok: unknown, message: string): asserts ok {
  if (!ok) throw new OrderEditStackError('ORDER_EDIT_STACK_BASIS_INVALID', message);
}
function money(value: unknown, label: string, signed = false): asserts value is number {
  requireFact(typeof value === 'number' && Number.isSafeInteger(value) && value >= (signed ? -MAX : 0) && value <= MAX, `Invalid ${label}`);
}
function creditFree(ok: unknown) {
  if (!ok) throw new OrderEditStackError('ORDER_EDIT_STACK_CREDIT_UNSUPPORTED', 'Account-credit edits require funding-aware integration');
}
function totals(value: EditStackMoney): EditStackMoney {
  requireFact(value && typeof value === 'object', 'Missing stored totals');
  const out = { subtotal: value.subtotal, discountTotal: value.discountTotal, shippingTotal: value.shippingTotal,
    taxTotal: value.taxTotal, grandTotal: value.grandTotal, pointsDiscount: value.pointsDiscount };
  for (const amount of Object.values(out)) money(amount, 'stored total');
  return out;
}
function canonicalCodes(codes: string[]) {
  requireFact(Array.isArray(codes), 'Missing complete coupon array');
  requireFact(canonicalCouponCodes(codes).length === codes.length, 'Coupon array must already be canonical');
}
function validateConditionArgs(condition: { code: string; args?: Array<{ name: string; value: string }> }) {
  const args = new Map((condition.args ?? []).map(arg => [arg.name, arg.value]));
  requireFact(args.size === (condition.args ?? []).length, 'Ambiguous condition arguments');
  if (condition.code === 'minimum_order_amount') {
    money(Number(args.get('amount') ?? 0), 'minimum order condition');
    requireFact(!args.has('taxInclusive') || ['true', 'false'].includes(args.get('taxInclusive')!), 'Invalid condition tax basis');
    return;
  }
  const arrayArgs: Record<string, string> = { verified_customer: 'categories', at_least_n_in_collections: 'collectionIds', at_least_n_products: 'productIds', at_least_n_with_tags: 'tags' };
  const arrayArg = arrayArgs[condition.code];
  requireFact(arrayArg, 'Unsupported promotion condition');
  const values: unknown = JSON.parse(args.get(arrayArg) ?? '[]');
  requireFact(Array.isArray(values) && values.every(value => typeof value === 'string'), 'Invalid condition member facts');
  if (condition.code !== 'verified_customer') {
    const minimum = Number(args.get('minimum') ?? 1); money(minimum, 'item minimum');
    requireFact(minimum > 0, 'Invalid item minimum');
  }
}
function validateLine(line: StackLine) {
  requireFact(line && typeof line.key === 'string' && line.key.length > 0, 'Missing logical line key');
  for (const amount of [line.quantity, line.placedQuantity, line.unitListPrice, line.taxRateBps]) money(amount, 'line basis');
  money(line.quantity * line.unitListPrice, 'line subtotal');
  requireFact(typeof line.priceIncludesTax === 'boolean', 'Missing authoritative line tax basis');
  requireFact(line.priorAdjustments === undefined || Array.isArray(line.priorAdjustments), 'Invalid prior adjustments');
  for (const adjustment of line.priorAdjustments ?? []) {
    // Generated item & order actions must be recalculated, including removed coupons.
    requireFact(adjustment && adjustment.kind === 'item' && adjustment.promotionId === undefined, 'Generated promotion adjustment cannot be retained');
    money(adjustment.amount, 'prior adjustment', true);
    requireFact(adjustment.amount <= 0 && Array.isArray(adjustment.units) && adjustment.units.length === line.quantity, 'Incomplete prior unit provenance');
    for (const unit of adjustment.units) { money(unit, 'prior unit', true); requireFact(unit <= 0, 'Invalid prior unit sign'); }
    requireFact(adjustment.units.reduce((sum, unit) => sum + unit, 0) === adjustment.amount, 'Prior unit sum differs');
  }
}
function validatePricing(input: StackInput) {
  requireFact(input && Array.isArray(input.lines) && Array.isArray(input.promotions), 'Incomplete pricing basis');
  requireFact(typeof input.pricesIncludeTax === 'boolean' && typeof input.shippingIncludesTax === 'boolean', 'Missing channel/shipping tax basis');
  money(input.shipping, 'shipping'); money(input.shippingTaxRateBps, 'shipping tax rate');
  requireFact(input.pointsDiscount !== undefined && Array.isArray(input.adjustments), 'Missing points/adjustment basis');
  money(input.pointsDiscount, 'points discount');
  for (const adjustment of input.adjustments) {
    requireFact(adjustment && (adjustment.taxable === undefined || typeof adjustment.taxable === 'boolean') &&
      (adjustment.label === undefined || typeof adjustment.label === 'string'), 'Invalid order adjustment');
    money(adjustment.amount, 'order adjustment', true);
  }
  canonicalCodes(input.couponCodes);
  const keys = new Set<string>();
  for (const line of input.lines) { validateLine(line); requireFact(!keys.has(line.key), 'Duplicate logical line'); keys.add(line.key); }
  const context = input.couponContext;
  requireFact(context && Array.isArray(context.activeVerifications) && context.activeVerifications.every(value => typeof value === 'string'), 'Incomplete promotion context');
  if (context.items !== undefined) {
    requireFact(Array.isArray(context.items), 'Invalid promotion items');
    const itemKeys = new Set<string>();
    for (const item of context.items) {
      const key = (item as Partial<EditStackCouponItem>).lineKey;
      requireFact(item && typeof item.productId === 'string' && item.productId.length > 0 &&
        Array.isArray(item.tags) && item.tags.every(value => typeof value === 'string') &&
        Array.isArray(item.collectionIds) && item.collectionIds.every(value => typeof value === 'string'), 'Invalid promotion item facts');
      money(item.quantity, 'promotion item quantity');
      requireFact(typeof key === 'string' && !itemKeys.has(key) && input.lines.some(line => line.key === key && line.quantity === item.quantity), 'Promotion item identity/quantity differs');
      itemKeys.add(key);
    }
    requireFact(itemKeys.size === input.lines.length, 'Promotion item line closure differs');
  }
  const identities = new Set<string>(); const sequences = new Set<number>(); const codes = new Set<string>();
  for (const promotion of input.promotions) {
    requireFact(promotion && typeof promotion.id === 'string' && promotion.id.length > 0, 'Missing promotion identity');
    creditFree(promotion.kind !== 'account_credit' && promotion.credit == null);
    requireFact(!identities.has(promotion.id) && !sequences.has(promotion.sequence), 'Ambiguous promotion sequence');
    identities.add(promotion.id); sequences.add(promotion.sequence);
    money(promotion.priority, 'promotion priority', true); money(promotion.sequence, 'promotion sequence');
    requireFact(typeof promotion.freeShipping === 'boolean' && (promotion.conditions === null || Array.isArray(promotion.conditions)), 'Incomplete promotion facts');
    if (promotion.code !== null) {
      canonicalCodes([promotion.code]);
      requireFact(!codes.has(promotion.code.toLowerCase()), 'Ambiguous promotion code'); codes.add(promotion.code.toLowerCase());
    }
    for (const condition of promotion.conditions ?? []) {
      requireFact(condition && typeof condition.code === 'string', 'Invalid promotion condition');
      creditFree(condition.code !== 'account_credit_eligible' && condition.code !== 'account_credit_discount');
      requireFact(['minimum_order_amount', 'verified_customer', 'at_least_n_in_collections', 'at_least_n_products', 'at_least_n_with_tags'].includes(condition.code) &&
        (condition.args === undefined || (Array.isArray(condition.args) && condition.args.every((arg: { name?: unknown; value?: unknown }) => arg && typeof arg.name === 'string' && typeof arg.value === 'string'))), 'Unsupported or malformed promotion condition');
      validateConditionArgs(condition);
      if (['at_least_n_in_collections', 'at_least_n_products', 'at_least_n_with_tags'].includes(condition.code)) requireFact(Array.isArray(context.items), 'Missing authoritative promotion items');
    }
  }
  requireFact(input.couponCodes.every(code => codes.has(code.toLowerCase())), 'Unresolved coupon provenance');
}
function validateResult(input: StackInput, result: PromotionStackTotals) {
  requireFact(result && result.pricingProfile === 'captured-default-v1' && Array.isArray(result.applied), 'Incomplete result provenance');
  creditFree(result.selectedCredit === null && !result.applied.some(entry => entry.kind === 'account_credit'));
  creditFree(!(result.resolvedPromotions ?? []).some(promotion => promotion.kind === 'account_credit' || promotion.credit != null));
  totals(result);
  if (result.adjustmentTotal !== undefined) money(result.adjustmentTotal, 'adjustment total', true);
  requireFact(Array.isArray(result.lines) && Array.isArray(result.lineSnapshots) && result.lines.length === input.lines.length && result.lineSnapshots.length === input.lines.length, 'Result line closure differs');
  const seen = new Set<string>();
  for (const [index, line] of input.lines.entries()) {
    const stored = result.lines[index]!; const facts = result.lineSnapshots[index]!;
    requireFact(stored && facts && facts.lineKey === line.key && !seen.has(facts.lineKey) && stored.quantity === line.quantity && facts.quantity === line.quantity, 'Result line identity differs');
    seen.add(facts.lineKey);
    for (const amount of [stored.unitPrice, stored.lineSubtotal, stored.lineDiscount, stored.lineTotal, facts.lineNet, facts.lineGross, facts.proratedUnitPriceWithTax]) money(amount, 'result line money');
    requireFact(stored.unitPrice === line.unitListPrice && stored.lineSubtotal === line.unitListPrice * line.quantity &&
      stored.lineSubtotal - stored.lineDiscount === stored.lineTotal && stored.lineTotal === (line.priceIncludesTax ? facts.lineGross : facts.lineNet), 'Stored line money differs from authoritative basis');
  }
  requireFact(result.quoteHash === promotionQuoteHash(input, result), 'Economic hash differs');
}
function beforeLines(input: OrderEditStackInput): { lines: StackLine[]; hash: string; pricesIncludeTax: boolean } {
  const before = input.before;
  requireFact(before && /^[A-Z]{3}$/.test(before.currency) && /^[0-9a-f]{64}$/.test(before.economicHash), 'Missing before economic identity');
  requireFact(Array.isArray(before.orderLines), 'Missing native line closure');
  const keys = new Set<string>(); const ids = new Set<string>();
  for (const line of before.orderLines) {
    requireFact(line && typeof line.key === 'string' && line.key.length > 0 && UUID.test(line.id) && !keys.has(line.key) && !ids.has(line.id), 'Invalid native line closure');
    money(line.quantity, 'stored quantity'); keys.add(line.key); ids.add(line.id);
  }
  const storedTotals = totals(before.totals);
  let lines: StackLine[]; let hash: string; let pricesIncludeTax: boolean;
  if (before.basis?.kind === 'snapshot') {
    const raw = before.basis.snapshot as OrderPricingSnapshotV1 | null;
    requireFact(raw && typeof raw === 'object' && Array.isArray(raw.applied) && raw.selectedCredit !== undefined, 'Incomplete snapshot credit provenance');
    creditFree(raw.selectedCredit === null && !raw.applied.some(entry => entry.kind === 'account_credit'));
    const snapshot = readOrderPricingSnapshot(raw, { currency: before.currency, orderLines: before.orderLines, totals: storedTotals, mode: 'settlement' });
    requireFact(snapshot, 'Current snapshot is absent');
    requireFact(snapshot.lines.every(line => before.orderLines.some(native => native.key === line.key && native.id === line.orderLineId)), 'Snapshot logical/native closure differs');
    lines = snapshot.lines.map(({ orderLineId: _id, proratedUnitPriceWithTax: _unit, lineNet: _net, lineGross: _gross, ...line }) => line);
    canonicalCodes(snapshot.couponCodes);
    for (const line of lines) validateLine(line);
    hash = snapshot.quoteHash; pricesIncludeTax = snapshot.pricesIncludeTax;
  } else {
    requireFact(before.basis && ['legacy', 'imported'].includes(before.basis.kind), 'Explicit legacy/imported basis required');
    const basis = before.basis as Extract<EditStackBasis, { input: StackInput }>;
    requireFact(basis.input?.currency === before.currency, 'Before basis currency differs');
    validatePricing(basis.input); validateResult(basis.input, basis.result);
    const recalculated = calculatePromotionStack(basis.input);
    requireFact(recalculated.quoteHash === basis.result.quoteHash && JSON.stringify(recalculated.lines) === JSON.stringify(basis.result.lines), 'Explicit before basis does not reproduce money');
    requireFact(JSON.stringify(totals(recalculated)) === JSON.stringify(storedTotals), 'Explicit before basis differs from stored totals');
    lines = basis.input.lines; hash = recalculated.quoteHash; pricesIncludeTax = basis.input.pricesIncludeTax;
  }
  requireFact(lines.length === before.orderLines.length && lines.every(line => before.orderLines.some(native => native.key === line.key && native.quantity === line.quantity)), 'Before line closure differs');
  requireFact(hash === before.economicHash, 'Before economic hash differs');
  return { lines: structuredClone(lines), hash, pricesIncludeTax };
}

/** Admission is deliberately disconnected from order-edit-service until funding-aware integration. */
export function priceOrderEditStack(request: OrderEditStackInput): OrderEditStackCandidate {
  try {
    requireFact(request && Array.isArray(request.creditLedgerEvidence), 'Credit-ledger admission evidence is required');
    creditFree(request.creditLedgerEvidence.length === 0);
    const before = beforeLines(request);
    requireFact(Array.isArray(request.lines) && request.pricing, 'Missing working pricing facts');
    requireFact(request.pricing.pricesIncludeTax === before.pricesIncludeTax, 'Channel pricing basis cannot change within an edit');
    const existing = new Map(before.lines.map(line => [line.key, line]));
    const seen = new Set<string>();
    const lines = request.lines.map((line): StackLine => {
      requireFact(line && !seen.has(line.key), 'Duplicate working line'); seen.add(line.key);
      money(line.quantity, 'working quantity');
      const original = existing.get(line.key);
      if (line.change === 'untouched') {
        requireFact(original && line.quantity === original.quantity && !('basis' in line), 'Untouched line basis/quantity differs');
        return structuredClone(original);
      }
      requireFact(line.change === 'new' ? !original : line.change === 'touched' && original, 'Working line origin differs');
      requireFact(line.basis && typeof line.basis === 'object', 'Refreshed authoritative basis required');
      return { ...structuredClone(line.basis), key: line.key, quantity: line.quantity };
    });
    requireFact([...existing.keys()].every(key => seen.has(key)), 'Existing lines must remain explicitly, including zero quantities');
    const stackInput: StackInput = { ...structuredClone(request.pricing), lines, currency: request.before.currency, phase: 'PaymentSettled' };
    validatePricing(stackInput);
    const result = calculatePromotionStack(stackInput);
    validateResult(stackInput, result);
    return { input: stackInput, result, perLine: new Map(stackInput.lines.map((line, index) => [line.key, structuredClone(result.lines[index]!)])),
      couponCodes: [...stackInput.couponCodes], beforeEconomicHash: before.hash, afterEconomicHash: result.quoteHash,
      balance: result.grandTotal - request.before.totals.grandTotal,
      snapshotDraft: { input: structuredClone(stackInput), result: structuredClone(result) } };
  } catch (error) {
    if (error instanceof OrderEditStackError) throw error;
    throw new OrderEditStackError('ORDER_EDIT_STACK_BASIS_INVALID', error instanceof Error ? error.message : 'Invalid edit pricing provenance');
  }
}
