/** Current edited prices are independent from immutable placement/redemption proof. */
import { createHash } from 'node:crypto';
import { readCreditFundingState, type CreditFundingState, type EditFundingHistoryRow,
  type EditFundingRedemption, type EditFundingTargetLine } from '../account-credit/edit-funding.js';
import { readOrderPricingSnapshot, type MoneyTotals, type OrderPricingSnapshotV1 } from './pricing-snapshot.js';

export interface CreditPricingEvidence {
  redemption: EditFundingRedemption;
  /** Every POSTED RESTORE, including rows written after pricing activation. */
  history: readonly EditFundingHistoryRow[]; historyComplete: true;
}
export type OriginalUnitIndexes = Record<string, Array<number | null>>;
export type OrdinaryUnitFacts = Record<string, { sourceAdjustmentTotal: number; sourceAdjustmentDivisor: number }>;
export type CurrentPricingLine = OrderPricingSnapshotV1['lines'][number] & { cashRefundGrossUnits: number[] };
export interface OrderPricingSnapshotV2 {
  version: 2; pricingProfile: 'retained-credit-edit-v1'; currency: string; pricesIncludeTax: boolean;
  couponCodes: string[]; quoteHash: string;
  /** Strict V1 placement proof, never a rewritten REDEEM projection. */
  origin: OrderPricingSnapshotV1;
  ordinary: OrderPricingSnapshotV1;
  ordinaryUnitFacts: OrdinaryUnitFacts;
  credit: { redemptionId: string; orderId: string; accountId: string; promotionId: string;
    basis: 'net' | 'gross'; originDigest: string; atPricingRestoreIds: string[]; atPricingRestoreDigest: string;
    allocation: Record<string, number[]> };
  originalUnitIndexes: OriginalUnitIndexes;
  lines: CurrentPricingLine[]; totals: MoneyTotals;
}
export interface CurrentOrderPricing {
  snapshot: OrderPricingSnapshotV1 | OrderPricingSnapshotV2;
  currency: string; pricesIncludeTax: boolean; couponCodes: string[]; quoteHash: string;
  lines: CurrentPricingLine[]; totals: MoneyTotals;
  selectedCredit: OrderPricingSnapshotV1['selectedCredit'];
  originalUnitIndexes: OriginalUnitIndexes;
  /** Current-position remaining credit; later returns may reduce it below saved pricing. */
  liveAllocation: Record<string, number[]>;
  fundingState: CreditFundingState | null;
}
export interface CurrentPricingContext {
  currency: string; orderLines: Array<{ id: string; quantity: number }>;
  mode: 'settlement' | 'refund'; totals?: MoneyTotals; creditEvidence?: CreditPricingEvidence;
}
export interface BuildCurrentCreditPricingInput {
  origin: OrderPricingSnapshotV1; ordinary: OrderPricingSnapshotV1;
  couponCodes: string[]; evidence: CreditPricingEvidence; originalUnitIndexes: OriginalUnitIndexes;
  ordinaryUnitFacts: OrdinaryUnitFacts;
}
const MAX = 2_147_483_647;
function requireFact(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`Invalid current credit pricing: ${message}`); }
function cents(n: number, signed = false): number {
  requireFact(Number.isSafeInteger(n) && n >= (signed ? -MAX : 0) && n <= MAX, 'integer cents'); return n || 0;
}
const sum = (units: readonly number[]) => cents(units.reduce((n, v) => n + v, 0), true);
const round = (n: number) => cents(Math.round(n));
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
const serial = (v: unknown) => JSON.stringify(stable(v));
const digest = (v: unknown) => createHash('sha256').update(serial(v)).digest('hex');
const native = (s: OrderPricingSnapshotV1) => s.lines.map(l => ({ id: l.orderLineId, quantity: l.quantity }));
function strict(s: OrderPricingSnapshotV1): OrderPricingSnapshotV1 {
  return readOrderPricingSnapshot(s, { currency: s.currency, orderLines: native(s), mode: 'settlement' })!;
}
function funding(e: CreditPricingEvidence): CreditFundingState {
  const result = readCreditFundingState(e); requireFact(result.ok, result.ok ? '' : result.message); return result.state;
}
function historyDigest(history: readonly EditFundingHistoryRow[]): string {
  return digest([...history].sort((a, b) => a.id.localeCompare(b.id)).map(row => ({
    id: row.id, idempotencyKey: row.idempotencyKey, orderId: row.orderId, accountCreditId: row.accountCreditId,
    relatedTransactionId: row.relatedTransactionId, orderLineId: row.orderLineId, kind: row.kind, status: row.status,
    quantity: row.quantity, amount: row.amount, delta: row.delta, allocation: row.allocation, operationalAllocation: row.operationalAllocation,
  })));
}

