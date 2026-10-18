/** Current edited prices are independent from immutable placement/redemption proof. */
import { createHash } from 'node:crypto';
import { readCreditFundingState, type CreditFundingState, type EditFundingHistoryRow,
  type EditFundingRedemption, type EditFundingTargetLine, originalCreditUnitId,
  readCreditRefundEvidence, creditReturnSnapshotDigest, type CreditRefundEvidence, type CreditUnitReturns } from '../account-credit/edit-funding.js';
import { readOrderPricingSnapshot, type MoneyTotals, type OrderPricingSnapshotV1 } from './pricing-snapshot.js';
import { prorateSigned } from './promotion-stack.js';

export interface CreditPricingEvidence {
  redemption: EditFundingRedemption;
  /** Every POSTED RESTORE, including rows written after pricing activation. */
  history: readonly EditFundingHistoryRow[]; historyComplete: true;
  refunds?: readonly CreditRefundEvidence[]; refundsComplete?: true;
}
export type OriginalUnitIndexes = Record<string, Array<number | null>>;
export type UnitEconomics = { net: number; gross: number; cashRefundGross: number };
export type UnitIds = Record<string, string[]>;
export interface CreditPricingSource {
  id: string; orderId: string; before: unknown; after: unknown; settlement: unknown;
}
export interface CreditPricingLineage {
  editId: string; predecessorSnapshotDigest: string; consumedUnitIds: string[];
  predecessorUnitMapDigest?: string;
}
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
  unitIds: UnitIds; unitEconomics: Record<string, UnitEconomics[]>; lineage: CreditPricingLineage;
  lines: CurrentPricingLine[]; totals: MoneyTotals;
}
export interface CurrentOrderPricing {
  snapshot: OrderPricingSnapshotV1 | OrderPricingSnapshotV2;
  currency: string; pricesIncludeTax: boolean; couponCodes: string[]; quoteHash: string;
  lines: CurrentPricingLine[]; totals: MoneyTotals;
  selectedCredit: OrderPricingSnapshotV1['selectedCredit'];
  originalUnitIndexes: OriginalUnitIndexes;
  unitIds: UnitIds; unitEconomics: Record<string, UnitEconomics[]>; consumedPositions: Record<string, number[]>;
  /** Current-position remaining credit; later returns may reduce it below saved pricing. */
  liveAllocation: Record<string, number[]>;
  fundingState: CreditFundingState | null;
}
export interface CurrentPricingContext {
  currency: string; orderLines: Array<{ id: string; quantity: number }>;
  mode: 'settlement' | 'refund'; totals?: MoneyTotals; creditEvidence?: CreditPricingEvidence;
  pricingSources?: readonly CreditPricingSource[];
}
export interface BuildCurrentCreditPricingInput {
  origin: OrderPricingSnapshotV1; ordinary: OrderPricingSnapshotV1;
  couponCodes: string[]; evidence: CreditPricingEvidence; originalUnitIndexes: OriginalUnitIndexes;
  ordinaryUnitFacts: OrdinaryUnitFacts;
  unitIds: UnitIds; predecessor?: CurrentOrderPricing; lineage: CreditPricingLineage;
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
export const creditPricingSnapshotDigest = creditReturnSnapshotDigest;
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
    quantity: row.quantity, amount: row.amount, delta: row.delta, refundId: row.refundId ?? null,
    allocation: row.allocation, operationalAllocation: row.operationalAllocation,
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
export function currentCreditFundingTargets(ordinary: OrderPricingSnapshotV1, indexes: OriginalUnitIndexes, basis: 'net' | 'gross', producer: OrdinaryUnitFacts,
  options: { consumedPositions?: Record<string, number[]> } = {}): EditFundingTargetLine[] {
  const s = strict(ordinary); requireFact(!s.selectedCredit && !s.applied.some(a => a.kind === 'account_credit'), 'ordinary pricing contains credit');
  requireFact(basis === 'net' || basis === 'gross', 'credit basis'); const units = ordinaryUnits(s, producer);
  requireFact(indexes && Object.keys(indexes).length === s.lines.length, 'identity line closure');
  return s.lines.map(l => { requireFact(Array.isArray(indexes[l.orderLineId]) && indexes[l.orderLineId]!.length === l.quantity, 'identity quantity');
    return { orderLineId: l.orderLineId, units: indexes[l.orderLineId]!.map((originalIndex, position) => ({
      originalIndex, ...(options.consumedPositions?.[l.orderLineId]?.includes(position) ? { consumed: true as const } : {}),
      maximumCredit: cents(Math.floor(units.get(l.orderLineId)![basis])) })) };
  });
}

function allocationFor(s: OrderPricingSnapshotV1, indexes: OriginalUnitIndexes, state: CreditFundingState): Record<string, number[]> {
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
      return state.remaining[l.orderLineId]![index]!;
    })];
  }));
  for (const [id, units] of Object.entries(state.remaining)) units.forEach((_n, index) => {
    requireFact(state.returnedIndexes[id]!.includes(index) || seen.get(id)?.has(index), 'unmapped surviving original index');
  });
  requireFact(sum(Object.values(allocation).flat()) === state.retained, 'current funding conservation');
  return allocation;
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const custody = (amount: number, quantity: number): number[] => prorateSigned(Array(quantity).fill(1), amount);
function unitMap(s: CurrentOrderPricing) {
  return new Map(s.lines.flatMap(line => s.unitIds[line.orderLineId]!.map((id, position) => [id, {
    line: line.orderLineId, position, index: s.originalUnitIndexes[line.orderLineId]![position]!,
    economics: s.unitEconomics[line.orderLineId]![position]!, credit: s.selectedCredit?.allocation[line.orderLineId]?.[position] ?? 0,
  }] as const)));
}
function v1View(s: OrderPricingSnapshotV1, evidence?: CreditPricingEvidence): CurrentOrderPricing {
  const indexes = Object.fromEntries(s.lines.map(l => [l.orderLineId, Array.from({ length: l.quantity }, (_, i) => s.selectedCredit ? i : null)]));
  let state: CreditFundingState | null = null;
  if (s.selectedCredit && evidence) {
    state = funding(evidence);
    requireFact(evidence.redemption.accountCreditId === s.selectedCredit.accountId && evidence.redemption.amount === s.selectedCredit.appliedAmount &&
      serial(evidence.redemption.operationalAllocation) === serial(s.selectedCredit.allocation), 'immutable V1 redemption differs');
  }
  const unitIds = Object.fromEntries(s.lines.map(l => [l.orderLineId, Array.from({ length: l.quantity }, (_, i) =>
    s.selectedCredit && evidence ? originalCreditUnitId(evidence.redemption.id, l.orderLineId, i) : `placement:${s.quoteHash}:${l.orderLineId}:${i}`)]));
  const unitEconomics = Object.fromEntries(s.lines.map(l => { const net = custody(l.lineNet, l.quantity), gross = custody(l.lineGross, l.quantity);
    return [l.orderLineId, net.map((n, i) => ({ net: n, gross: gross[i]!, cashRefundGross: l.proratedUnitPriceWithTax }))]; }));
  return { snapshot: s, currency: s.currency, pricesIncludeTax: s.pricesIncludeTax, couponCodes: s.couponCodes, quoteHash: s.quoteHash,
    lines: s.lines.map(l => ({ ...l, cashRefundGrossUnits: Array(l.quantity).fill(l.proratedUnitPriceWithTax) })), totals: s.totals,
    selectedCredit: s.selectedCredit, originalUnitIndexes: indexes, unitIds, unitEconomics,
    consumedPositions: Object.fromEntries(s.lines.map(l => [l.orderLineId, []])),
    liveAllocation: state ? allocationFor(s, indexes, state) : structuredClone(s.selectedCredit?.allocation ?? Object.fromEntries(s.lines.map(l => [l.orderLineId, Array(l.quantity).fill(0)]))),
    fundingState: state };
}
function v2View(s: OrderPricingSnapshotV2, state: CreditFundingState): CurrentOrderPricing {
  return { snapshot: structuredClone(s), currency: s.currency, pricesIncludeTax: s.pricesIncludeTax, couponCodes: [...s.couponCodes],
    quoteHash: s.quoteHash, lines: structuredClone(s.lines), totals: structuredClone(s.totals),
    selectedCredit: { accountId: s.credit.accountId, promotionId: s.credit.promotionId,
      appliedAmount: sum(Object.values(s.credit.allocation).flat()), allocation: structuredClone(s.credit.allocation) },
    originalUnitIndexes: structuredClone(s.originalUnitIndexes), unitIds: structuredClone(s.unitIds), unitEconomics: structuredClone(s.unitEconomics),
    consumedPositions: Object.fromEntries(s.lines.map(l => [l.orderLineId, []])),
    liveAllocation: allocationFor(s.ordinary, s.originalUnitIndexes, state), fundingState: state };
}
function verifyPredecessor(p: CurrentOrderPricing, e: CreditPricingEvidence): void {
  const raw = p.snapshot;
  const expected = raw.version === 1 ? v1View(strict(raw), e) : v2View(raw, funding(e));
  if (raw.version === 2) requireFact(raw.quoteHash === currentCreditPricingHash(raw), 'predecessor economic hash');
  for (const key of ['currency', 'pricesIncludeTax', 'couponCodes', 'quoteHash', 'lines', 'totals', 'selectedCredit', 'originalUnitIndexes', 'unitIds', 'unitEconomics'] as const) {
    requireFact(serial(p[key]) === serial(expected[key]), `normalized predecessor ${key} differs from raw source`);
  }
}
/** Resolve frozen refund identities against canonically validated source snapshots. */
function consumedIds(view: CurrentOrderPricing, evidence: CreditPricingEvidence, resolve: (hash: string) => CurrentOrderPricing,
  validatePostingJoin = true): Set<string> {
  const consumed = new Set<string>(), refunded = new Set<string>(), current = unitMap(view), state = funding(evidence);
  const refunds = new Map<string, { refund: CreditRefundEvidence; frozen: CreditUnitReturns | null }>();
  for (const refund of evidence.refunds ?? []) {
    requireFact(typeof refund.id === 'string' && !refunds.has(refund.id), 'duplicate refund evidence');
    refunds.set(refund.id, { refund, frozen: null });
  }
  for (const [id, u] of current) if (u.index !== null && state.returnedIndexes[u.line]?.includes(u.index)) consumed.add(id);
  for (const refund of evidence.refunds ?? []) {
    if (refund.state === 'Failed') continue;
    const frozen = readCreditRefundEvidence(refund);
    refunds.get(refund.id)!.frozen = frozen;
    if (!frozen) {
      requireFact(view.snapshot.version === 1 || refund.lines.every(l => l.quantity === 0), 'settled merchandise refund lacks frozen unit lineage');
      continue;
    }
    requireFact(frozen.redemptionId === evidence.redemption.id, 'settled refund redemption differs');
    const source = resolve(frozen.snapshotDigest), sourceUnits = unitMap(source);
    if (frozen.version === 2) requireFact(frozen.snapshotHash === source.quoteHash, 'settled refund source quote differs');
    for (const line of frozen.lines) line.positions.forEach((position, i) => {
      const id = 'unitIds' in line ? line.unitIds[i]! : source.unitIds[line.orderLineId]?.[position];
      const u = id ? sourceUnits.get(id) : undefined;
      requireFact(u && u.line === line.orderLineId && u.position === position && u.index === line.originalIndexes[i], 'settled refund source identity differs');
      if ('unitEconomics' in line) requireFact(serial(u.economics) === serial(line.unitEconomics[i]), 'settled refund source economics differ');
      const now = current.get(id!);
      if (now) requireFact(now.line === u.line && now.index === u.index, 'settled unit transferred across native lineage');
      requireFact(!refunded.has(id!), 'unit consumed by multiple settled refunds'); refunded.add(id!);
      if (now && refund.state === 'Settled') consumed.add(id!);
    });
  }
  if (validatePostingJoin) {
    const matched = new Set<string>();
    const legacyPrefix = new Map<string, number>();
    for (const row of evidence.history) {
      const raw = row.allocation === null ? null : JSON.parse(row.allocation) as Record<string, unknown>;
      if (!raw || !['account_credit.unit_restore', 'account_credit.edit_restore'].includes(String(raw.type))) {
        legacyPrefix.set(row.orderLineId!, (legacyPrefix.get(row.orderLineId!) ?? 0) + row.quantity!);
      }
    }
    for (const row of evidence.history) {
      if (row.refundId == null) continue;
      requireFact(evidence.refundsComplete === true, 'complete refund evidence required for posted restoration');
      const proof = refunds.get(row.refundId);
      requireFact(proof && proof.refund.state === 'Settled' && proof.frozen, 'posted restoration lacks settled frozen refund');
      const line = proof.frozen.lines.find(l => l.orderLineId === row.orderLineId);
      requireFact(line, 'posted restoration refund line absent');
      const expected = line.originalIndexes.flatMap((index, p) => index === null ? [] : [{ index, before: line.creditCents[p]!, after: 0 }]);
      const key = `${row.refundId}:${row.orderLineId}`;
      requireFact(expected.length > 0 && !matched.has(key) && row.quantity === expected.length && row.amount === sum(expected.map(u => u.before)), 'posted restoration refund unit closure');
      matched.add(key);
      const raw = row.allocation === null ? null : JSON.parse(row.allocation) as Record<string, unknown>;
      if (raw?.type === 'account_credit.unit_restore') {
        requireFact(Array.isArray(raw.units) && serial([...(raw.units as Array<{ index: number }>)].sort((a, b) => a.index - b.index)) ===
          serial([...expected].sort((a, b) => a.index - b.index)), 'posted restoration differs from frozen refund selection');
      } else {
        // Legacy rows establish one immutable prefix collectively. Frozen selections
        // may bind an individual row only inside that independently proven prefix.
        requireFact(!raw || !['account_credit.edit_restore', 'account_credit.unit_restore'].includes(String(raw.type)), 'refund restoration operation differs');
        requireFact(expected.every(u => u.index < (legacyPrefix.get(row.orderLineId!) ?? 0) &&
          evidence.redemption.operationalAllocation![row.orderLineId!]![u.index] === u.before), 'legacy refund selection differs from proven prefix');
      }
    }
  }
  return consumed;
}
function positions(view: CurrentOrderPricing, ids: Set<string>): Record<string, number[]> {
  return Object.fromEntries(Object.entries(view.unitIds).map(([line, units]) => [line, units.flatMap((id, position) => ids.has(id) ? [position] : [])]));
}

