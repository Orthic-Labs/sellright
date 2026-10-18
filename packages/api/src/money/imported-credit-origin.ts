/** Retained import proof. No historical native promotion snapshot is synthesized. */
import { migrationId } from '../import/context.js';
import { vendureProratedUnitPriceWithTax, type VendureLineSnapshotInput } from '../import/vendure-money.js';
import { readImportedOrderEditBasis, orderEditStoredFingerprint } from '../orders/order-edit-stack.js';
import { readOrderPricingSnapshot, type MoneyTotals, type OrderPricingSnapshotV1 } from './pricing-snapshot.js';
import { readCreditFundingState, originalCreditUnitId, creditReturnSnapshotDigest,
  type EditFundingRedemption, type EditFundingHistoryRow, type CreditRefundEvidence } from '../account-credit/edit-funding.js';

export interface ImportedAccountSource {
  id: string; storeId: string; promotionId: string; currency: string;
  sourceKey: string | null; sourceId: string | null; sourceRecord: string | null;
  sourcePromotionRecord: string | null; sourceDigest: string | null;
  promotion: { id: string; storeId: string; type: string };
}
export interface ImportedRedemptionSource extends EditFundingRedemption {
  storeId: string; sourceKey: string | null; sourceId: string | null; sourceRecord: string | null;
  sourceDigest: string | null; allocation: string | null; sourceOrderId: string | null;
}
export interface ImportedCreditSourceEvidence { accountSource: ImportedAccountSource; redemptionSource: ImportedRedemptionSource }
export interface ImportedNativeCreditLine {
  id: string; orderId: string; storeId: string; quantity: number; unitPrice: number;
  lineSubtotal: number; lineDiscount: number; lineTax: number; lineTotal: number; metadata: unknown;
}
export interface ImportedSourceUnit {
  unitId: string; sourceSlot: number; originalIndex: number | null; cashRefundGross: number;
  legacyRefundId?: string; consumed?: boolean;
}
export interface ImportedCreditOriginV1 {
  kind: 'vendure-retained-credit-v1'; version: 1; storeId: string; orderId: string;
  sourceKey: string; sourceOrderId: string; editBasisV1: unknown;
  accountSource: ImportedAccountSource; redemptionSource: ImportedRedemptionSource;
  capture: { currency: string; pricesIncludeTax: boolean; couponCodes: string[]; totals: MoneyTotals;
    lines: ImportedNativeCreditLine[]; restoreIds: string[]; restoreDigest: string;
    legacyRefunds: CreditRefundEvidence[]; refundDigest: string; currentUnitIds: Record<string, string[]>;
    sourceUnits: Record<string, ImportedSourceUnit[]> };
  captureDigest: string;
}
export type CreditPricingOrigin = OrderPricingSnapshotV1 | ImportedCreditOriginV1;
export interface ImportedOriginEvidence {
  redemption: EditFundingRedemption; history: readonly EditFundingHistoryRow[]; historyComplete: true;
  refunds?: readonly CreditRefundEvidence[]; refundsComplete?: true; importedSource?: ImportedCreditSourceEvidence;
}
export interface BuildImportedCreditOriginInput extends ImportedCreditSourceEvidence {
  storeId: string; orderId: string; currency: string; metadata: unknown; couponCodes: string[];
  totals: MoneyTotals; lines: ImportedNativeCreditLine[]; evidence: ImportedOriginEvidence;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function fact(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`Invalid imported credit origin: ${message}`); }
