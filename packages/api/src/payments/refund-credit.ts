import { readCurrentOrderPricingSnapshot, type CreditPricingEvidence } from '../money/current-credit-pricing.js';
import { readCreditFundingState, planCreditUnitReturn, readCreditUnitReturns, creditReturnSnapshotDigest, originalCreditUnitId, type CreditUnitReturnLineV2, type CreditUnitReturns, type EditFundingRedemption, type EditFundingHistoryRow } from '../account-credit/edit-funding.js';
export { readCreditUnitReturns, creditReturnSnapshotDigest, type CreditUnitReturns } from '../account-credit/edit-funding.js';
import { vendureProratedUnitPriceWithTax } from '../import/vendure-money.js';
import { MAX_CREDIT_CENTS } from '../account-credit/math.js';

export type RefundMoneyLine = { id: string; quantity: number; unitPrice: number; lineTotal: number; metadata?: unknown };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const cents = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_CREDIT_CENTS;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A validated current snapshot governs every line, including imported lines.
 * Only legacy orders without snapshots use retained source unit authority.
 * Null is the existing legacy generic refund basis, never a credit unit proof. */
export function refundUnitBases(order: { currency: string; pricingSnapshot: unknown }, lines: RefundMoneyLine[], creditEvidence?: CreditPricingEvidence, pricingSources?: Parameters<typeof readCurrentOrderPricingSnapshot>[1]['pricingSources']): Map<string, number | readonly number[] | null> {
  const snapshot = readCurrentOrderPricingSnapshot(order.pricingSnapshot ?? creditEvidence?.importedOrigin, { currency: order.currency, orderLines: lines, mode: 'refund', creditEvidence, pricingSources });
  if (snapshot && (snapshot.snapshot.version === 2 || 'kind' in snapshot.snapshot)) {
    return new Map(Object.entries(snapshot.sourceRefundUnits).map(([line, units]) => [line, units.map(unit => unit.cashRefundGross)]));
  }
  if (snapshot) return new Map(snapshot.lines.map(line => [line.orderLineId, line.proratedUnitPriceWithTax]));
  return new Map(lines.map(line => {
    const raw = object(line.metadata) ? line.metadata.vendure : undefined;
    if (raw !== undefined) {
      if (!object(raw) || !cents(raw.quantity) || !cents(raw.placedQuantity) || !cents(raw.listPrice) ||
          typeof raw.listPriceIncludesTax !== 'boolean' || !Array.isArray(raw.adjustments) || !Array.isArray(raw.taxLines) ||
          !raw.adjustments.every(a => object(a) && finite(a.amount)) || !raw.taxLines.every(t => object(t) && finite(t.taxRate) && t.taxRate >= 0)) {
        throw new Error('Imported refund unit requires complete source money facts');
      }
      const unit = raw.placedQuantity > 0 ? vendureProratedUnitPriceWithTax({ quantity: raw.quantity,
        orderPlacedQuantity: raw.placedQuantity, listPrice: raw.listPrice, listPriceIncludesTax: raw.listPriceIncludesTax,
        adjustments: raw.adjustments, taxLines: raw.taxLines }) : 0;
      if (!cents(unit)) throw new Error('Imported refund unit is outside integer cents');
      return [line.id, unit] as const;
    }
    return [line.id, null] as const;
  }));
}

export function refundLineCashAmount(line: RefundMoneyLine, quantity: number, unit: number | readonly number[] | null, creditBearing: boolean): number {
  if (unit === null && creditBearing) throw new Error('Credit merchandise requires a proven refund unit');
  // Preserve legacy non-credit orders; new native & imported orders never use this fallback.
  const amount = unit === null ? Math.round((line.quantity ? line.lineTotal / line.quantity : line.unitPrice) * quantity) : typeof unit === 'number' ? unit * quantity : unit.slice(0, quantity).reduce((n, v) => n + v, 0);
  if ((Array.isArray(unit) && unit.length < quantity) || !cents(amount)) throw new Error('Refund line amount is outside integer cents');
  return amount;
}

