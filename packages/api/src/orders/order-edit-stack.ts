/** Pure ordinary-promotion edit candidate. Admission never authorizes persistence or settlement. */
import { calculatePromotionStack, canonicalCouponCodes, type StackInput, type StackLine, type PromotionStackTotals } from '../money/promotion-stack.js';
import { promotionQuoteHash, readOrderPricingSnapshot, type OrderPricingSnapshotV1 } from '../money/pricing-snapshot.js';
import { createHash } from 'node:crypto';
import { vendureLineMoney, type VendureLineSnapshotInput } from '../import/vendure-money.js';

export type EditStackMoney = Pick<PromotionStackTotals, 'subtotal' | 'discountTotal' | 'shippingTotal' | 'taxTotal' | 'grandTotal' | 'pointsDiscount'>;
export interface EditStackNativeLine { key: string; id: string; quantity: number }
export type EditStackBasis =
  | { kind: 'snapshot'; snapshot: unknown }
  | { kind: 'imported-source'; lines: StackLine[]; pricesIncludeTax: boolean; sourceFingerprint: string }
  | { kind: 'current-proof'; lines: StackLine[]; pricesIncludeTax: boolean; economicHash: string }
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
function totals(value: EditStackMoney, signedHeader = false, signedDiscount = false): EditStackMoney {
  requireFact(value && typeof value === 'object', 'Missing stored totals');
  const out = { subtotal: value.subtotal, discountTotal: value.discountTotal, shippingTotal: value.shippingTotal,
    taxTotal: value.taxTotal, grandTotal: value.grandTotal, pointsDiscount: value.pointsDiscount };
  for (const [key, amount] of Object.entries(out)) money(amount, 'stored total', signedHeader || key === 'taxTotal' || signedDiscount && key === 'discountTotal');
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
  // Retained membership can outlive an ordinary promotion. Resolver admission
  // validates newly applied codes; unavailable retained codes perform no action.
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
  const storedTotals = totals(before.totals, before.basis?.kind === 'imported-source', before.basis?.kind === 'current-proof');
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
  } else if (before.basis?.kind === 'current-proof') {
    const basis = before.basis;
    requireFact(/^[0-9a-f]{64}$/.test(basis.economicHash) && typeof basis.pricesIncludeTax === 'boolean' && Array.isArray(basis.lines), 'Missing current pricing admission');
    lines = basis.lines; hash = basis.economicHash; pricesIncludeTax = basis.pricesIncludeTax;
    for (const line of lines) { const { priorAdjustments: _historic, ...clean } = line; validateLine(clean); }
  } else if (before.basis?.kind === 'imported-source') {
    const basis = before.basis;
    requireFact(/^[0-9a-f]{64}$/.test(basis.sourceFingerprint) && typeof basis.pricesIncludeTax === 'boolean' && Array.isArray(basis.lines), 'Missing imported source admission');
    // Reader establishes actual stored financial parity independently; source
    // headers can contain anomalies & must never be repaired by repricing BEFORE.
    lines = basis.lines; hash = basis.sourceFingerprint; pricesIncludeTax = basis.pricesIncludeTax;
    for (const line of lines) { const { priorAdjustments: _historic, ...clean } = line; validateLine(clean); }
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

/** Ordinary pricing runs before retained immutable funding in order-edit-service. */
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
        return { ...structuredClone(original), priorAdjustments: [] };
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

function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, member]) => member !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, member]) => [key, stable(member)]));
  return value;
}

/** Includes stored anomalies/counters, not a recalculated approximation. */
export function orderEditStoredFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

/** New line identities are logical positions until preparation allocates UUIDs. */
export function orderEditAcceptanceHash(beforeFingerprint: string, afterEconomicHash: string, orderedOps: readonly unknown[]): string {
  requireFact(/^[0-9a-f]{64}$/.test(beforeFingerprint) && /^[0-9a-f]{64}$/.test(afterEconomicHash), 'Invalid edit acceptance identity');
  const ops = orderedOps.map(op => object(op) && ['apply_coupon', 'remove_coupon'].includes(String(op.op)) && typeof op.code === 'string'
    ? { ...op, code: op.code.toLowerCase() } : op);
  return orderEditStoredFingerprint({ version: 1, beforeFingerprint, afterEconomicHash, ops });
}

