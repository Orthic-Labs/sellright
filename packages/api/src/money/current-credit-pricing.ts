import { importedOrderEditMetadata, isImportedPricingBasis } from '../import/source-compatibility.js';
/** Current edited prices are independent from immutable placement/redemption proof. */
import { createHash } from 'node:crypto';
import { readCreditFundingState, type CreditFundingState, type EditFundingHistoryRow,
  type EditFundingRedemption, type EditFundingTargetLine, originalCreditUnitId,
  readCreditRefundEvidence, creditReturnSnapshotDigest, type CreditRefundEvidence, type CreditUnitReturns } from '../account-credit/edit-funding.js';
import { readOrderPricingSnapshot, type MoneyTotals, type OrderPricingSnapshotV1 } from './pricing-snapshot.js';
import { prorateSigned, type ShippingPricingBasis, type ShippingCarrier, type RetainedShipping } from './promotion-stack.js';
import { readImportedOrderEditBasis } from '../orders/order-edit-stack.js';
import { decodeCreditPricingOrigin, isImportedCreditOrigin, importedCreditOriginLineFacts, importedCreditOriginOrdinaryUnitFacts,
  type CreditPricingOrigin, type ImportedCreditOriginV1, type ImportedCreditSourceEvidence } from './imported-credit-origin.js';
export { decodeCreditPricingOrigin, isImportedCreditOrigin, type CreditPricingOrigin } from './imported-credit-origin.js';

export interface CreditPricingEvidence {
  redemption: EditFundingRedemption;
  /** Every POSTED RESTORE, including rows written after pricing activation. */
  history: readonly EditFundingHistoryRow[]; historyComplete: true;
  refunds?: readonly CreditRefundEvidence[]; refundsComplete?: true;
  importedSource?: ImportedCreditSourceEvidence; importedOrigin?: ImportedCreditOriginV1;
}
export type OriginalUnitIndexes = Record<string, Array<number | null>>;
export type UnitEconomics = { net: number; gross: number; cashRefundGross: number };
export type UnitIds = Record<string, string[]>;
export interface SourceCustody { version: 1; originDigest: string;
  detached: Record<string, Array<{ unitId: string; sourceSlot: number; originalIndex: number | null; cashRefundGross: number }>> }
export type SourceRefundUnits = Record<string, Array<UnitEconomics & { unitId: string; originalIndex: number | null; present: boolean }>>;
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
  origin: CreditPricingOrigin;
  ordinary: OrderPricingSnapshotV1;
  ordinaryUnitFacts: OrdinaryUnitFacts;
  credit: { redemptionId: string; orderId: string; accountId: string; promotionId: string;
    basis: 'net' | 'gross'; originDigest: string; atPricingRestoreIds: string[]; atPricingRestoreDigest: string;
    allocation: Record<string, number[]>; sourceCustodyAllocation?: Record<string, number[]> };
  originalUnitIndexes: OriginalUnitIndexes;
  unitIds: UnitIds; unitEconomics: Record<string, UnitEconomics[]>; lineage: CreditPricingLineage;
  sourceCustody?: SourceCustody;
  lines: CurrentPricingLine[]; totals: MoneyTotals;
}
export interface CurrentOrderPricing {
  snapshot: CreditPricingOrigin | OrderPricingSnapshotV2;
  currency: string; pricesIncludeTax: boolean; couponCodes: string[]; quoteHash: string;
  lines: CurrentPricingLine[]; totals: MoneyTotals;
  selectedCredit: OrderPricingSnapshotV1['selectedCredit'];
  originalUnitIndexes: OriginalUnitIndexes;
  unitIds: UnitIds; unitEconomics: Record<string, UnitEconomics[]>; consumedPositions: Record<string, number[]>;
  /** Current-position remaining credit; later returns may reduce it below saved pricing. */
  liveAllocation: Record<string, number[]>;
  fundingState: CreditFundingState | null;
  sourceCustody?: SourceCustody; liveDetachedAllocation: Record<string, number[]>; sourceRefundUnits: SourceRefundUnits;
  admittedLegacyRefundIds: string[]; consumedSourceUnitIds: string[]; reservedSourceUnitIds: string[];
}
export interface CurrentPricingContext {
  currency: string; orderLines: Array<{ id: string; quantity: number }>;
  mode: 'settlement' | 'refund'; totals?: MoneyTotals; creditEvidence?: CreditPricingEvidence;
  pricingSources?: readonly CreditPricingSource[];
}
export interface BuildCurrentCreditPricingInput {
  origin: CreditPricingOrigin; ordinary: OrderPricingSnapshotV1;
  couponCodes: string[]; evidence: CreditPricingEvidence; originalUnitIndexes: OriginalUnitIndexes;
  ordinaryUnitFacts: OrdinaryUnitFacts;
  unitIds: UnitIds; predecessor?: CurrentOrderPricing; lineage: CreditPricingLineage;
  sourceCustody?: SourceCustody;
  pricingSources?: readonly CreditPricingSource[];
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
  options: { consumedPositions?: Record<string, number[]>; sourceCustody?: SourceCustody; liveDetachedAllocation?: Record<string, number[]>;
    consumedUnitIds?: string[] } = {}): EditFundingTargetLine[] {
  const s = strict(ordinary); requireFact(!s.selectedCredit && !s.applied.some(a => a.kind === 'account_credit'), 'ordinary pricing contains credit');
  requireFact(basis === 'net' || basis === 'gross', 'credit basis'); const units = ordinaryUnits(s, producer);
  requireFact(indexes && Object.keys(indexes).length === s.lines.length, 'identity line closure');
  return s.lines.map(l => { requireFact(Array.isArray(indexes[l.orderLineId]) && indexes[l.orderLineId]!.length === l.quantity, 'identity quantity');
    const current = indexes[l.orderLineId]!.map((originalIndex, position) => ({
      originalIndex, ...(options.consumedPositions?.[l.orderLineId]?.includes(position) ? { consumed: true as const } : {}),
      maximumCredit: cents(Math.floor(units.get(l.orderLineId)![basis])) }));
    const detached = (options.sourceCustody?.detached[l.orderLineId] ?? []).map((unit, position) => ({ originalIndex: unit.originalIndex,
      unitId: unit.unitId, ...(options.consumedUnitIds?.includes(unit.unitId) ? { consumed: true as const } : {}),
      maximumCredit: cents(options.liveDetachedAllocation?.[l.orderLineId]?.[position] ?? 0) }));
    return { orderLineId: l.orderLineId, units: [...current, ...detached] };
  });
}