/** Zero cash authority uses the same complete immutable funding reader as posting. */
export function proveCreditMerchandiseReturn(redeem: EditFundingRedemption | undefined, restored: EditFundingHistoryRow[],
  selected: Array<{ orderLineId: string; quantity: number; originalIndexes?: readonly (number | null)[] }>): { redemptionId: string; accountId: string } {
  if (!redeem || selected.length === 0 || new Set(selected.map(l => l.orderLineId)).size !== selected.length) throw new Error('Posted credit redemption with selected merchandise links required');
  const evidence = { redemption: redeem, history: restored, historyComplete: true as const };
  const result = readCreditFundingState(evidence);
  if (!result.ok) throw new Error(result.message);
  for (const line of selected) {
    const indexes = line.originalIndexes ?? result.state.remaining[line.orderLineId]?.map((_, index) => index)
      .filter(index => !result.state.returnedIndexes[line.orderLineId]!.includes(index)).slice(0, line.quantity);
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || !indexes || indexes.length !== line.quantity) throw new Error('Selected merchandise lacks proven credit unit identities');
    const plan = planCreditUnitReturn({ ...evidence, orderLineId: line.orderLineId, originalIndexes: indexes,
      operation: { kind: 'manual_return', id: 'refund-proof' } });
    if (!plan.ok) throw new Error(plan.message);
  }
  return { redemptionId: redeem.id, accountId: redeem.accountCreditId };
}
const digest = creditReturnSnapshotDigest;
/** Freeze exact position sets; failed operations release them, pending/unknown &
 * settled reconciliation operations retain them. Null/new units retain positions. */