function integer(v: unknown, signed = false): number {
  const n = typeof v === 'string' && /^-?[0-9]+$/.test(v) ? Number(v) : v;
  fact(typeof n === 'number' && Number.isSafeInteger(n) && n >= (signed ? -2147483647 : 0) && n <= 2147483647, 'integer cents'); return n;
}
function raw(text: unknown): Record<string, unknown> {
  fact(typeof text === 'string' && text.length > 0, 'retained raw record absent'); const parsed: unknown = JSON.parse(text);
  fact(object(parsed), 'retained raw record shape'); return parsed;
}
function sid(value: unknown): string {
  fact(typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0, 'source identity'); return String(value);
}
const equal = (a: unknown, b: unknown) => creditReturnSnapshotDigest(a) === creditReturnSnapshotDigest(b);
const retainedDigest = (v: unknown) => orderEditStoredFingerprint(v);
export function importedCreditRestoreDigest(history: readonly EditFundingHistoryRow[]): string {
  return creditReturnSnapshotDigest([...history].sort((a, b) => a.id.localeCompare(b.id)).map(row => ({ id: row.id,
    idempotencyKey: row.idempotencyKey, orderId: row.orderId, accountCreditId: row.accountCreditId, relatedTransactionId: row.relatedTransactionId,
    orderLineId: row.orderLineId, refundId: row.refundId ?? null, kind: row.kind, status: row.status, quantity: row.quantity,
    amount: row.amount, delta: row.delta, allocation: row.allocation, operationalAllocation: row.operationalAllocation })));
}
export const isImportedCreditOrigin = (v: unknown): v is ImportedCreditOriginV1 => object(v) && v.kind === 'vendure-retained-credit-v1';
export function importedCreditOriginLineFacts(origin: ImportedCreditOriginV1) {
  return readImportedOrderEditBasis({ vendure: { id: origin.sourceOrderId, sourceKey: origin.sourceKey, editBasisV1: origin.editBasisV1 } },
    { storeId: origin.storeId, orderId: origin.orderId, currency: origin.capture.currency, orderLines: origin.capture.lines, couponCodes: origin.capture.couponCodes }).lines;
}
/** Exact ordinary source facts exclude only the immutable REDEEM-linked action. */
export function importedCreditOriginOrdinaryUnitFacts(origin: ImportedCreditOriginV1) {
  const basis = origin.editBasisV1; fact(object(basis) && Array.isArray(basis.lines), 'ordinary source basis');
  const promotion = raw(origin.accountSource.sourcePromotionRecord), sourcePromotionId = sid(promotion.id);
  return Object.fromEntries(basis.lines.map(entry => {
    fact(object(entry) && typeof entry.orderLineId === 'string', 'ordinary source line');
    const record = raw(entry.sourceRecord);
    fact(Array.isArray(record.adjustments) && Array.isArray(record.taxLines), 'ordinary source adjustments');
    let matched = 0;
    const adjustments = record.adjustments.filter((adjustment: unknown) => {
      fact(object(adjustment), 'ordinary source adjustment');
      if (adjustment.adjustmentSource !== `PROMOTION:${sourcePromotionId}`) return true;
      const amount = integer(adjustment.amount, true); fact(amount <= 0, 'source credit adjustment sign');
      if (adjustment.data !== undefined) {
        fact(object(adjustment.data), 'source credit data');
        if (adjustment.data.itemDistribution !== undefined) {
          const distribution = adjustment.data.itemDistribution;
          fact(Array.isArray(distribution) && distribution.every(n=>typeof n === 'number' && integer(n,true) <= 0) &&
            distribution.reduce((n,v)=>n+v,0) === amount, 'source credit distribution proof');
        }
      }
      matched++; return false;
    });
    fact(matched <= 1, 'source credit adjustment closure');
    const quantity = integer(record.quantity), placed = record.orderPlacedQuantity == null ? quantity : integer(record.orderPlacedQuantity);
    const sourceAdjustmentTotal = adjustments.reduce((n: number, adjustment: unknown) => { fact(object(adjustment), 'source ordinary adjustment'); return n + integer(adjustment.amount, true); }, 0);
    const divisor = Math.max(quantity, placed), list = integer(record.listPrice) + (quantity ? sourceAdjustmentTotal / divisor : 0);
    const rate = record.taxLines.reduce((n: number, tax: unknown) => { fact(object(tax) && (typeof tax.taxRate === 'number' || typeof tax.taxRate === 'string'), 'source ordinary tax');
      const value = Number(tax.taxRate); fact(Number.isFinite(value) && value >= 0, 'source ordinary tax'); return n + value; }, 0);
    const factor = 1 + rate / 100; fact(list >= 0 && factor > 0 && typeof record.listPriceIncludesTax === 'boolean', 'source ordinary unit');
    return [entry.orderLineId, { net: record.listPriceIncludesTax ? list / factor : list, gross: record.listPriceIncludesTax ? list : list * factor,
      sourceAdjustmentTotal, sourceAdjustmentDivisor: divisor }];
  }));
}
/** Operational retries do not change historical source admission. */
export function importedLegacyRefundProjection(refund: CreditRefundEvidence): CreditRefundEvidence {
  const metadata = object(refund.metadata) ? refund.metadata : {};
  const immutableMetadata = Object.fromEntries(Object.entries(metadata).filter(([key]) => ['vendureId', 'sourceKey', 'sourceId', 'sourceMetadata', 'vendure', 'allocation', 'creditUnitReturns'].includes(key)));
  return { id: refund.id, state: refund.state, amount: refund.amount, metadata: immutableMetadata,
    lines: [...refund.lines].map(l => ({ id: l.id, orderLineId: l.orderLineId, quantity: l.quantity, amount: l.amount })).sort((a,b)=>String(a.id).localeCompare(String(b.id))) };
}
export function importedLegacyRefundMatches(captured: CreditRefundEvidence, actual: CreditRefundEvidence): boolean {
  const state = captured.state === actual.state || (['Pending', 'Created'].includes(captured.state) && ['Pending', 'Created', 'Settled', 'Failed'].includes(actual.state));
  return state && equal({ ...importedLegacyRefundProjection(captured), state: undefined }, { ...importedLegacyRefundProjection(actual), state: undefined });
}
function selected(origin: ImportedCreditOriginV1) {
  return { accountId: origin.accountSource.id, promotionId: origin.accountSource.promotionId,
    appliedAmount: origin.redemptionSource.amount, allocation: structuredClone(origin.redemptionSource.operationalAllocation!) };
}
const redemptionProjection = (r: EditFundingRedemption) => ({ id: r.id, orderId: r.orderId, accountCreditId: r.accountCreditId,
  kind: r.kind, status: r.status, amount: r.amount, delta: r.delta, operationalAllocation: r.operationalAllocation });