/** Exact producer facts preserve captured rounding; rounded totals cannot recover these. */
function ordinaryUnits(s: OrderPricingSnapshotV1, producer: OrdinaryUnitFacts): Map<string, { net: number; gross: number }> {
  requireFact(producer && typeof producer === 'object' && !Array.isArray(producer) && Object.keys(producer).length === s.lines.length, 'ordinary producer line closure');
  const facts = (l: OrderPricingSnapshotV1['lines'][number]) => {
    const p = producer[l.orderLineId]; requireFact(p && cents(p.sourceAdjustmentTotal, true) <= 0 &&
      cents(p.sourceAdjustmentDivisor) === Math.max(l.quantity, l.placedQuantity), 'ordinary producer divisor/adjustment');
    const list = l.unitListPrice + (l.quantity ? p.sourceAdjustmentTotal / p.sourceAdjustmentDivisor : 0);
    requireFact(list >= 0, 'ordinary unit below zero'); const factor = 1 + l.taxRateBps / 10000;
    return { net: l.priceIncludesTax ? list / factor : list, gross: l.priceIncludesTax ? list : list * factor };
  };
  return new Map(s.lines.map(l => { const f = facts(l);
    requireFact(round(f.net * l.quantity) === l.lineNet && round(f.gross * l.quantity) === l.lineGross &&
      round(f.gross) === l.proratedUnitPriceWithTax, 'ordinary unrounded pricing provenance');
    return [l.orderLineId, f];
  }));
}

/** Run before RESTORE planning. Each unit is capped independently in original debit basis. */
export function currentCreditFundingTargets(ordinary: OrderPricingSnapshotV1, indexes: OriginalUnitIndexes, basis: 'net' | 'gross', producer: OrdinaryUnitFacts): EditFundingTargetLine[] {
  const s = strict(ordinary); requireFact(!s.selectedCredit && !s.applied.some(a => a.kind === 'account_credit'), 'ordinary pricing contains credit');
  requireFact(basis === 'net' || basis === 'gross', 'credit basis'); const units = ordinaryUnits(s, producer);
  requireFact(indexes && Object.keys(indexes).length === s.lines.length, 'identity line closure');
  return s.lines.map(l => { requireFact(Array.isArray(indexes[l.orderLineId]) && indexes[l.orderLineId]!.length === l.quantity, 'identity quantity');
    return { orderLineId: l.orderLineId, units: indexes[l.orderLineId]!.map(originalIndex => ({ originalIndex,
      maximumCredit: cents(Math.floor(units.get(l.orderLineId)![basis])) })) };
  });
}

function allocationFor(s: OrderPricingSnapshotV1, indexes: OriginalUnitIndexes, state: CreditFundingState, activation: boolean): Record<string, number[]> {
  requireFact(indexes && typeof indexes === 'object' && !Array.isArray(indexes) && Object.keys(indexes).length === s.lines.length, 'identity line closure');
  const seen = new Map<string, Set<number>>();
  const allocation = Object.fromEntries(s.lines.map(l => {
    const mapped = indexes[l.orderLineId]; requireFact(Array.isArray(mapped) && mapped.length === l.quantity, 'identity quantity');
    const used = new Set<number>(); seen.set(l.orderLineId, used);
    return [l.orderLineId, mapped.map(index => {
      if (index === null) return 0;
      requireFact(Number.isSafeInteger(index) && index >= 0 && Object.hasOwn(state.remaining, l.orderLineId) &&
        index < state.remaining[l.orderLineId]!.length && !used.has(index), 'invalid, duplicate or transferred original index');
      used.add(index);
      requireFact(!activation || !state.returnedIndexes[l.orderLineId]!.includes(index), 'returned original index reattached');
      return state.remaining[l.orderLineId]![index]!;
    })];
  }));
  for (const [id, units] of Object.entries(state.remaining)) units.forEach((_n, index) => {
    requireFact(state.returnedIndexes[id]!.includes(index) || seen.get(id)?.has(index), 'unmapped surviving original index');
  });
  requireFact(sum(Object.values(allocation).flat()) === state.retained, 'current funding conservation');
  return allocation;
}