function creditRefundSelection(order: { currency: string; pricingSnapshot: unknown }, lines: RefundMoneyLine[],
  evidence: CreditPricingEvidence,
  reserved: Array<{ metadata: unknown; state?: string; restored?: boolean; lines: Array<{ orderLineId: string; quantity: number }> }>,
  pricingSources?: Parameters<typeof readCurrentOrderPricingSnapshot>[1]['pricingSources']) {
  const state = readCreditFundingState(evidence);
  if (!state.ok) throw new Error(state.message);
  const snapshot = readCurrentOrderPricingSnapshot(order.pricingSnapshot ?? evidence.importedOrigin, { currency: order.currency, orderLines: lines, mode: 'refund', creditEvidence: evidence, pricingSources });
  const mapping = snapshot ? Object.fromEntries(Object.entries(snapshot.sourceRefundUnits).map(([line, units]) => [line, units.map(unit => unit.originalIndex)])) :
    Object.fromEntries(Object.entries(state.state.remaining).map(([line, units]) => [line, units.map((_, i) => i)]));
  const unitIds = snapshot ? Object.fromEntries(Object.entries(snapshot.sourceRefundUnits).map(([line, units]) => [line, units.map(unit => unit.unitId)])) :
    Object.fromEntries(Object.entries(mapping).map(([line, indexes]) => [line, indexes.map(index => {
    if (index === null) throw new Error('Unfunded unit requires durable identity');
    return originalCreditUnitId(evidence.redemption.id, line, index);
  })]));
  const used = new Set<string>([...(snapshot?.consumedSourceUnitIds ?? []), ...(snapshot?.reservedSourceUnitIds ?? [])]);
  for (const [line, indexes] of Object.entries(mapping)) indexes.forEach((index, position) => {
    if (index !== null && state.state.returnedIndexes[line]?.includes(index)) used.add(unitIds[line]![position]!);
  });
  const reservations = evidence.refundsComplete === true ? (evidence.refunds ?? []).map(refund => ({ ...refund,
    restored: refund.state === 'Settled' && refund.lines.every(line => {
      const posted = evidence.history.filter(row => row.refundId === refund.id && row.orderLineId === line.orderLineId);
      return posted.length === 1 && posted[0]!.quantity === line.quantity;
    }) })) : reserved;
  for (const reservation of reservations) {
    if (reservation.state === 'Failed') continue;
    if (!reservation.lines.length) continue;
    if ('id' in reservation && typeof reservation.id === 'string' && snapshot?.admittedLegacyRefundIds.includes(reservation.id)) continue;
    const frozen = readCreditUnitReturns(reservation.metadata);
    if (frozen) {
      if (frozen.redemptionId !== evidence.redemption.id) throw new Error('Refund reservation redemption differs');
      for (const line of frozen.lines) line.positions.forEach((position, i) => {
        const index = line.originalIndexes[i]!;
        const id = frozen.version === 2 ? (line as CreditUnitReturnLineV2).unitIds[i]! :
          index !== null ? originalCreditUnitId(evidence.redemption.id, line.orderLineId, index) :
          frozen.snapshotDigest === digest(snapshot?.snapshot ?? order.pricingSnapshot) ? unitIds[line.orderLineId]?.[position] : undefined;
        if (!id) throw new Error('Legacy unfunded reservation lacks durable unit identity');
        // Identity survives edits & completed cash-only returns. Positions are
        // capture evidence, never an offset in a later pricing snapshot.
        used.add(id);
      });
    } else {
      if (reservation.restored) continue;
      if (snapshot?.snapshot.version === 2) throw new Error('Edited credit refund requires frozen unit identity');
      for (const line of reservation.lines) {
        const ids = unitIds[line.orderLineId];
        if (!ids) throw new Error('Legacy reservation line lacks funding identity');
        const available = ids.filter(id => !used.has(id));
        if (available.length < line.quantity) throw new Error('Legacy reservation exceeds available units');
        for (const id of available.slice(0, line.quantity)) used.add(id);
      }
    }
  }
  const available = new Map(Object.entries(unitIds).map(([line, ids]) => [line, ids.flatMap((id, position) => !used.has(id) ? [position] : [])]));
  return { state: state.state, snapshot, mapping, unitIds, available };
}
export type CreditRefundReservation = { metadata: unknown; state?: string; restored?: boolean; lines: Array<{ orderLineId: string; quantity: number }> };
export function availableCreditRefundUnits(order: { currency: string; pricingSnapshot: unknown }, lines: RefundMoneyLine[], evidence: CreditPricingEvidence,
  reserved: CreditRefundReservation[], pricingSources?: Parameters<typeof readCurrentOrderPricingSnapshot>[1]['pricingSources']): Map<string, number[]> {
  return creditRefundSelection(order, lines, evidence, reserved, pricingSources).available;
}
export function prepareCreditUnitReturns(order: { currency: string; pricingSnapshot: unknown }, lines: RefundMoneyLine[], evidence: CreditPricingEvidence,
  selected: Array<{ orderLineId: string; quantity: number }>, reserved: CreditRefundReservation[],
  pricingSources?: Parameters<typeof readCurrentOrderPricingSnapshot>[1]['pricingSources']): CreditUnitReturns {
  const { state, snapshot, mapping, unitIds, available } = creditRefundSelection(order, lines, evidence, reserved, pricingSources);
  if (new Set(selected.map(line => line.orderLineId)).size !== selected.length) throw new Error('Selected refund repeats current line');
  const returns = selected.map(line => {
    const indexes = mapping[line.orderLineId], ids = unitIds[line.orderLineId];
    if (!indexes || !ids || !Number.isSafeInteger(line.quantity) || line.quantity < 1) throw new Error('Selected line lacks current funding identity');
    const positions = available.get(line.orderLineId)?.slice(0, line.quantity) ?? [];
    if (positions.length !== line.quantity) throw new Error('Selected credit units already reserved');
    return { orderLineId: line.orderLineId, positions, originalIndexes: positions.map(i => indexes[i]!),
      creditCents: positions.map(i => indexes[i] === null ? 0 : state.remaining[line.orderLineId]![indexes[i]!]!),
      unitIds: positions.map(i => ids[i]!),
      ...(snapshot ? { presentUnitIds: positions.flatMap(i => snapshot.sourceRefundUnits[line.orderLineId]?.[i]?.present ? [ids[i]!] : []) } : {}),
      unitEconomics: snapshot ? positions.map(i => {
        const unit = snapshot.sourceRefundUnits[line.orderLineId]?.[i];
        if (!unit) throw new Error('Selected source unit economics missing');
        return { net: unit.net, gross: unit.gross, cashRefundGross: unit.cashRefundGross };
      }) : [] };
  });
  if (snapshot) {
    const base = { version: 2 as const, redemptionId: evidence.redemption.id, snapshotHash: snapshot.quoteHash,
      snapshotDigest: digest(snapshot.snapshot), lines: returns };
    return { ...base, requestDigest: digest(base) };
  }
  const base = { version: 1 as const, redemptionId: evidence.redemption.id, snapshotDigest: digest(order.pricingSnapshot),
    lines: returns.map(({ unitIds: _ids, unitEconomics: _economics, presentUnitIds: _present, ...line }) => line) };
  return { ...base, requestDigest: digest(base) };
}

export type RefundCreditRestoration = { state: 'posted' | 'not_applicable' | 'reconciliation_required'; amount: number; errorCode?: string };
export function refundCreditProjection(metadata: unknown): RefundCreditRestoration | null {
  const value = object(metadata) ? metadata.creditRestoration : undefined;
  if (!object(value) || !['posted', 'not_applicable', 'reconciliation_required'].includes(String(value.state)) || !cents(value.amount)) return null;
  return { state: value.state as RefundCreditRestoration['state'], amount: value.amount,
    ...(typeof value.errorCode === 'string' && /^[a-z_]{1,64}$/.test(value.errorCode) ? { errorCode: value.errorCode } : {}) };
}