function finalFacts(ordinary: OrderPricingSnapshotV1, allocation: Record<string, number[]>, basis: 'net' | 'gross', producer: OrdinaryUnitFacts,
  ids: UnitIds, consumed: Set<string>, predecessor: CurrentOrderPricing) {
  const units = ordinaryUnits(ordinary, producer);
  const previous = unitMap(predecessor), unitEconomics: Record<string, UnitEconomics[]> = {};
  const lines = ordinary.lines.map(l => {
    const f = units.get(l.orderLineId)!, factor = 1 + l.taxRateBps / 10000, funded = allocation[l.orderLineId]!;
    funded.forEach((n, i) => requireFact(consumed.has(ids[l.orderLineId]![i]!) ? n === 0 : cents(n) <= Math.floor(f[basis]), 'unit funding exceeds ordinary price'));
    const livePositions = ids[l.orderLineId]!.flatMap((id, position) => consumed.has(id) ? [] : [position]);
    const previousLine = predecessor.lines.find(p => p.orderLineId === l.orderLineId);
    const previousLive = (predecessor.unitIds[l.orderLineId] ?? []).filter(id => !consumed.has(id));
    let unchanged = previousLive.length === livePositions.length && livePositions.every(p => previousLive.includes(ids[l.orderLineId]![p]!) &&
      previous.get(ids[l.orderLineId]![p]!)?.credit === funded[p]);
    if (unchanged && predecessor.snapshot.version === 2) {
      const old = ordinaryUnits(predecessor.snapshot.ordinary, predecessor.snapshot.ordinaryUnitFacts).get(l.orderLineId);
      unchanged = !!old && old.net === f.net && old.gross === f.gross && previousLine?.taxRateBps === l.taxRateBps;
    } else if (unchanged) {
      // V1 has no exact producer sidecar. Its immutable aggregate & native input
      // prove unchanged economics; do not infer unrounded units from rounded totals.
      const fullCredit = sum(ids[l.orderLineId]!.map(id => previous.get(id)?.credit ?? 0));
      const baseline = f[basis] * l.quantity - fullCredit;
      unchanged = !!previousLine && previousLine.unitListPrice === l.unitListPrice && previousLine.taxRateBps === l.taxRateBps &&
        previousLine.priceIncludesTax === l.priceIncludesTax && predecessor.unitIds[l.orderLineId]?.length === l.quantity &&
        round(basis === 'net' ? baseline : baseline / factor) === previousLine.lineNet &&
        round(basis === 'gross' ? baseline : baseline * factor) === previousLine.lineGross;
    }
    const finalBases = livePositions.map(p => f[basis] - funded[p]!);
    const liveNet = unchanged ? [] : custody(round(finalBases.reduce((n, v) => n + (basis === 'net' ? v : v / factor), 0)), livePositions.length);
    const liveGross = unchanged ? [] : custody(round(finalBases.reduce((n, v) => n + (basis === 'gross' ? v : v * factor), 0)), livePositions.length);
    let active = 0;
    const economics = ids[l.orderLineId]!.map((id, position) => {
      if (consumed.has(id) || unchanged) {
        const prior = previous.get(id); requireFact(prior, 'frozen unit lacks predecessor custody'); return structuredClone(prior.economics);
      }
      const at = active++, b = finalBases[at]!;
      return { net: liveNet[at]!, gross: liveGross[at]!, cashRefundGross: round(basis === 'gross' ? b : b * factor) };
    });
    unitEconomics[l.orderLineId] = economics;
    const lineNet = sum(economics.map(e => e.net)), lineGross = sum(economics.map(e => e.gross));
    const cashRefundGrossUnits = economics.map(e => e.cashRefundGross);
    return { ...structuredClone(l), lineNet, lineGross,
      proratedUnitPriceWithTax: l.quantity ? round(lineGross / l.quantity) : 0,
      cashRefundGrossUnits };
  });
  const netDiscount = sum(ordinary.lines.map((l, i) => l.lineNet - lines[i]!.lineNet));
  const grossDiscount = sum(ordinary.lines.map((l, i) => l.lineGross - lines[i]!.lineGross));
  const shippingFactor = 1 + ordinary.shippingBasis.taxRateBps / 10000;
  const shippingGross = ordinary.shippingBasis.includesTax ? ordinary.totals.shippingTotal : round(ordinary.totals.shippingTotal * shippingFactor);
  const adjustmentTotal = sum(ordinary.adjustments.map(a => a.amount));
  const taxable = sum(ordinary.adjustments.filter(a => a.taxable).map(a => a.amount));
  const adjustmentRate = ordinary.lines[0]?.taxRateBps ?? 0;
  const adjustmentTax = ordinary.pricesIncludeTax ? taxable - cents(Math.round(taxable / (1 + adjustmentRate / 10000)), true)
    : cents(Math.round(taxable * adjustmentRate / 10000), true);
  const totals: MoneyTotals = { ...ordinary.totals,
    discountTotal: cents(ordinary.totals.discountTotal + (ordinary.pricesIncludeTax ? grossDiscount : netDiscount), true),
    taxTotal: cents(ordinary.totals.taxTotal - (grossDiscount - netDiscount), true),
    grandTotal: cents(Math.max(0, sum([sum(lines.map(l => l.lineGross)), shippingGross, adjustmentTotal,
      ordinary.pricesIncludeTax ? 0 : adjustmentTax]))) };
  return { lines, totals, unitEconomics };
}
export function currentCreditPricingHash(snapshot: Omit<OrderPricingSnapshotV2, 'quoteHash'> | OrderPricingSnapshotV2): string {
  const { quoteHash: _hash, ...facts } = snapshot as OrderPricingSnapshotV2; return digest(facts);
}
/** predecessor must be produced by the normalized reader with complete durable evidence. */
export function buildCurrentCreditPricingSnapshot(input: BuildCurrentCreditPricingInput): OrderPricingSnapshotV2 {
  return buildPricing(input, false);
}
function buildPricing(input: BuildCurrentCreditPricingInput, reading: boolean): OrderPricingSnapshotV2 {
  const origin = strict(input.origin), ordinary = strict(input.ordinary), e = input.evidence, state = funding(e);
  requireFact(e.refundsComplete === true && Array.isArray(e.refunds), 'complete refund lineage evidence required');
  requireFact(origin.selectedCredit && !ordinary.selectedCredit && !ordinary.applied.some(a => a.kind === 'account_credit'), 'placement credit & ordinary pricing required');
  requireFact(origin.currency === ordinary.currency &&
    origin.selectedCredit.accountId === e.redemption.accountCreditId && origin.selectedCredit.appliedAmount === e.redemption.amount &&
    serial(origin.selectedCredit.allocation) === serial(e.redemption.operationalAllocation), 'immutable origin redemption differs');
  requireFact(Array.isArray(input.couponCodes) && input.couponCodes.every(c => typeof c === 'string' && c.length > 0 && c.length <= 255) &&
    new Set(input.couponCodes.map(c => c.toLowerCase())).size === input.couponCodes.length, 'coupon membership');
  requireFact(ordinary.couponCodes.every(code => input.couponCodes.some(c => c.toLowerCase() === code.toLowerCase())), 'ordinary coupon membership');
  const predecessor = input.predecessor ?? v1View(origin, e);
  verifyPredecessor(predecessor, e);
  requireFact(serial(predecessor.snapshot.version === 1 ? predecessor.snapshot : predecessor.snapshot.origin) === serial(origin), 'predecessor immutable origin differs');
  requireFact(input.lineage && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.lineage.editId) &&
    input.lineage.predecessorSnapshotDigest === creditPricingSnapshotDigest(predecessor.snapshot) &&
    Array.isArray(input.lineage.consumedUnitIds) && new Set(input.lineage.consumedUnitIds).size === input.lineage.consumedUnitIds.length,
  'predecessor lineage binding');
  const previous = unitMap(predecessor), seenIds = new Set<string>();
  requireFact(input.unitIds && Object.keys(input.unitIds).length === ordinary.lines.length, 'unit ID line closure');
  for (const l of ordinary.lines) {
    const ids = input.unitIds[l.orderLineId], indexes = input.originalUnitIndexes[l.orderLineId];
    requireFact(Array.isArray(ids) && ids.length === l.quantity && Array.isArray(indexes) && indexes.length === l.quantity, 'unit ID quantity');
    ids.forEach((id, position) => {
      requireFact(typeof id === 'string' && !seenIds.has(id), 'duplicate unit ID'); seenIds.add(id);
      const index = indexes[position]!, prior = previous.get(id);
      if (index !== null) requireFact(id === originalCreditUnitId(e.redemption.id, l.orderLineId, index), 'original unit ID differs');
      else if (!prior) requireFact(id.startsWith(`edit:${input.lineage.editId}:${l.orderLineId}:`) && /^(0|[1-9][0-9]*)$/.test(id.slice(id.lastIndexOf(':') + 1)) &&
        Number.isSafeInteger(Number(id.slice(id.lastIndexOf(':') + 1))), 'new unit birth identity');
      if (prior) requireFact(prior.line === l.orderLineId && prior.index === index, 'unit identity transferred or replaced');
    });
  }
  const consumed = new Set(input.lineage.consumedUnitIds);
  for (const id of consumed) requireFact(previous.has(id) && seenIds.has(id), 'consumed predecessor unit removed');
  if (predecessor.snapshot.version === 2) for (const id of predecessor.snapshot.lineage.consumedUnitIds) {
    requireFact(consumed.has(id), 'prior frozen unit lost consumed custody');
  }
  if (!reading) {
    let evidenced = new Set(Object.entries(predecessor.consumedPositions).flatMap(([line, positions]) => positions.map(p => predecessor.unitIds[line]![p]!)));
    if (!input.predecessor) evidenced = consumedIds(predecessor, e, hash => {
      requireFact(hash === creditPricingSnapshotDigest(origin), 'initial refund source is not immutable origin'); return predecessor;
    });
    requireFact(serial([...consumed].sort()) === serial([...evidenced].sort()), 'current consumed lineage differs');
  }
  for (const [id, unit] of previous) if (seenIds.has(id) && unit.index !== null && state.returnedIndexes[unit.line]?.includes(unit.index)) {
    requireFact(consumed.has(id), 'returned original unit requires frozen custody');
  }
  const allocation = allocationFor(ordinary, input.originalUnitIndexes, state), basis = origin.pricesIncludeTax ? 'gross' : 'net';
  for (const l of ordinary.lines) input.unitIds[l.orderLineId]!.forEach((id, p) => requireFact(!consumed.has(id) || allocation[l.orderLineId]![p] === 0, 'consumed unit retains live credit'));
  const predecessorUnitMapDigest = digest({ unitIds: predecessor.unitIds, originalUnitIndexes: predecessor.originalUnitIndexes, unitEconomics: predecessor.unitEconomics });
  if (input.lineage.predecessorUnitMapDigest !== undefined) requireFact(input.lineage.predecessorUnitMapDigest === predecessorUnitMapDigest, 'predecessor unit map digest');
  const result: OrderPricingSnapshotV2 = { version: 2, pricingProfile: 'retained-credit-edit-v1', currency: ordinary.currency,
    pricesIncludeTax: ordinary.pricesIncludeTax, couponCodes: [...input.couponCodes], quoteHash: '', origin, ordinary,
    ordinaryUnitFacts: structuredClone(input.ordinaryUnitFacts),
    credit: { redemptionId: e.redemption.id, orderId: e.redemption.orderId!, accountId: e.redemption.accountCreditId,
      promotionId: origin.selectedCredit.promotionId, basis, originDigest: digest(e.redemption.operationalAllocation),
      atPricingRestoreIds: e.history.map(h => h.id).sort(), atPricingRestoreDigest: historyDigest(e.history), allocation },
    originalUnitIndexes: structuredClone(input.originalUnitIndexes), unitIds: structuredClone(input.unitIds),
    lineage: { ...structuredClone(input.lineage), consumedUnitIds: [...consumed].sort(), predecessorUnitMapDigest },
    ...finalFacts(ordinary, allocation, basis, input.ordinaryUnitFacts, input.unitIds, consumed, predecessor) };
  result.quoteHash = currentCreditPricingHash(result); return result;
}