const sourceProjection = (r: ImportedRedemptionSource): ImportedRedemptionSource => ({ ...redemptionProjection(r), storeId: r.storeId,
  sourceKey: r.sourceKey, sourceId: r.sourceId, sourceRecord: r.sourceRecord, sourceDigest: r.sourceDigest, allocation: r.allocation, sourceOrderId: r.sourceOrderId });
function validateSources(origin: ImportedCreditOriginV1, actual?: ImportedCreditSourceEvidence) {
  const a = origin.accountSource, r = origin.redemptionSource, account = raw(a.sourceRecord), promotion = raw(a.sourcePromotionRecord), redeem = raw(r.sourceRecord);
  const mapped = (entity: string, id: unknown) => migrationId(origin.storeId, origin.sourceKey, entity, sid(id));
  fact(a.storeId === origin.storeId && r.storeId === origin.storeId && a.sourceKey === origin.sourceKey && r.sourceKey === origin.sourceKey &&
    a.id === mapped('account-credit', a.sourceId) && a.id === mapped('account-credit', account.id) &&
    a.promotionId === mapped('promotion', account.promotionId) && a.promotionId === mapped('promotion', promotion.id) &&
    a.promotion.id === a.promotionId && a.promotion.storeId === origin.storeId && a.promotion.type === 'account_credit' &&
    a.currency === account.currencyCode && a.currency === origin.capture.currency, 'account/promotion native mapping');
  fact(a.sourceDigest === retainedDigest({ format: 'retained-pg-jsonb-text-v1', account: a.sourceRecord, promotion: a.sourcePromotionRecord }) &&
    r.sourceDigest === retainedDigest({ format: 'retained-pg-jsonb-text-v1', transaction: r.sourceRecord }), 'retained raw digest');
  const actions = typeof promotion.actions === 'string' ? JSON.parse(promotion.actions) : promotion.actions;
  const conditions = typeof promotion.conditions === 'string' ? JSON.parse(promotion.conditions) : promotion.conditions;
  fact(Array.isArray(actions) && actions.length === 1 && object(actions[0]) && actions[0].code === 'account_credit_discount' &&
    Array.isArray(conditions) && conditions.every(c => object(c) && c.code === 'account_credit_eligible'), 'source credit promotion semantics');
  fact(r.id === mapped('account-credit-transaction', r.sourceId) && r.id === mapped('account-credit-transaction', redeem.id) &&
    r.accountCreditId === a.id && r.accountCreditId === mapped('account-credit', redeem.accountCreditId) &&
    r.orderId === origin.orderId && r.sourceOrderId === origin.sourceOrderId && sid(redeem.orderId) === origin.sourceOrderId &&
    r.kind === 'REDEEM' && r.status === 'POSTED' && redeem.kind === r.kind && redeem.status === r.status &&
    r.amount === integer(redeem.amount) && r.amount > 0 && r.delta === -r.amount && r.delta === integer(redeem.delta, true), 'immutable source redemption');
  fact(typeof r.allocation === 'string', 'original source allocation absent');
  const allocation = JSON.parse(r.allocation) as unknown;
  const rawAllocation = typeof redeem.allocation === 'string' ? JSON.parse(redeem.allocation) : redeem.allocation;
  fact(object(allocation) && equal(allocation, rawAllocation) && (typeof redeem.allocation !== 'string' || r.allocation === redeem.allocation) &&
    object(r.operationalAllocation), 'raw redemption allocation');
  const mappedAllocation = Object.fromEntries(Object.entries(allocation).map(([line, units]) => {
    fact(Array.isArray(units) && units.length > 0 && units.every(v => typeof v === 'number' && integer(v) === v), 'source allocation unit vector');
    return [mapped('order-line', line), units];
  }));
  fact(equal(mappedAllocation, r.operationalAllocation) && Object.values(r.operationalAllocation).flat().reduce((n, v) => n + v, 0) === r.amount, 'mapped full redemption allocation');
  if (actual) fact(equal(a, actual.accountSource) && equal(r, sourceProjection(actual.redemptionSource)), 'actual immutable source rows differ');
}
function sourceDomain(origin: ImportedCreditOriginV1, state: ReturnType<typeof readCreditFundingState> & { ok: true }, history: readonly EditFundingHistoryRow[]) {
  const originHistory = new Map(history.map(row => [row.id, row]));
  const basis = origin.editBasisV1; fact(object(basis) && typeof basis.sourceDigest === 'string' && Array.isArray(basis.lines), 'source basis domain');
  const currentUnitIds: Record<string, string[]> = {}, sourceUnits: Record<string, ImportedSourceUnit[]> = {};
  for (const entry of basis.lines) {
    fact(object(entry) && typeof entry.orderLineId === 'string', 'source line domain'); const record = raw(entry.sourceRecord), lineId = entry.orderLineId;
    fact(lineId === migrationId(origin.storeId, origin.sourceKey, 'order-line', sid(entry.sourceId)), 'source native line mapping');
    const q = integer(record.quantity), placed = record.orderPlacedQuantity == null ? q : integer(record.orderPlacedQuantity);
    const allocation = origin.redemptionSource.operationalAllocation![lineId] ?? [], domain = Math.max(q, placed, allocation.length);
    fact(Array.isArray(record.adjustments) && Array.isArray(record.taxLines) && typeof record.listPriceIncludesTax === 'boolean', 'source cash facts');
    const input: VendureLineSnapshotInput = { quantity: q, orderPlacedQuantity: placed, listPrice: integer(record.listPrice),
      listPriceIncludesTax: record.listPriceIncludesTax, adjustments: record.adjustments, taxLines: record.taxLines };
    const cashRefundGross = placed > 0 ? integer(vendureProratedUnitPriceWithTax(input)) : 0;
    const units: ImportedSourceUnit[] = Array.from({ length: domain }, (_, sourceSlot) => ({ sourceSlot,
      originalIndex: sourceSlot < allocation.length ? sourceSlot : null,
      unitId: sourceSlot < allocation.length ? originalCreditUnitId(origin.redemptionSource.id, lineId, sourceSlot) : `vendure:${basis.sourceDigest}:${lineId}:${sourceSlot}`,
      cashRefundGross }));
    for (const refund of origin.capture.legacyRefunds) {
      fact(typeof refund.id === 'string' && (refund as { amount?: unknown }).amount !== undefined &&
        refund.lines.every(l => typeof (l as { id?: unknown }).id === 'string'), 'historical refund native identities');
      const actual = refund.lines.filter(l => l.orderLineId === lineId); if (!actual.length) continue;
      const posted = origin.capture.restoreIds.flatMap(id => {
        const row = originHistory.get(id); return row?.refundId === refund.id && row.orderLineId === lineId ? [row] : [];
      });
      fact(refund.state === 'Settled' || posted.length === 0, 'historical refund/restore state differs');
      if (refund.state === 'Failed') continue;
      const originalQuantity = posted.reduce((n, row) => n + integer(row.quantity), 0), quantity = integer(actual.reduce((n,l)=>n+integer(l.quantity),0));
      fact(originalQuantity <= quantity && (allocation.length === 0 || originalQuantity > 0 || quantity === 0), 'historical original refund lacks restoration association');
      const nullCount = quantity - originalQuantity, available = units.filter(u => u.originalIndex === null && !u.legacyRefundId);
      fact(nullCount <= available.length, 'historical refund exceeds retained null source slots');
      for (const unit of available.slice(0, nullCount)) { unit.legacyRefundId = refund.id; unit.consumed = refund.state === 'Settled'; }
    }
    const consumed = (u: ImportedSourceUnit) => u.originalIndex !== null && state.state.returnedIndexes[lineId]!.includes(u.originalIndex);
    sourceUnits[lineId] = units;
    const isConsumed = (u: ImportedSourceUnit) => consumed(u) || u.consumed === true;
    currentUnitIds[lineId] = [...units.filter(u => !isConsumed(u)), ...units.filter(isConsumed)].slice(0, q).map(u => u.unitId);
  }
  fact(Object.keys(origin.redemptionSource.operationalAllocation!).every(id => Object.hasOwn(sourceUnits, id)), 'redemption source line outside order');
  return { currentUnitIds, sourceUnits };
}
export function buildImportedCreditOrigin(input: BuildImportedCreditOriginInput): ImportedCreditOriginV1 {
  fact(object(input.metadata) && object(input.metadata.vendure) && typeof input.metadata.vendure.sourceKey === 'string', 'order source identity');
  const source = input.metadata.vendure, sourceKey = source.sourceKey;
  fact(typeof sourceKey === 'string', 'order source key');
  const basis = readImportedOrderEditBasis(input.metadata, { storeId: input.storeId, orderId: input.orderId, currency: input.currency,
    orderLines: input.lines, couponCodes: input.couponCodes });
  fact(input.evidence.refundsComplete === true && Array.isArray(input.evidence.refunds), 'complete initial refunds required');
  const state = readCreditFundingState(input.evidence); fact(state.ok, state.ok ? '' : state.message);
  const origin: ImportedCreditOriginV1 = { kind: 'vendure-retained-credit-v1', version: 1, storeId: input.storeId, orderId: input.orderId,
    sourceKey, sourceOrderId: sid(source.id), editBasisV1: structuredClone(source.editBasisV1),
    accountSource: structuredClone(input.accountSource), redemptionSource: structuredClone(sourceProjection(input.redemptionSource)),
    capture: { currency: input.currency, pricesIncludeTax: basis.pricesIncludeTax, couponCodes: [...input.couponCodes], totals: structuredClone(input.totals),
      lines: structuredClone(input.lines), restoreIds: input.evidence.history.map(row => row.id).sort(), restoreDigest: importedCreditRestoreDigest(input.evidence.history),
      legacyRefunds: input.evidence.refunds.map(importedLegacyRefundProjection), refundDigest: creditReturnSnapshotDigest(input.evidence.refunds.map(importedLegacyRefundProjection)), currentUnitIds: {}, sourceUnits: {} }, captureDigest: '' };
  fact(origin.orderId === migrationId(input.storeId, origin.sourceKey, 'order', origin.sourceOrderId), 'native/source order mapping');
  validateSources(origin, input.evidence.importedSource ?? input);
  fact(equal(redemptionProjection(input.evidence.redemption), redemptionProjection(origin.redemptionSource)), 'actual redemption projection');
  Object.assign(origin.capture, sourceDomain(origin, state, input.evidence.history));
  origin.captureDigest = creditReturnSnapshotDigest({ ...origin, captureDigest: undefined }); return origin;
}
export function decodeCreditPricingOrigin(origin: CreditPricingOrigin, evidence?: ImportedOriginEvidence) {
  if (!isImportedCreditOrigin(origin)) {
    const snapshot = readOrderPricingSnapshot(origin, { currency: origin.currency, orderLines: origin.lines.map(l => ({ id: l.orderLineId, quantity: l.quantity })), mode: 'settlement' })!;
    fact(snapshot.selectedCredit, 'native placement credit required');
    return { currency: snapshot.currency, pricesIncludeTax: snapshot.pricesIncludeTax, selectedCredit: snapshot.selectedCredit,
      originDigest: creditReturnSnapshotDigest(snapshot.selectedCredit.allocation) };
  }
  fact(origin.version === 1 && origin.captureDigest === creditReturnSnapshotDigest({ ...origin, captureDigest: undefined }), 'capture digest');
  validateSources(origin, evidence?.importedSource);
  const c = origin.capture;
  readImportedOrderEditBasis({ vendure: { id: origin.sourceOrderId, sourceKey: origin.sourceKey, editBasisV1: origin.editBasisV1 } },
    { storeId: origin.storeId, orderId: origin.orderId, currency: c.currency, orderLines: c.lines, couponCodes: c.couponCodes });
  if (evidence) {
    const ids = new Set(c.restoreIds), prefix = evidence.history.filter(row => ids.has(row.id));
    fact(prefix.length === ids.size && importedCreditRestoreDigest(prefix) === c.restoreDigest, 'captured restore prefix');
    fact(evidence.refundsComplete === true && Array.isArray(evidence.refunds) && c.legacyRefunds.every(refund =>
      evidence.refunds!.some(actual => actual.id === refund.id && importedLegacyRefundMatches(refund, actual))) && creditReturnSnapshotDigest(c.legacyRefunds) === c.refundDigest, 'captured refund prefix');
    const state = readCreditFundingState({ ...evidence, redemption: origin.redemptionSource, history: prefix }); fact(state.ok, state.ok ? '' : state.message);
    fact(equal(sourceDomain(origin, state, prefix), { currentUnitIds: c.currentUnitIds, sourceUnits: c.sourceUnits }), 'captured source unit domain');
  }
  return { currency: c.currency, pricesIncludeTax: c.pricesIncludeTax, selectedCredit: selected(origin),
    originDigest: creditReturnSnapshotDigest(origin.redemptionSource.operationalAllocation) };
}