/** DB columns use net list/final amounts & gross total, independently of channel basis. */
export function projectEditStackLines(input: StackInput, result: PromotionStackTotals) {
  validateResult(input, result);
  return input.lines.map(line => {
    const facts = result.lineSnapshots.find(row => row.lineKey === line.key)!;
    const netListUnit = line.priceIncludesTax ? line.unitListPrice / (1 + line.taxRateBps / 10000) : line.unitListPrice;
    const lineSubtotal = Math.round(netListUnit * line.quantity);
    return { key: line.key, unitPrice: Math.round(netListUnit), quantity: line.quantity,
      lineSubtotal, lineDiscount: lineSubtotal - facts.lineNet, lineTax: facts.lineGross - facts.lineNet, lineTotal: facts.lineGross };
  });
}

type ImportedNativeLine = { id: string; orderId: string; storeId: string; quantity: number; unitPrice: number;
  lineSubtotal: number; lineDiscount: number; lineTax: number; lineTotal: number; metadata: unknown };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function rawObject(text: unknown, label: string) {
  requireFact(typeof text === 'string' && text.length > 0, `Missing retained ${label}`);
  const value: unknown = JSON.parse(text); requireFact(object(value), `Invalid retained ${label}`); return value;
}
function sourceId(value: unknown): string {
  requireFact((typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0), 'Invalid retained source identity');
  return String(value);
}
function rawInteger(value: unknown, label: string, signed = false): number {
  requireFact(typeof value === 'number' || (typeof value === 'string' && /^-?[0-9]+$/.test(value)), `Invalid retained ${label}`);
  const n = Number(value); money(n, label, signed); return n;
}
/** Validates raw getter parity without inventing historical promotion facts. */
export function readImportedOrderEditBasis(metadata: unknown, context: { storeId: string; orderId: string; currency: string;
  orderLines: readonly ImportedNativeLine[]; couponCodes?: readonly string[] }): Extract<EditStackBasis, { kind: 'imported-source' }> {
  requireFact(object(metadata) && object(metadata.vendure), 'Missing imported source identity');
  const source = metadata.vendure; const raw = source.editBasisV1;
  requireFact(object(raw) && raw.version === 1 && raw.format === 'retained-pg-jsonb-text-v1' && typeof source.sourceKey === 'string' && raw.sourceKey === source.sourceKey &&
    sourceId(raw.sourceOrderId) === sourceId(source.id) && typeof raw.sourceDigest === 'string', 'Missing retained imported edit basis');
  const { sourceDigest, ...payload } = raw;
  requireFact(sourceDigest === orderEditStoredFingerprint(payload), 'Retained source digest differs');
  const order = rawObject(raw.sourceOrderRecord, 'order');
  requireFact(sourceId(order.id) === raw.sourceOrderId && (order.currencyCode === undefined || order.currencyCode === context.currency) && typeof order.pricesIncludeTax === 'boolean', 'Retained order identity/tax basis differs');
  requireFact(object(raw.header), 'Missing source header');
  for (const key of ['subTotal', 'subTotalWithTax', 'shipping', 'shippingWithTax']) {
    const value = raw.header[key]; requireFact(value === null || (typeof value === 'string' && /^-?[0-9]+$/.test(value) && Number.isSafeInteger(Number(value))), 'Invalid source header lexeme');
    requireFact(value === null ? order[key] == null : Number(value) === Number(order[key]), 'Retained header differs from source record');
  }
  if (context.couponCodes !== undefined) {
    requireFact(Array.isArray(order.couponCodes) && order.couponCodes.every(code => typeof code === 'string'), 'Missing complete source coupon array');
    requireFact(JSON.stringify(canonicalCouponCodes(order.couponCodes as string[])) === JSON.stringify(canonicalCouponCodes(context.couponCodes)), 'Retained coupon membership differs');
  }
  requireFact(Array.isArray(raw.lines) && raw.lines.length === context.orderLines.length && Array.isArray(raw.shippingLines) && Array.isArray(raw.surcharges), 'Imported source child closure differs');
  const shippingIds = new Set<string>();
  for (const entry of [...raw.shippingLines, ...raw.surcharges]) {
    requireFact(object(entry), 'Invalid source child'); const record = rawObject(entry.sourceRecord, 'child');
    requireFact(sourceId(entry.sourceId) === sourceId(record.id) && sourceId(record.orderId) === raw.sourceOrderId, 'Source child ownership differs');
    if (raw.shippingLines.includes(entry)) { requireFact(!shippingIds.has(sourceId(entry.sourceId)), 'Duplicate source shipping line'); shippingIds.add(sourceId(entry.sourceId)); }
  }
  const ids = new Set<string>(); const sourceIds = new Set<string>();
  const lines = raw.lines.map((entry): StackLine => {
    requireFact(object(entry) && typeof entry.orderLineId === 'string' && !ids.has(entry.orderLineId), 'Invalid retained native line mapping'); ids.add(entry.orderLineId);
    const line = context.orderLines.find(line => line.id === entry.orderLineId);
    const record = rawObject(entry.sourceRecord, 'line'); const id = sourceId(entry.sourceId);
    requireFact(!sourceIds.has(id) && id === sourceId(record.id) && sourceId(record.orderId) === raw.sourceOrderId && line && line.orderId === context.orderId && line.storeId === context.storeId, 'Source line ownership differs'); sourceIds.add(id);
    requireFact(object(line.metadata) && object(line.metadata.vendure) && sourceId(line.metadata.vendure.id) === id, 'Native/source line identity differs');
    if (record.shippingLineId != null) requireFact(shippingIds.has(sourceId(record.shippingLineId)), 'Source line shipping relation differs');
    const quantity = rawInteger(record.quantity, 'quantity'); const placedQuantity = record.orderPlacedQuantity == null ? quantity : rawInteger(record.orderPlacedQuantity, 'placed quantity');
    const listPrice = rawInteger(record.listPrice, 'list price');
    requireFact(typeof record.listPriceIncludesTax === 'boolean' && Array.isArray(record.adjustments) && Array.isArray(record.taxLines), 'Missing retained raw line price facts');
    const adjustments = record.adjustments.map(adjustment => { requireFact(object(adjustment), 'Invalid retained adjustment'); return { amount: rawInteger(adjustment.amount, 'adjustment', true), type: adjustment.type }; });
    const taxLines = record.taxLines.map(tax => { requireFact(object(tax) && (typeof tax.taxRate === 'number' || typeof tax.taxRate === 'string'), 'Invalid retained tax line');
      const rate = Number(tax.taxRate); requireFact(Number.isFinite(rate) && rate >= 0, 'Invalid retained tax rate'); return { taxRate: rate }; });
    const taxRateBps = taxLines.reduce((total, tax) => total + tax.taxRate * 100, 0); money(taxRateBps, 'retained tax rate');
    const input: VendureLineSnapshotInput = { quantity, orderPlacedQuantity: placedQuantity, listPrice, listPriceIncludesTax: record.listPriceIncludesTax, adjustments, taxLines };
    const projection = vendureLineMoney(input);
    requireFact(line.quantity === quantity && Object.entries(projection).every(([key, amount]) => line[key as keyof typeof projection] === amount), 'Retained source getter/native financial parity differs');
    return { key: line.id, quantity, placedQuantity: Math.max(quantity, placedQuantity), unitListPrice: listPrice,
      priceIncludesTax: record.listPriceIncludesTax, taxRateBps, priorAdjustments: [] };
  });
  return { kind: 'imported-source', lines, pricesIncludeTax: order.pricesIncludeTax, sourceFingerprint: orderEditStoredFingerprint({ metadata, lines: context.orderLines }) };
}