/** V1 stays strict; V2 sources require activated durable edit-row custody. */
export function readCurrentOrderPricingSnapshot(raw: unknown, context: CurrentPricingContext): CurrentOrderPricing | null {
  if (raw == null) return null;
  const sources = new Map<string, unknown>(), rows = new Map<string, CreditPricingSource>();
  const add = (s: unknown) => { if (s == null) return; const hash = creditPricingSnapshotDigest(s), old = sources.get(hash);
    requireFact(old === undefined || serial(old) === serial(s), 'duplicate source digest differs'); sources.set(hash, s); };
  add(raw);
  for (const row of context.pricingSources ?? []) {
    requireFact(row && typeof row.id === 'string' && !rows.has(row.id) && object(row.before) && object(row.after), 'duplicate or malformed durable pricing row');
    rows.set(row.id, row); add(row.before.currentPricing); add(row.after.activatedPricingSnapshot);
  }
  for (const source of [...sources.values()]) if (object(source) && source.version === 2) add(source.origin);
  const cache = new Map<string, CurrentOrderPricing>(), visiting = new Set<string>(), visitingEdits = new Set<string>();
  const resolve = (hash: string): CurrentOrderPricing => {
    const cached = cache.get(hash); if (cached) return cached;
    const source = sources.get(hash); requireFact(source, 'pricing source absent from durable edit history');
    requireFact(!visiting.has(hash), 'cyclic pricing source'); visiting.add(hash);
    const v = source as OrderPricingSnapshotV2;
    let view: CurrentOrderPricing;
    if (v.version !== 2) view = v1View(strict(source as OrderPricingSnapshotV1), context.creditEvidence);
    else {
      requireFact(v.pricingProfile === 'retained-credit-edit-v1' && v.currency === context.currency && context.creditEvidence &&
        v.credit && Array.isArray(v.credit.atPricingRestoreIds) && new Set(v.credit.atPricingRestoreIds).size === v.credit.atPricingRestoreIds.length &&
        v.lineage && !visitingEdits.has(v.lineage.editId), 'version/profile/credit evidence');
      visitingEdits.add(v.lineage.editId);
      const row = rows.get(v.lineage.editId), e = context.creditEvidence;
      requireFact(row && row.orderId === e.redemption.orderId && object(row.before) && object(row.after) && object(row.settlement), 'activated pricing row custody required');
      const before = row.before, after = row.after, settlement = row.settlement;
      requireFact(creditPricingSnapshotDigest(before.currentPricing) === v.lineage.predecessorSnapshotDigest &&
        serial(after.activatedPricingSnapshot) === serial(v) && settlement.phase === 'activated' && object(settlement.activationReceipt) && object(after.proposal), 'activated pricing row binding');
      const receipt = settlement.activationReceipt, proposal = after.proposal;
      const { proposalDigest: _proposalDigest, ...proposalPayload } = proposal;
      requireFact(receipt.activatedSnapshotHash === hash && receipt.proposalDigest === proposal.proposalDigest &&
        proposal.proposalDigest === digest(proposalPayload) && object(proposal.pricingSnapshot) &&
        object(proposal.lineIds) && object(proposal.activation), 'activation receipt/proposal binding');
      const proposed = proposal.pricingSnapshot, activationProposal = proposal.activation;
      requireFact(proposal.editId === row.id && proposal.orderId === row.orderId && receipt.requestDigest === proposal.requestDigest &&
        typeof proposal.requestDigest === 'string' && /^[a-f0-9]{64}$/.test(proposal.requestDigest) &&
        Array.isArray(proposal.postingKeys) && serial(receipt.postingKeys) === serial(proposal.postingKeys), 'activation operation receipt');
      for (const key of ['origin', 'ordinary', 'ordinaryUnitFacts', 'unitEconomics', 'lines', 'totals', 'couponCodes', 'pricesIncludeTax', 'currency'] as const) {
        requireFact(serial(proposed[key]) === serial(v[key]), `proposal ${key} differs from activation`);
      }
      requireFact(object(proposed.credit) && serial(proposed.credit.allocation) === serial(v.credit.allocation) &&
        proposed.credit.basis === v.credit.basis && proposed.credit.originDigest === v.credit.originDigest, 'proposal immutable funding differs');
      requireFact(serial(proposed.unitIds) === serial(v.unitIds) && serial(proposed.originalUnitIndexes) === serial(v.originalUnitIndexes) &&
        serial(proposed.lineage) === serial(v.lineage) && serial(activationProposal.unitIds) === serial(v.unitIds) &&
        serial(activationProposal.indexes) === serial(v.originalUnitIndexes) &&
        Object.keys(proposal.lineIds).length === v.lines.length &&
        new Set(Object.values(proposal.lineIds)).size === v.lines.length &&
        v.lines.every(l => Object.values(proposal.lineIds as Record<string, unknown>).includes(l.orderLineId)), 'proposal unit lineage closure');
      const predecessor = resolve(v.lineage.predecessorSnapshotDigest), byId = new Map(e.history.map(h => [h.id, h]));
      requireFact(object(activationProposal.predecessor) &&
        creditPricingSnapshotDigest(activationProposal.predecessor.snapshot) === v.lineage.predecessorSnapshotDigest &&
        serial(activationProposal.lineage) === serial(v.lineage) && serial(activationProposal.origin) === serial(v.origin) &&
        serial(activationProposal.ordinary) === serial(v.ordinary) && serial(activationProposal.ordinaryUnitFacts) === serial(v.ordinaryUnitFacts), 'proposal predecessor source binding');
      verifyPredecessor(activationProposal.predecessor as unknown as CurrentOrderPricing, e);
      const capturedConsumed = activationProposal.predecessor.consumedPositions;
      requireFact(object(capturedConsumed) && Object.keys(capturedConsumed).length === predecessor.lines.length, 'proposal consumed line closure');
      const capturedIds = predecessor.lines.flatMap(line => {
        const captured = capturedConsumed[line.orderLineId];
        requireFact(Array.isArray(captured) && new Set(captured).size === captured.length && captured.every(p =>
          Number.isSafeInteger(p) && p >= 0 && p < predecessor.unitIds[line.orderLineId]!.length), 'proposal consumed positions');
        return captured.map(p => predecessor.unitIds[line.orderLineId]![p]!);
      });
      requireFact(serial(capturedIds.sort()) === serial([...v.lineage.consumedUnitIds].sort()), 'proposal consumed boundary differs');
      const activation = v.credit.atPricingRestoreIds.map(id => { const h = byId.get(id); requireFact(h, 'activation restoration absent from complete ledger'); return h; });
      requireFact(historyDigest(activation) === v.credit.atPricingRestoreDigest, 'activation restoration digest');
      const ownRows = activation.filter(row => { if (!row.allocation) return false; const envelope = JSON.parse(row.allocation) as Record<string, unknown>;
        if (envelope.type !== 'account_credit.edit_restore' || envelope.editId !== v.lineage.editId) return false;
        requireFact(envelope.requestDigest === proposal.requestDigest, 'activation posted request digest'); return true; });
      requireFact(serial(ownRows.map(row => row.idempotencyKey).sort()) === serial([...proposal.postingKeys].sort()), 'activation posted effect closure');
      const frozen = new Set(v.lineage.consumedUnitIds);
      const activationEvidence = { ...e, history: activation, refunds: (e.refunds ?? []).filter(refund => {
        if (refund.state !== 'Settled') return false;
        const units = readCreditRefundEvidence(refund); if (!units) return false;
        return units.lines.some(line => {
          if ('unitIds' in line) {
            const ids = line.unitIds;
            requireFact(Array.isArray(ids) && ids.every(id => typeof id === 'string'), 'frozen unit ID vector');
            return ids.some(id => frozen.has(id));
          }
          return line.originalIndexes.some(index => index !== null && frozen.has(originalCreditUnitId(e.redemption.id, line.orderLineId, index)));
        });
      }) };
      const actualConsumed = consumedIds(predecessor, activationEvidence, resolve, false);
      for (const id of frozen) requireFact(actualConsumed.has(id), 'frozen consumed unit lacks activation evidence');
      const expected = buildPricing({ origin: v.origin, ordinary: v.ordinary, couponCodes: v.couponCodes,
        originalUnitIndexes: v.originalUnitIndexes, ordinaryUnitFacts: v.ordinaryUnitFacts, unitIds: v.unitIds,
        predecessor, lineage: v.lineage, evidence: activationEvidence }, true);
      requireFact(serial(expected) === serial(v), 'saved activation facts/hash differ');
      view = v2View(v, funding(e)); visitingEdits.delete(v.lineage.editId);
    }
    visiting.delete(hash); cache.set(hash, view); return view;
  };
  const view = resolve(creditPricingSnapshotDigest(raw));
  if (view.snapshot.version === 1) readOrderPricingSnapshot(raw, context);
  else readOrderPricingSnapshot(view.snapshot.ordinary, { ...context, totals: undefined });
  if (context.totals) requireFact(serial(view.totals) === serial(context.totals), 'stored order totals');
  if (context.creditEvidence) view.consumedPositions = positions(view, consumedIds(view, context.creditEvidence, resolve));
  return structuredClone(view);
}