function finalFacts(ordinary: OrderPricingSnapshotV1, allocation: Record<string, number[]>, basis: 'net' | 'gross', producer: OrdinaryUnitFacts) {
  const units = ordinaryUnits(ordinary, producer);
  const lines = ordinary.lines.map(l => {
    const f = units.get(l.orderLineId)!, factor = 1 + l.taxRateBps / 10000, funded = allocation[l.orderLineId]!;
    funded.forEach(n => requireFact(cents(n) <= Math.floor(f[basis]), 'unit funding exceeds ordinary price'));
    const finalBasis = f[basis] * l.quantity - sum(funded);
    const lineNet = round(basis === 'net' ? finalBasis : finalBasis / factor);
    const lineGross = round(basis === 'gross' ? finalBasis : finalBasis * factor);
    const cashRefundGrossUnits = funded.map(n => round(basis === 'gross' ? f.gross - n : (f.net - n) * factor));
    return { ...structuredClone(l), lineNet, lineGross,
      proratedUnitPriceWithTax: l.quantity ? round((basis === 'gross' ? finalBasis : finalBasis * factor) / l.quantity) : 0,
      cashRefundGrossUnits };
  });
  const netDiscount = sum(ordinary.lines.map((l, i) => l.lineNet - lines[i]!.lineNet));
  const grossDiscount = sum(ordinary.lines.map((l, i) => l.lineGross - lines[i]!.lineGross));
  const totals: MoneyTotals = { ...ordinary.totals,
    discountTotal: cents(ordinary.totals.discountTotal + (ordinary.pricesIncludeTax ? grossDiscount : netDiscount)),
    taxTotal: cents(ordinary.totals.taxTotal - (grossDiscount - netDiscount), true),
    grandTotal: cents(Math.max(0, ordinary.totals.grandTotal - grossDiscount)) };
  return { lines, totals };
}
export function currentCreditPricingHash(snapshot: Omit<OrderPricingSnapshotV2, 'quoteHash'> | OrderPricingSnapshotV2): string {
  const { quoteHash: _hash, ...facts } = snapshot as OrderPricingSnapshotV2; return digest(facts);
}
export function buildCurrentCreditPricingSnapshot(input: BuildCurrentCreditPricingInput): OrderPricingSnapshotV2 {
  const origin = strict(input.origin), ordinary = strict(input.ordinary), e = input.evidence, state = funding(e);
  requireFact(origin.selectedCredit && !ordinary.selectedCredit && !ordinary.applied.some(a => a.kind === 'account_credit'), 'placement credit & ordinary pricing required');
  requireFact(origin.currency === ordinary.currency &&
    origin.selectedCredit.accountId === e.redemption.accountCreditId && origin.selectedCredit.appliedAmount === e.redemption.amount &&
    serial(origin.selectedCredit.allocation) === serial(e.redemption.operationalAllocation), 'immutable origin redemption differs');
  requireFact(Array.isArray(input.couponCodes) && input.couponCodes.every(c => typeof c === 'string' && c.length > 0 && c.length <= 255) &&
    new Set(input.couponCodes.map(c => c.toLowerCase())).size === input.couponCodes.length, 'coupon membership');
  requireFact(ordinary.couponCodes.every(code => input.couponCodes.some(c => c.toLowerCase() === code.toLowerCase())), 'ordinary coupon membership');
  const allocation = allocationFor(ordinary, input.originalUnitIndexes, state, true), basis = origin.pricesIncludeTax ? 'gross' : 'net';
  const result: OrderPricingSnapshotV2 = { version: 2, pricingProfile: 'retained-credit-edit-v1', currency: ordinary.currency,
    pricesIncludeTax: ordinary.pricesIncludeTax, couponCodes: [...input.couponCodes], quoteHash: '', origin, ordinary,
    ordinaryUnitFacts: structuredClone(input.ordinaryUnitFacts),
    credit: { redemptionId: e.redemption.id, orderId: e.redemption.orderId!, accountId: e.redemption.accountCreditId,
      promotionId: origin.selectedCredit.promotionId, basis, originDigest: digest(e.redemption.operationalAllocation),
      atPricingRestoreIds: e.history.map(h => h.id).sort(), atPricingRestoreDigest: historyDigest(e.history), allocation },
    originalUnitIndexes: structuredClone(input.originalUnitIndexes), ...finalFacts(ordinary, allocation, basis, input.ordinaryUnitFacts) };
  result.quoteHash = currentCreditPricingHash(result); return result;
}