function allocationFor(s: Pick<OrderPricingSnapshotV1, 'lines'>, indexes: OriginalUnitIndexes, state: CreditFundingState, custody?: SourceCustody): Record<string, number[]> {
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
  for (const [line, units] of Object.entries(custody?.detached ?? {})) {
    requireFact(seen.has(line), 'detached source line outside ordinary closure');
    for (const unit of units) if (unit.originalIndex !== null) {
      const index = unit.originalIndex, used = seen.get(line)!;
      requireFact(Object.hasOwn(state.remaining, line) && Number.isSafeInteger(index) && index >= 0 && index < state.remaining[line]!.length && !used.has(index), 'duplicate or invalid detached original index');
      used.add(index);
    }
  }
  for (const [id, units] of Object.entries(state.remaining)) units.forEach((_n, index) => {
    requireFact(state.returnedIndexes[id]!.includes(index) || seen.get(id)?.has(index), 'unmapped surviving original index');
  });
  requireFact(sum([...Object.values(allocation).flat(), ...Object.values(detachedAllocation(custody, state)).flat()]) === state.retained, 'current funding conservation');
  return allocation;
}
function detachedAllocation(custody: SourceCustody | undefined, state: CreditFundingState): Record<string, number[]> {
  return Object.fromEntries(Object.entries(custody?.detached ?? {}).map(([line, units]) => [line, units.map(unit =>
    unit.originalIndex === null ? 0 : state.remaining[line]?.[unit.originalIndex] ?? 0)]));
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const custody = (amount: number, quantity: number): number[] => prorateSigned(Array(quantity).fill(1), amount);
function unitMap(s: CurrentOrderPricing) {
  return new Map(Object.entries(s.sourceRefundUnits).flatMap(([line, units]) => units.map((unit, position) => [unit.unitId, {
    line, position, index: unit.originalIndex, economics: { net: unit.net, gross: unit.gross, cashRefundGross: unit.cashRefundGross },
    credit: unit.present ? s.selectedCredit?.allocation[line]?.[position] ?? 0 : s.snapshot.version === 2 ?
      s.snapshot.credit.sourceCustodyAllocation?.[line]?.[position - s.unitIds[line]!.length] ?? 0 :
      unit.originalIndex === null || !isImportedCreditOrigin(s.snapshot) ? 0 : s.snapshot.redemptionSource.operationalAllocation?.[line]?.[unit.originalIndex] ?? 0,
  }] as const)));
}
type DomainInput = Omit<CurrentOrderPricing, 'sourceRefundUnits' | 'liveDetachedAllocation' | 'admittedLegacyRefundIds' | 'consumedSourceUnitIds' | 'reservedSourceUnitIds'>;
function withDomain(view: DomainInput): CurrentOrderPricing {
  const imported = isImportedCreditOrigin(view.snapshot) ? view.snapshot : view.snapshot.version === 2 && isImportedCreditOrigin(view.snapshot.origin) ? view.snapshot.origin : null;
  const sourceRefundUnits: SourceRefundUnits = Object.fromEntries(view.lines.map(line => [line.orderLineId, [
    ...view.unitIds[line.orderLineId]!.map((unitId, position) => ({ unitId, originalIndex: view.originalUnitIndexes[line.orderLineId]![position]!,
      ...view.unitEconomics[line.orderLineId]![position]!, present: true })),
    ...(view.sourceCustody?.detached[line.orderLineId] ?? []).map(unit => ({ unitId: unit.unitId, originalIndex: unit.originalIndex,
      net: 0, gross: 0, cashRefundGross: unit.cashRefundGross, present: false })),
  ]]));
  const legacy = Object.values(imported?.capture.sourceUnits ?? {}).flat();
  return { ...view, sourceRefundUnits, liveDetachedAllocation: view.fundingState ? detachedAllocation(view.sourceCustody, view.fundingState) : {},
    admittedLegacyRefundIds: imported?.capture.legacyRefunds.map(refund => refund.id) ?? [],
    consumedSourceUnitIds: legacy.filter(unit => unit.consumed).map(unit => unit.unitId),
    reservedSourceUnitIds: legacy.filter(unit => unit.legacyRefundId).map(unit => unit.unitId) };
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
  return withDomain({ snapshot: s, currency: s.currency, pricesIncludeTax: s.pricesIncludeTax, couponCodes: s.couponCodes, quoteHash: s.quoteHash,
    lines: s.lines.map(l => ({ ...l, cashRefundGrossUnits: Array(l.quantity).fill(l.proratedUnitPriceWithTax) })), totals: s.totals,
    selectedCredit: s.selectedCredit, originalUnitIndexes: indexes, unitIds, unitEconomics,
    consumedPositions: Object.fromEntries(s.lines.map(l => [l.orderLineId, []])),
    liveAllocation: state ? allocationFor(s, indexes, state) : structuredClone(s.selectedCredit?.allocation ?? Object.fromEntries(s.lines.map(l => [l.orderLineId, Array(l.quantity).fill(0)]))),
    fundingState: state });
}
function v2View(s: OrderPricingSnapshotV2, state: CreditFundingState): CurrentOrderPricing {
  return withDomain({ snapshot: structuredClone(s), currency: s.currency, pricesIncludeTax: s.pricesIncludeTax, couponCodes: [...s.couponCodes],
    quoteHash: s.quoteHash, lines: structuredClone(s.lines), totals: structuredClone(s.totals),
    selectedCredit: { accountId: s.credit.accountId, promotionId: s.credit.promotionId,
      appliedAmount: sum(Object.values(s.credit.allocation).flat()), allocation: structuredClone(s.credit.allocation) },
    originalUnitIndexes: structuredClone(s.originalUnitIndexes), unitIds: structuredClone(s.unitIds), unitEconomics: structuredClone(s.unitEconomics),
    consumedPositions: Object.fromEntries(s.lines.map(l => [l.orderLineId, []])),
    liveAllocation: allocationFor(s.ordinary, s.originalUnitIndexes, state, s.sourceCustody), fundingState: state,
    ...(s.sourceCustody ? { sourceCustody: structuredClone(s.sourceCustody) } : {}) });
}
function importedView(s: ImportedCreditOriginV1, evidence: CreditPricingEvidence): CurrentOrderPricing {
  const origin = decodeCreditPricingOrigin(s, evidence), state = funding(evidence), facts = importedCreditOriginLineFacts(s);
  const captured = funding({ ...evidence, history: evidence.history.filter(row => s.capture.restoreIds.includes(row.id)) });
  const originalUnitIndexes = Object.fromEntries(s.capture.lines.map(line => [line.id, s.capture.currentUnitIds[line.id]!.map(id =>
    s.capture.sourceUnits[line.id]!.find(unit => unit.unitId === id)!.originalIndex)]));
  const sourceCustody: SourceCustody = { version: 1, originDigest: s.captureDigest,
    detached: Object.fromEntries(s.capture.lines.map(line => [line.id, s.capture.sourceUnits[line.id]!.filter(unit => !s.capture.currentUnitIds[line.id]!.includes(unit.unitId))
      .map(({ legacyRefundId: _refund, consumed: _consumed, ...unit }) => unit)])) };
  const unitEconomics: Record<string, UnitEconomics[]> = {};
  const lines = s.capture.lines.map(line => {
    const f = facts.find(fact => fact.key === line.id)!;
    const net = custody(line.lineSubtotal - line.lineDiscount, line.quantity), gross = custody(line.lineTotal, line.quantity);
    const cash = s.capture.currentUnitIds[line.id]!.map(id => s.capture.sourceUnits[line.id]!.find(unit => unit.unitId === id)!.cashRefundGross);
    unitEconomics[line.id] = net.map((n, p) => ({ net: n, gross: gross[p]!, cashRefundGross: cash[p]! }));
    return { ...f, orderLineId: line.id, lineNet: line.lineSubtotal - line.lineDiscount, lineGross: line.lineTotal,
      proratedUnitPriceWithTax: cash[0] ?? 0, cashRefundGrossUnits: cash };
  });
  const currentAllocation = allocationFor({ lines }, originalUnitIndexes, captured, sourceCustody);
  return withDomain({ snapshot: structuredClone(s), currency: origin.currency, pricesIncludeTax: origin.pricesIncludeTax,
    couponCodes: [...s.capture.couponCodes], quoteHash: s.captureDigest, lines, totals: structuredClone(s.capture.totals),
    selectedCredit: { ...origin.selectedCredit, appliedAmount: sum(Object.values(currentAllocation).flat()), allocation: currentAllocation },
    originalUnitIndexes, unitIds: structuredClone(s.capture.currentUnitIds), unitEconomics, consumedPositions: Object.fromEntries(lines.map(line => [line.orderLineId, []])),
    liveAllocation: allocationFor({ lines }, originalUnitIndexes, state, sourceCustody), fundingState: state, sourceCustody });
}
function verifyPredecessor(p: CurrentOrderPricing, e: CreditPricingEvidence): void {
  const raw = p.snapshot;
  const expected = isImportedCreditOrigin(raw) ? importedView(raw, e) : raw.version === 1 ? v1View(strict(raw), e) : v2View(raw, funding(e));
  if (raw.version === 2) requireFact(raw.quoteHash === currentCreditPricingHash(raw), 'predecessor economic hash');
  for (const key of ['currency', 'pricesIncludeTax', 'couponCodes', 'quoteHash', 'lines', 'totals', 'selectedCredit', 'originalUnitIndexes', 'unitIds', 'unitEconomics', 'sourceCustody', 'sourceRefundUnits', 'admittedLegacyRefundIds'] as const) {
    requireFact(serial(p[key]) === serial(expected[key]), `normalized predecessor ${key} differs from raw source`);
  }
}
/** Resolve frozen refund identities against canonically validated source snapshots. */
function consumedIds(view: CurrentOrderPricing, evidence: CreditPricingEvidence, resolve: (hash: string) => CurrentOrderPricing,
  validatePostingJoin = true): Set<string> {
  const consumed = new Set(view.consumedSourceUnitIds), refunded = new Set<string>(), current = unitMap(view), state = funding(evidence);
  const refunds = new Map<string, { refund: CreditRefundEvidence; frozen: CreditUnitReturns | null }>();
  for (const refund of evidence.refunds ?? []) {
    requireFact(typeof refund.id === 'string' && !refunds.has(refund.id), 'duplicate refund evidence');
    refunds.set(refund.id, { refund, frozen: null });
  }
  for (const [id, u] of current) if (u.index !== null && state.returnedIndexes[u.line]?.includes(u.index)) consumed.add(id);
  for (const refund of evidence.refunds ?? []) {
    if (refund.state === 'Failed') {
      const origin = isImportedCreditOrigin(view.snapshot) ? view.snapshot : view.snapshot.version === 2 && isImportedCreditOrigin(view.snapshot.origin) ? view.snapshot.origin : null;
      const failed = new Set(Object.values(origin?.capture.sourceUnits ?? {}).flat().filter(u=>u.legacyRefundId === refund.id).map(u=>u.unitId));
      view.reservedSourceUnitIds = view.reservedSourceUnitIds.filter(id=>!failed.has(id));
      continue;
    }
    if (view.admittedLegacyRefundIds.includes(refund.id)) {
      const origin = isImportedCreditOrigin(view.snapshot) ? view.snapshot : view.snapshot.version === 2 && isImportedCreditOrigin(view.snapshot.origin) ? view.snapshot.origin : null;
      for (const u of Object.values(origin?.capture.sourceUnits ?? {}).flat().filter(u => u.legacyRefundId === refund.id)) {
        if (!view.reservedSourceUnitIds.includes(u.unitId)) view.reservedSourceUnitIds.push(u.unitId);
        if (refund.state === 'Settled' && current.has(u.unitId)) consumed.add(u.unitId);
      }
      continue;
    }
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
      if ('unitEconomics' in line) {
        const expectedPresent = line.unitIds.filter(unitId => source.sourceRefundUnits[line.orderLineId]?.find(unit => unit.unitId === unitId)?.present === true);
        requireFact(line.presentUnitIds === undefined ? !source.sourceCustody && !isImportedCreditOrigin(source.snapshot) && !(source.snapshot.version === 2 && isImportedCreditOrigin(source.snapshot.origin)) : serial([...line.presentUnitIds].sort()) === serial([...expectedPresent].sort()), 'refund source present membership differs');
      }
      if ('unitEconomics' in line) requireFact(serial(u.economics) === serial(line.unitEconomics[i]), 'settled refund source economics differ');
      const now = current.get(id!);
      if (now) requireFact(now.line === u.line && now.index === u.index, 'settled unit transferred across native lineage');
      requireFact(!refunded.has(id!), 'unit consumed by multiple settled refunds'); refunded.add(id!);
      if (!view.reservedSourceUnitIds.includes(id!)) view.reservedSourceUnitIds.push(id!);
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
      if (view.admittedLegacyRefundIds.includes(row.refundId)) continue;
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
    } else if (unchanged && isImportedCreditOrigin(predecessor.snapshot)) {
      const old = importedCreditOriginOrdinaryUnitFacts(predecessor.snapshot)[l.orderLineId];
      unchanged = !!old && old.net === f.net && old.gross === f.gross && previousLine?.taxRateBps === l.taxRateBps && previousLine.priceIncludesTax === l.priceIncludesTax;
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
  const shippingGross = ordinary.retainedShippingFinal ? sum(ordinary.retainedShippingFinal.map(l => l.gross)) : ordinary.shippingBasis.includesTax ? ordinary.totals.shippingTotal : round(ordinary.totals.shippingTotal * shippingFactor);
  const adjustmentTotal = sum(ordinary.adjustments.map(a => a.amount));
  const taxable = sum(ordinary.adjustments.filter(a => a.taxable && !a.sourceSurcharge).map(a => a.amount));
  const adjustmentRate = ordinary.lines[0]?.taxRateBps ?? 0;
  const sourceAdjustmentTax = sum(ordinary.adjustments.flatMap(a => a.sourceSurcharge ? [a.sourceSurcharge.gross - a.sourceSurcharge.net] : []));
  const adjustmentTax = ordinary.pricesIncludeTax ? taxable - cents(Math.round(taxable / (1 + adjustmentRate / 10000)), true)
    : cents(Math.round(taxable * adjustmentRate / 10000), true);
  const grand = sum([sum(lines.map(l => l.lineGross)), shippingGross, adjustmentTotal, ordinary.pricesIncludeTax ? sourceAdjustmentTax : adjustmentTax + sourceAdjustmentTax]);
  const exactComponents = !!ordinary.retainedShipping || ordinary.adjustments.some(a=>a.sourceSurcharge);
  const totals: MoneyTotals = { ...ordinary.totals,
    discountTotal: cents(ordinary.totals.discountTotal + (ordinary.pricesIncludeTax ? grossDiscount : netDiscount), true),
    taxTotal: cents(ordinary.totals.taxTotal - (grossDiscount - netDiscount), true),
    grandTotal: cents(exactComponents ? grand : Math.max(0, grand), exactComponents) };
  return { lines, totals, unitEconomics };
}
export function currentCreditPricingHash(snapshot: Omit<OrderPricingSnapshotV2, 'quoteHash'> | OrderPricingSnapshotV2): string {
  const { quoteHash: _hash, ...facts } = snapshot as OrderPricingSnapshotV2; return digest(facts);
}
export interface CurrentShippingSourceFacts {basis: ShippingPricingBasis[]; adjustments: Record<string, number>; carriers: ShippingCarrier[]}
export interface ShippingOrderContext {orderId:string;shippingMethodCode?:string|null}
type PricingResolver = (hash: string) => CurrentOrderPricing;
function shippingCarriers(source:RetainedShipping, prior:CurrentShippingSourceFacts, lines:OrderPricingSnapshotV1['lines']):ShippingCarrier[] {
  const keys = new Set(lines.map(l=>l.key)), ids = source.lines.map(l=>l.sourceId), priorIds = prior.basis.map(b=>b.sourceId);
  const sameIds = serial(ids) === serial(priorIds);
  const activeKeys = new Set(lines.filter(l=>l.quantity > 0).map(l=>l.key));
  let cursor=-1;
  const orderedSubset = ids.every(id=>{const index=priorIds.indexOf(id);const ordered=index > cursor;cursor=index;return ordered;}) &&
    prior.carriers.filter(carrier=>!ids.includes(carrier.sourceId)).every(carrier=>carrier.lineKeys.every(key=>!activeKeys.has(key)));
  const replacement = !!source.repricedBasis && ids.length === 1 && ids[0] === (priorIds[0] ?? 'current-shipping');
  const removal = source.repricedBasis?.length === 0 && ids.length === 0;
  requireFact(sameIds || orderedSubset || replacement || removal, 'shipping carrier custody differs');
  const derived = ids.map(sourceId=>{const carrier=prior.carriers.find(c=>c.sourceId === sourceId);
    return {sourceId,methodCode:carrier?.methodCode ?? null,lineKeys:(carrier?.lineKeys ?? []).filter(key=>keys.has(key))};});
  const carriers = source.carriers ?? derived;
  requireFact(carriers.length === ids.length, 'shipping carrier closure differs');
  const members = new Set<string>();
  carriers.forEach((carrier,index)=>{
    requireFact(carrier.sourceId === ids[index] && (carrier.methodCode === null || typeof carrier.methodCode === 'string' && carrier.methodCode.length > 0) && Array.isArray(carrier.lineKeys), 'shipping carrier identity differs');
    carrier.lineKeys.forEach(key=>{requireFact(keys.has(key) && !members.has(key),'shipping carrier membership differs');members.add(key);});
    const expected=derived[index]!;
    const allCurrent = replacement && carriers.length === 1 && serial([...carrier.lineKeys].sort()) === serial([...keys].sort());
    requireFact(allCurrent || serial([...carrier.lineKeys].sort()) === serial([...expected.lineKeys].sort()), 'shipping carrier membership transferred');
    // Old scalar V1 has no captured method identity; its first source vector
    // records the caller's locked-order method while preserving exact money.
    requireFact(source.repricedBasis || expected.methodCode === null || carrier.methodCode === expected.methodCode, 'shipping carrier method changed without recalculation');
  });
  return carriers;
}
function currentShippingFacts(ordinary:OrderPricingSnapshotV1, prior:CurrentShippingSourceFacts):CurrentShippingSourceFacts {
  const source=ordinary.retainedShipping!;
  const carriers=shippingCarriers(source,prior,ordinary.lines), ids=new Set(source.lines.map(l=>l.sourceId));
  const basis=source.repricedBasis ?? prior.basis.filter(b=>ids.has(b.sourceId));
  const waived=ordinary.applied.some(a=>a.shippingAdjustment !== undefined);
  const adjustments=Object.fromEntries(basis.map(b=>[b.sourceId,source.mode === 'revalidate-promotions' ? waived ? -b.amount : 0 : prior.adjustments[b.sourceId] ?? 0]));
  return {basis,adjustments,carriers};
}
function directMoneyClosure(saved: unknown, snapshot: OrderPricingSnapshotV1, before = false): void {
  requireFact(object(saved) && object(saved.totals) && Array.isArray(saved.lines), 'direct shipping saved financial closure absent');
  for (const key of ['subtotal','discountTotal','shippingTotal','taxTotal','grandTotal'] as const)
    requireFact(saved.totals[key] === snapshot.totals[key], 'direct shipping saved totals differ');
  requireFact(saved.lines.length === snapshot.lines.length, 'direct shipping saved line closure differs');
  const seen = new Set<string>();
  for (const line of saved.lines) {
    requireFact(object(line) && typeof line.id === 'string' && !seen.has(line.id), 'direct shipping saved line identity'); seen.add(line.id);
    const captured = snapshot.lines.find(l=>l.orderLineId === line.id);
    requireFact(captured && line.quantity === captured.quantity, 'direct shipping saved line money differs');
    if (!before || line.lineTotal === captured.lineGross) requireFact(line.lineTotal === captured.lineGross, 'direct shipping saved line money differs');
    else {
      requireFact(Array.isArray(saved.financialLines) && saved.financialLines.length === snapshot.lines.length, 'direct shipping historical financial proof absent');
      const financial = saved.financialLines.filter(item=>object(item) && item.id === line.id);
      requireFact(financial.length === 1 && object(financial[0]), 'direct shipping historical financial identity');
      const actual = financial[0], oldTotal = captured.priceIncludesTax ? captured.lineGross : captured.lineNet;
      requireFact(actual.quantity === captured.quantity && actual.unitPrice === captured.unitListPrice &&
        actual.lineSubtotal === captured.unitListPrice*captured.quantity && actual.lineDiscount === captured.unitListPrice*captured.quantity-oldTotal &&
        actual.lineTax === 0 && actual.lineTotal === oldTotal && line.lineTotal === actual.lineTotal, 'direct shipping historical checkout projection differs');
    }
  }
}
function directImportedShipping(before: Record<string,unknown>, orderId: string): {facts:CurrentShippingSourceFacts;digest:string;final:Array<{sourceId:string;net:number;gross:number}>} {
  const descriptor = before.importedPricingBasis;
  requireFact(isImportedPricingBasis(descriptor) && descriptor.orderId === orderId &&
    typeof descriptor.storeId === 'string' && typeof descriptor.currency === 'string' && typeof descriptor.sourceKey === 'string' &&
    typeof descriptor.sourceOrderId === 'string' && object(before.storedOrder) && Array.isArray(before.financialLines), 'direct imported shipping anchor absent');
  const order = before.storedOrder;
  requireFact(order.id === orderId && order.storeId === descriptor.storeId && order.currency === descriptor.currency && object(before.totals), 'direct imported shipping order differs');
  for (const key of ['subtotal','discountTotal','shippingTotal','taxTotal','grandTotal']) requireFact(before.totals[key] === order[key], 'direct imported shipping captured totals differ');
  const lines = before.financialLines.map(line=>{
    requireFact(object(line) && typeof line.id === 'string' && typeof line.orderId === 'string' && typeof line.storeId === 'string' &&
      typeof line.quantity === 'number' && typeof line.unitPrice === 'number' && typeof line.lineSubtotal === 'number' &&
      typeof line.lineDiscount === 'number' && typeof line.lineTax === 'number' && typeof line.lineTotal === 'number', 'direct imported financial line');
    return {id:line.id,orderId:line.orderId,storeId:line.storeId,quantity:line.quantity,unitPrice:line.unitPrice,
      lineSubtotal:line.lineSubtotal,lineDiscount:line.lineDiscount,lineTax:line.lineTax,lineTotal:line.lineTotal,metadata:line.metadata};
  });
  requireFact(Array.isArray(before.lines) && before.lines.length === lines.length, 'direct imported display line closure');
  const seen = new Set<string>();
  for (const line of before.lines) {
    requireFact(object(line) && typeof line.id === 'string' && !seen.has(line.id), 'direct imported display line identity'); seen.add(line.id);
    const actual = lines.find(l=>l.id === line.id);
    requireFact(actual && actual.quantity === line.quantity && actual.lineTotal === line.lineTotal, 'direct imported captured line differs');
  }
  const raw = readImportedOrderEditBasis(importedOrderEditMetadata({ sourceOrderId: descriptor.sourceOrderId, sourceKey: descriptor.sourceKey, editBasisV1: descriptor.editBasisV1 }),
    {storeId:descriptor.storeId,orderId,currency:descriptor.currency,orderLines:lines});
  return {digest:raw.sourceDigest,final:raw.shippingLines.map(l=>({sourceId:l.sourceId,net:l.net,gross:l.gross})),
    facts:{basis:raw.shippingLines.map(l=>({sourceId:l.sourceId,amount:l.listPrice,includesTax:l.listPriceIncludesTax,taxRateBps:l.taxRateBps})),
      adjustments:Object.fromEntries(raw.shippingLines.map(l=>[l.sourceId,sum(l.adjustments)])),
      carriers:raw.shippingLines.map(l=>({sourceId:l.sourceId,methodCode:l.methodCode,lineKeys:l.orderLineIds}))}};
}
function shippingSourceFacts(predecessor: CurrentOrderPricing, evidence: CreditPricingEvidence | undefined, sources: readonly CreditPricingSource[] = [], seen = new Set<string>(), resolve?: PricingResolver, orderContext?:ShippingOrderContext): CurrentShippingSourceFacts {
  const hash = creditPricingSnapshotDigest(predecessor.snapshot);
  requireFact(!seen.has(hash), 'shipping predecessor cycle'); seen.add(hash);
  if (isImportedCreditOrigin(predecessor.snapshot)) {
    const origin = predecessor.snapshot;
    const raw = readImportedOrderEditBasis(importedOrderEditMetadata(origin),
      { storeId: origin.storeId, orderId: origin.orderId, currency: origin.capture.currency, orderLines: origin.capture.lines, couponCodes: origin.capture.couponCodes });
    return { basis: raw.shippingLines.map(l=>({sourceId:l.sourceId,amount:l.listPrice,includesTax:l.listPriceIncludesTax,taxRateBps:l.taxRateBps})),
      adjustments: Object.fromEntries(raw.shippingLines.map(l=>[l.sourceId,sum(l.adjustments)])),
      carriers:raw.shippingLines.map(l=>({sourceId:l.sourceId,methodCode:l.methodCode,lineKeys:l.orderLineIds.map(id=>predecessor.lines.find(line=>line.orderLineId === id)?.key).filter((key):key is string=>key !== undefined)})) };
  }
  const snapshot = predecessor.snapshot, ordinary = snapshot.version === 2 ? snapshot.ordinary : snapshot;
  if (!ordinary.retainedShipping) {
    return { basis: [{sourceId:'current-shipping',amount:ordinary.shippingBasis.amount,includesTax:ordinary.shippingBasis.includesTax,taxRateBps:ordinary.shippingBasis.taxRateBps}],
      adjustments: {'current-shipping':ordinary.totals.shippingTotal-ordinary.shippingBasis.amount},
      carriers:[{sourceId:'current-shipping',methodCode:orderContext?.shippingMethodCode ?? null,lineKeys:ordinary.lines.map(l=>l.key)}] };
  }
  if (snapshot.version === 1) {
    const orderId = orderContext?.orderId ?? evidence?.redemption.orderId;
    requireFact(orderId && seen.size <= new Set(sources.map(row=>row.id)).size, 'direct shipping durable ancestry exhausted');
    const candidates = sources.filter(row=>row.orderId === orderId && object(row.after) && row.after.currentPricingDigest === hash &&
      creditPricingSnapshotDigest(row.after.currentPricing) === hash);
    requireFact(candidates.length === 1, 'direct shipping durable source ambiguous or absent');
    const row = candidates[0]!;
    requireFact(object(row.before) && object(row.after), 'direct shipping durable row shape');
    const actual = strict(row.after.currentPricing as OrderPricingSnapshotV1);
    requireFact(serial(actual) === serial(snapshot), 'direct shipping actual snapshot differs'); directMoneyClosure(row.after,actual);
    const retained = ordinary.retainedShipping;
    let facts:CurrentShippingSourceFacts, priorFinal:Array<{sourceId:string;net:number;gross:number}>;
    if (row.before.currentPricing != null) {
      requireFact(object(row.before.currentPricing) && row.before.currentPricing.version === 1 && !isImportedCreditOrigin(row.before.currentPricing), 'direct shipping predecessor must be native V1');
      const prior = strict(row.before.currentPricing as unknown as OrderPricingSnapshotV1);
      directMoneyClosure(row.before,prior,true);
      requireFact(retained.sourceDigest === creditPricingSnapshotDigest(prior), 'direct shipping predecessor digest differs');
      const savedShipping = object(row.before.shipping) ? row.before.shipping : {};
      facts = shippingSourceFacts(v1View(prior,evidence),evidence,sources,seen,resolve,{orderId,
        shippingMethodCode:typeof savedShipping.methodCode === 'string' ? savedShipping.methodCode : null});
      priorFinal = prior.retainedShippingFinal ?? shippingPairs(facts.basis,facts.adjustments);
    } else {
      const raw = directImportedShipping(row.before,orderId);
      requireFact(retained.sourceDigest === raw.digest, 'direct imported shipping digest differs'); facts=raw.facts;priorFinal=raw.final;
    }
    shippingCarriers(retained,facts,ordinary.lines);
    const expected = retained.mode === 'keep' ? priorFinal : retained.mode === 'revalidate-promotions' ? shippingPairs(retained.repricedBasis ?? facts.basis) :
      shippingPairs(retained.repricedBasis!,facts.adjustments);
    requireFact(serial(expected.filter(line=>retained.lines.some(current=>current.sourceId === line.sourceId))) === serial(retained.lines), 'direct shipping source pairs differ');
    return currentShippingFacts(ordinary,facts);
  }
  requireFact(evidence, 'shipping durable credit evidence absent');
  requireFact(snapshot.version === 2 && seen.size <= new Set(sources.map(row=>row.id)).size, 'shipping durable ancestry exhausted');
  // Reuse current-pricing's canonical row/receipt resolver before following its
  // exact durable predecessor. A standalone self-hashed source never qualifies.
  if (resolve) resolve(hash);
  else readCurrentOrderPricingSnapshot(snapshot, { currency: predecessor.currency, orderLines: predecessor.lines.map(l=>({id:l.orderLineId,quantity:l.quantity})),
    mode: 'settlement', creditEvidence: evidence, pricingSources: sources });
  const row = sources.find(row=>row.id === snapshot.lineage.editId && row.orderId === evidence.redemption.orderId);
  requireFact(row && object(row.before) && creditPricingSnapshotDigest(row.before.currentPricing) === snapshot.lineage.predecessorSnapshotDigest, 'shipping durable predecessor differs');
  const raw = row.before.currentPricing;
  const sourceLines = isImportedCreditOrigin(raw) ? raw.capture.lines.map(l=>({id:l.id,quantity:l.quantity})) :
    object(raw) && Array.isArray(raw.lines) ? raw.lines.map((l: unknown)=>{ requireFact(object(l) && typeof l.orderLineId === 'string' && typeof l.quantity === 'number', 'shipping predecessor line');
      return {id:l.orderLineId,quantity:l.quantity}; }) : [];
  const prior = resolve ? resolve(snapshot.lineage.predecessorSnapshotDigest) : readCurrentOrderPricingSnapshot(raw, { currency: predecessor.currency, orderLines: sourceLines, mode: 'settlement', creditEvidence: evidence, pricingSources: sources });
  requireFact(prior, 'shipping predecessor absent');
  let facts = shippingSourceFacts(prior, evidence, sources, seen, resolve);
  const retained = ordinary.retainedShipping;
  if (retained.mode === 'revalidate-promotions') {
    const origin = snapshot.version === 2 && isImportedCreditOrigin(snapshot.origin) ? snapshot.origin : null;
    if (origin && object(origin.editBasisV1) && retained.sourceDigest === origin.editBasisV1.sourceDigest) {
      facts = shippingSourceFacts(importedView(origin,evidence),evidence,sources,undefined,resolve);
    }
  }
  return currentShippingFacts(ordinary,facts);
}
/** Caller supplies a normalized predecessor; V2 ancestry is revalidated once & cached. */
export function currentShippingSourceFacts(predecessor: CurrentOrderPricing, evidence?: CreditPricingEvidence, sources: readonly CreditPricingSource[] = [], orderContext?:ShippingOrderContext): CurrentShippingSourceFacts {
  const cache = new Map<string,CurrentOrderPricing>();
  if (predecessor.snapshot.version === 2) {
    requireFact(evidence, 'shipping durable credit evidence absent');
    readCurrentPricingGraph(predecessor.snapshot, {currency:predecessor.currency,orderLines:predecessor.lines.map(l=>({id:l.orderLineId,quantity:l.quantity})),
      mode:'settlement',creditEvidence:evidence,pricingSources:sources},(hash,view)=>cache.set(hash,view));
  }
  return structuredClone(shippingSourceFacts(predecessor,evidence,sources,undefined,cache.size ? hash=>{const view=cache.get(hash);requireFact(view,'shipping source outside validated graph');return view;} : undefined,orderContext));
}
const shippingPairs = (basis: readonly ShippingPricingBasis[], adjustments: Record<string,number> = {}) => basis.map(b=>{
  const amount=b.amount+(adjustments[b.sourceId] ?? 0),factor=1+b.taxRateBps/10000;
  return {sourceId:b.sourceId,net:Math.round(b.includesTax ? amount/factor : amount),gross:Math.round(b.includesTax ? amount : amount*factor)};
});
function validateSourceComponents(ordinary: OrderPricingSnapshotV1, origin: CreditPricingOrigin, predecessor: CurrentOrderPricing, evidence: CreditPricingEvidence, sources?: readonly CreditPricingSource[], resolve?: PricingResolver) {
  const imported = isImportedCreditOrigin(origin) ? readImportedOrderEditBasis(importedOrderEditMetadata(origin),
    { storeId: origin.storeId, orderId: origin.orderId, currency: origin.capture.currency, orderLines: origin.capture.lines, couponCodes: origin.capture.couponCodes }) : null;
  const previous = predecessor.snapshot.version === 2 ? predecessor.snapshot.ordinary : isImportedCreditOrigin(predecessor.snapshot) ? null : predecessor.snapshot;
  const source = ordinary.retainedShipping;
  if (source) {
    let expected: typeof source.lines;
    let facts = resolve ? shippingSourceFacts(predecessor,evidence,sources,undefined,resolve) : currentShippingSourceFacts(predecessor,evidence,sources);
    if (source.sourceDigest === creditPricingSnapshotDigest(predecessor.snapshot)) {
      if (source.repricedBasis) {
        expected = shippingPairs(source.repricedBasis,source.mode === 'revalidate-promotions' ? {} : facts.adjustments);
      }
      else if (source.mode === 'revalidate-promotions') expected = shippingPairs(facts.basis);
      else if (!previous) { requireFact(imported, 'predecessor shipping source absent'); expected = imported.shippingLines.map(l=>({sourceId:l.sourceId,net:l.net,gross:l.gross})); }
      else if (previous.retainedShipping) expected = previous.retainedShippingFinal!;
      else {
        const amount = source.mode === 'keep' ? previous.totals.shippingTotal : previous.shippingBasis.amount;
        const factor = 1 + previous.shippingBasis.taxRateBps / 10000;
        expected = [{ sourceId: 'current-shipping', net: previous.shippingBasis.includesTax ? Math.round(amount / factor) : amount,
          gross: previous.shippingBasis.includesTax ? amount : Math.round(amount * factor) }];
      }
    } else {
      requireFact(source.mode !== 'recalculate-keep-promotions', 'shipping repricing requires immediate predecessor proof');
      requireFact(imported && source.sourceDigest === imported.sourceDigest, 'shipping raw source binding');
      facts = {basis:imported.shippingLines.map(l=>({sourceId:l.sourceId,amount:l.listPrice,includesTax:l.listPriceIncludesTax,taxRateBps:l.taxRateBps})),
        adjustments:Object.fromEntries(imported.shippingLines.map(l=>[l.sourceId,sum(l.adjustments)])),
        carriers:imported.shippingLines.map(l=>({sourceId:l.sourceId,methodCode:l.methodCode,lineKeys:l.orderLineIds.map(id=>predecessor.lines.find(line=>line.orderLineId === id)?.key).filter((key):key is string=>key !== undefined)}))};
      expected = source.repricedBasis ? shippingPairs(source.repricedBasis) : imported.shippingLines.map(l => {
        const factor = 1 + l.taxRateBps / 10000;
        return { sourceId: l.sourceId, net: source.mode === 'keep' ? l.net : Math.round(l.listPriceIncludesTax ? l.listPrice / factor : l.listPrice),
          gross: source.mode === 'keep' ? l.gross : Math.round(l.listPriceIncludesTax ? l.listPrice : l.listPrice * factor) };
      });
    }
    shippingCarriers(source,facts,ordinary.lines);
    requireFact(serial(source.lines) === serial(expected.filter(line=>source.lines.some(current=>current.sourceId === line.sourceId))), 'shipping source pairs differ');
  }
  for (const adjustment of ordinary.adjustments) if (adjustment.sourceSurcharge) {
    const charge = adjustment.sourceSurcharge, original = imported?.surcharges.find(c=>c.sourceId === charge.sourceId);
    requireFact(imported && charge.sourceDigest === imported.sourceDigest && original && charge.net === original.net && charge.gross === original.gross, 'surcharge raw source binding');
  }
}
/** predecessor must be produced by the normalized reader with complete durable evidence. */
export function buildCurrentCreditPricingSnapshot(input: BuildCurrentCreditPricingInput): OrderPricingSnapshotV2 {
  return buildPricing(input, false);
}
function buildPricing(input: BuildCurrentCreditPricingInput, reading: boolean, resolve?: PricingResolver): OrderPricingSnapshotV2 {
  const e = input.evidence, origin = isImportedCreditOrigin(input.origin) ? structuredClone(input.origin) : strict(input.origin);
  const original = decodeCreditPricingOrigin(origin, e), ordinary = strict(input.ordinary), state = funding(e);
  requireFact(e.refundsComplete === true && Array.isArray(e.refunds), 'complete refund lineage evidence required');
  requireFact(!ordinary.selectedCredit && !ordinary.applied.some(a => a.kind === 'account_credit'), 'placement credit & ordinary pricing required');
  requireFact(original.currency === ordinary.currency &&
    original.selectedCredit.accountId === e.redemption.accountCreditId && original.selectedCredit.appliedAmount === e.redemption.amount &&
    serial(original.selectedCredit.allocation) === serial(e.redemption.operationalAllocation), 'immutable origin redemption differs');
  requireFact(Array.isArray(input.couponCodes) && input.couponCodes.every(c => typeof c === 'string' && c.length > 0 && c.length <= 255) &&
    new Set(input.couponCodes.map(c => c.toLowerCase())).size === input.couponCodes.length, 'coupon membership');
  requireFact(ordinary.couponCodes.every(code => input.couponCodes.some(c => c.toLowerCase() === code.toLowerCase())), 'ordinary coupon membership');
  const predecessor = input.predecessor ?? (isImportedCreditOrigin(origin) ? importedView(origin, e) : v1View(origin, e));
  verifyPredecessor(predecessor, e);
  requireFact(serial(predecessor.snapshot.version === 1 ? predecessor.snapshot : predecessor.snapshot.origin) === serial(origin), 'predecessor immutable origin differs');
  validateSourceComponents(ordinary, origin, predecessor, e, input.pricingSources, resolve);
  const sourceCustody = input.sourceCustody ?? predecessor.sourceCustody;
  requireFact(serial(sourceCustody) === serial(predecessor.sourceCustody), 'initial detached source custody changed');
  requireFact(!sourceCustody || isImportedCreditOrigin(origin) && sourceCustody.version === 1 && sourceCustody.originDigest === origin.captureDigest, 'source custody origin');
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
  for (const [line, units] of Object.entries(sourceCustody?.detached ?? {})) for (const unit of units) {
    const prior = previous.get(unit.unitId);
    requireFact(!seenIds.has(unit.unitId) && prior?.line === line && prior.index === unit.originalIndex, 'detached source identity transferred');
    seenIds.add(unit.unitId);
  }
  const consumed = new Set(input.lineage.consumedUnitIds);
  for (const id of consumed) requireFact(previous.has(id) && seenIds.has(id), 'consumed predecessor unit removed');
  if (predecessor.snapshot.version === 2) for (const id of predecessor.snapshot.lineage.consumedUnitIds) {
    requireFact(consumed.has(id), 'prior frozen unit lost consumed custody');
  }
  if (!reading) {
    let evidenced = new Set(predecessor.consumedSourceUnitIds);
    if (!input.predecessor) evidenced = consumedIds(predecessor, e, hash => {
      requireFact(hash === creditPricingSnapshotDigest(origin), 'initial refund source is not immutable origin'); return predecessor;
    });
    requireFact(serial([...consumed].sort()) === serial([...evidenced].sort()), 'current consumed lineage differs');
  }
  for (const [id, unit] of previous) if (seenIds.has(id) && unit.index !== null && state.returnedIndexes[unit.line]?.includes(unit.index)) {
    requireFact(consumed.has(id), 'returned original unit requires frozen custody');
  }
  const allocation = allocationFor(ordinary, input.originalUnitIndexes, state, sourceCustody), basis = original.pricesIncludeTax ? 'gross' : 'net';
  for (const l of ordinary.lines) input.unitIds[l.orderLineId]!.forEach((id, p) => requireFact(!consumed.has(id) || allocation[l.orderLineId]![p] === 0, 'consumed unit retains live credit'));
  const predecessorUnitMapDigest = digest({ unitIds: predecessor.unitIds, originalUnitIndexes: predecessor.originalUnitIndexes, unitEconomics: predecessor.unitEconomics,
    ...(sourceCustody ? { sourceCustody: predecessor.sourceCustody, sourceRefundUnits: predecessor.sourceRefundUnits } : {}) });
  if (input.lineage.predecessorUnitMapDigest !== undefined) requireFact(input.lineage.predecessorUnitMapDigest === predecessorUnitMapDigest, 'predecessor unit map digest');
  const result: OrderPricingSnapshotV2 = { version: 2, pricingProfile: 'retained-credit-edit-v1', currency: ordinary.currency,
    pricesIncludeTax: ordinary.pricesIncludeTax, couponCodes: [...input.couponCodes], quoteHash: '', origin, ordinary,
    ordinaryUnitFacts: structuredClone(input.ordinaryUnitFacts),
    credit: { redemptionId: e.redemption.id, orderId: e.redemption.orderId!, accountId: e.redemption.accountCreditId,
      promotionId: original.selectedCredit.promotionId, basis, originDigest: digest(e.redemption.operationalAllocation),
      atPricingRestoreIds: e.history.map(h => h.id).sort(), atPricingRestoreDigest: historyDigest(e.history), allocation,
      ...(sourceCustody ? { sourceCustodyAllocation: detachedAllocation(sourceCustody, state) } : {}) },
    originalUnitIndexes: structuredClone(input.originalUnitIndexes), unitIds: structuredClone(input.unitIds),
    lineage: { ...structuredClone(input.lineage), consumedUnitIds: [...consumed].sort(), predecessorUnitMapDigest },
    ...(sourceCustody ? { sourceCustody: structuredClone(sourceCustody) } : {}),
    ...finalFacts(ordinary, allocation, basis, input.ordinaryUnitFacts, input.unitIds, consumed, predecessor) };
  result.quoteHash = currentCreditPricingHash(result); return result;
}

/** V1 stays strict; V2 sources require activated durable edit-row custody. */
export function readCurrentOrderPricingSnapshot(raw: unknown, context: CurrentPricingContext): CurrentOrderPricing | null {
  return readCurrentPricingGraph(raw,context);
}
function readCurrentPricingGraph(raw: unknown, context: CurrentPricingContext, onResolved?: (hash:string,view:CurrentOrderPricing)=>void): CurrentOrderPricing | null {
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
    if (isImportedCreditOrigin(source)) {
      const e = context.creditEvidence; requireFact(e?.importedSource, 'actual imported credit source evidence required');
      const captured = source.capture;
      const adoption = e.importedOrigin && serial(e.importedOrigin) === serial(source);
      const anchored = [...rows.values()].some(row => {
        if (!object(row.before) || creditPricingSnapshotDigest(row.before.currentPricing) !== hash || !object(row.before.storedOrder) || !Array.isArray(row.before.financialLines)) return false;
        const order = row.before.storedOrder;
        const metadata = object(order.metadata) ? order.metadata : {};
        const loyalty = object(metadata.loyalty) ? metadata.loyalty : {};
        const points = loyalty.pointsDiscount ?? 0;
        if (!Number.isSafeInteger(points) || typeof points !== 'number' || points < 0) return false;
        const totals = Object.fromEntries(Object.keys(captured.totals).map(key => [key, key === 'pointsDiscount' ? points : order[key]]));
        const financialLines = row.before.financialLines.map(line => { requireFact(object(line), 'first imported financial line');
          return Object.fromEntries(['id', 'orderId', 'storeId', 'quantity', 'unitPrice', 'lineSubtotal', 'lineDiscount', 'lineTax', 'lineTotal', 'metadata'].map(key => [key, line[key]])); });
        return row.orderId === source.orderId && order.id === source.orderId && order.storeId === source.storeId &&
          serial(totals) === serial(captured.totals) && serial(financialLines.sort((a, b) => String(a.id).localeCompare(String(b.id)))) ===
          serial([...captured.lines].sort((a, b) => a.id.localeCompare(b.id)));
      });
      requireFact(adoption || anchored, 'imported capture lacks first durable financial anchor');
      view = importedView(source, e);
    }
    else if (v.version !== 2) view = v1View(strict(source as OrderPricingSnapshotV1), context.creditEvidence);
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
      for (const key of ['origin', 'ordinary', 'ordinaryUnitFacts', 'unitEconomics', 'lines', 'totals', 'couponCodes', 'pricesIncludeTax', 'currency', 'sourceCustody'] as const) {
        requireFact(serial(proposed[key]) === serial(v[key]), `proposal ${key} differs from activation`);
      }
      requireFact(object(proposed.credit) && serial(proposed.credit.allocation) === serial(v.credit.allocation) &&
        serial(proposed.credit.sourceCustodyAllocation) === serial(v.credit.sourceCustodyAllocation) &&
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
      const capturedSourceIds = activationProposal.predecessor.consumedSourceUnitIds;
      requireFact(Array.isArray(capturedSourceIds) && new Set(capturedSourceIds).size === capturedSourceIds.length &&
        capturedSourceIds.every(id => typeof id === 'string' && unitMap(predecessor).has(id)) &&
        serial(capturedIds.sort()) === serial(capturedSourceIds.filter(id => Object.values(predecessor.unitIds).flat().includes(id)).sort()) &&
        serial([...capturedSourceIds].sort()) === serial([...v.lineage.consumedUnitIds].sort()), 'proposal consumed boundary differs');
      const activation = v.credit.atPricingRestoreIds.map(id => { const h = byId.get(id); requireFact(h, 'activation restoration absent from complete ledger'); return h; });
      requireFact(historyDigest(activation) === v.credit.atPricingRestoreDigest, 'activation restoration digest');
      const ownRows = activation.filter(row => { if (!row.allocation) return false; const envelope = JSON.parse(row.allocation) as Record<string, unknown>;
        if (envelope.type !== 'account_credit.edit_restore' || envelope.editId !== v.lineage.editId) return false;
        requireFact(envelope.requestDigest === proposal.requestDigest, 'activation posted request digest'); return true; });
      requireFact(serial(ownRows.map(row => row.idempotencyKey).sort()) === serial([...proposal.postingKeys].sort()), 'activation posted effect closure');
      const frozen = new Set(v.lineage.consumedUnitIds);
      const activationEvidence = { ...e, history: activation, refunds: (e.refunds ?? []).filter(refund => {
        if (predecessor.admittedLegacyRefundIds.includes(refund.id)) return true;
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
        predecessor, lineage: v.lineage, evidence: activationEvidence, pricingSources: context.pricingSources, ...(v.sourceCustody ? { sourceCustody: v.sourceCustody } : {}) }, true, resolve);
      requireFact(serial(expected) === serial(v), 'saved activation facts/hash differ');
      view = v2View(v, funding(e)); visitingEdits.delete(v.lineage.editId);
    }
    visiting.delete(hash); cache.set(hash, view); onResolved?.(hash,view); return view;
  };
  const view = resolve(creditPricingSnapshotDigest(raw));
  if (isImportedCreditOrigin(view.snapshot)) {
    requireFact(view.currency === context.currency && context.orderLines.length === view.lines.length &&
      context.orderLines.every(line => view.lines.some(saved => saved.orderLineId === line.id &&
        (context.mode === 'settlement' ? line.quantity === saved.quantity : line.quantity <= saved.quantity))), 'imported current native line closure');
  }
  else if (view.snapshot.version === 1) readOrderPricingSnapshot(raw, context);
  else readOrderPricingSnapshot(view.snapshot.ordinary, { ...context, totals: undefined });
  if (context.totals) requireFact(serial(view.totals) === serial(context.totals), 'stored order totals');
  if (context.creditEvidence) {
    const consumed = consumedIds(view, context.creditEvidence, resolve);
    view.consumedPositions = positions(view, consumed); view.consumedSourceUnitIds = [...consumed].sort();
  }
  return structuredClone(view);
}