/** V1 placement rules remain strict. V2 additionally requires complete immutable ledger proof. */
export function readCurrentOrderPricingSnapshot(raw: unknown, context: CurrentPricingContext): CurrentOrderPricing | null {
  if (raw == null) return null;
  const v = raw as OrderPricingSnapshotV2;
  if (v.version !== 2) {
    const s = readOrderPricingSnapshot(raw, context)!;
    const indexes = Object.fromEntries(s.lines.map(l => [l.orderLineId, Array.from({ length: l.quantity }, (_, i) => s.selectedCredit ? i : null)]));
    let state: CreditFundingState | null = null, liveAllocation = s.selectedCredit?.allocation ?? Object.fromEntries(s.lines.map(l => [l.orderLineId, Array(l.quantity).fill(0)]));
    if (s.selectedCredit && context.creditEvidence) {
      const e = context.creditEvidence; state = funding(e);
      requireFact(e.redemption.accountCreditId === s.selectedCredit.accountId && e.redemption.amount === s.selectedCredit.appliedAmount &&
        serial(e.redemption.operationalAllocation) === serial(s.selectedCredit.allocation), 'immutable V1 redemption differs');
      liveAllocation = allocationFor(s, indexes, state, false);
    }
    return { snapshot: s, currency: s.currency, pricesIncludeTax: s.pricesIncludeTax, couponCodes: s.couponCodes, quoteHash: s.quoteHash,
      lines: s.lines.map(l => ({ ...l, cashRefundGrossUnits: Array(l.quantity).fill(l.proratedUnitPriceWithTax) })), totals: s.totals,
      selectedCredit: s.selectedCredit, originalUnitIndexes: indexes, liveAllocation: structuredClone(liveAllocation), fundingState: state };
  }
  requireFact(v.pricingProfile === 'retained-credit-edit-v1' && v.currency === context.currency && !!context.creditEvidence &&
    v.credit && Array.isArray(v.credit.atPricingRestoreIds) && new Set(v.credit.atPricingRestoreIds).size === v.credit.atPricingRestoreIds.length, 'version/profile/credit evidence');
  const e = context.creditEvidence, byId = new Map(e.history.map(h => [h.id, h]));
  const activation = v.credit.atPricingRestoreIds.map(id => { const row = byId.get(id); requireFact(row, 'activation restoration absent from complete ledger'); return row; });
  requireFact(historyDigest(activation) === v.credit.atPricingRestoreDigest, 'activation restoration digest');
  const expected = buildCurrentCreditPricingSnapshot({ origin: v.origin, ordinary: v.ordinary, couponCodes: v.couponCodes,
    originalUnitIndexes: v.originalUnitIndexes, ordinaryUnitFacts: v.ordinaryUnitFacts, evidence: { ...e, history: activation } });
  requireFact(serial(expected) === serial(v), 'saved activation facts/hash differ');
  // Validate current native-line closure without comparing ordinary totals to final totals.
  readOrderPricingSnapshot(v.ordinary, { ...context, totals: undefined });
  if (context.totals) requireFact(serial(v.totals) === serial(context.totals), 'stored order totals');
  const state = funding(e), liveAllocation = allocationFor(v.ordinary, v.originalUnitIndexes, state, false);
  return { snapshot: structuredClone(v), currency: v.currency, pricesIncludeTax: v.pricesIncludeTax, couponCodes: [...v.couponCodes],
    quoteHash: v.quoteHash, lines: structuredClone(v.lines), totals: structuredClone(v.totals),
    selectedCredit: { accountId: v.credit.accountId, promotionId: v.credit.promotionId,
      appliedAmount: sum(Object.values(v.credit.allocation).flat()), allocation: structuredClone(v.credit.allocation) },
    originalUnitIndexes: structuredClone(v.originalUnitIndexes), liveAllocation, fundingState: state };
}
