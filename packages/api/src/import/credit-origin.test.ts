import { describe, expect, it } from 'vitest';
import { migrationId } from './context.js';
import { vendureLineMoney } from './vendure-money.js';
import { orderEditStoredFingerprint } from '../orders/order-edit-stack.js';
import { planCreditUnitReturn, creditReturnSnapshotDigest } from '../account-credit/edit-funding.js';
import { buildImportedCreditOrigin, decodeCreditPricingOrigin, importedLegacyRefundMatches, importedLegacyRefundProjection,
  importedCreditOriginOrdinaryUnitFacts, type BuildImportedCreditOriginInput } from '../money/imported-credit-origin.js';
import { readCurrentOrderPricingSnapshot, currentCreditFundingTargets, buildCurrentCreditPricingSnapshot,
  type CreditPricingEvidence } from '../money/current-credit-pricing.js';
import { buildOrderPricingSnapshot } from '../money/pricing-snapshot.js';
import { calculatePromotionStack, type StackInput } from '../money/promotion-stack.js';

const STORE = 'dddddddd-0000-4000-8000-000000000001', SOURCE = 'vendure:credit-origin';
const mapped = (entity: string, source: string) => migrationId(STORE, SOURCE, entity, source);
const ORDER = mapped('order', '10'), LINE = mapped('order-line', '40'), ACCOUNT = mapped('account-credit', '1');
const PROMOTION = mapped('promotion', '5'), REDEEM = mapped('account-credit-transaction', '2');
const EDIT = 'dddddddd-0000-4000-8000-000000000002';
function fixture(quantity = 3, placed = 3): BuildImportedCreditOriginInput {
  const allocation = JSON.stringify({ 40: [34, 34, 33] });
  const account = JSON.stringify({ id: 1, promotionId: 5, currencyCode: 'USD', balance: 0, disabled: true });
  const promotion = JSON.stringify({ id: 5, enabled: false, actions: [{ code: 'account_credit_discount', args: [] }],
    conditions: [{ code: 'account_credit_eligible', args: [] }] });
  const transaction = JSON.stringify({ id: 2, accountCreditId: 1, orderId: 10, kind: 'REDEEM', status: 'POSTED', amount: 101, delta: -101, allocation });
  const sourceLine = { id: 40, orderId: 10, quantity, orderPlacedQuantity: placed, listPrice: 100,
    listPriceIncludesTax: false, adjustments: [{ amount: -101, type: 'PROMOTION', adjustmentSource: 'PROMOTION:5',
      data: { itemDistribution: [-34, -34, -33] } }], taxLines: [] };
  const sourceOrderRecord = JSON.stringify({ id: 10, currencyCode: 'USD', pricesIncludeTax: false, couponCodes: ['CREDIT'],
    subTotal: 999, subTotalWithTax: 999, shipping: 0, shippingWithTax: 0 });
  const payload = { version: 1, format: 'retained-pg-jsonb-text-v1', sourceKey: SOURCE, sourceOrderId: '10', sourceOrderRecord,
    channel: { sourceId: '1', projection: 'pricing-v1', sourceRecord: JSON.stringify({ id: 1, defaultCurrencyCode: 'USD', pricesIncludeTax: false, defaultTaxZoneId: null }),
      orderChannelRecord: JSON.stringify({ orderId: 10, channelId: 1 }) }, shippingMethods: [],
    header: { subTotal: '999', subTotalWithTax: '999', shipping: '0', shippingWithTax: '0' }, shippingLines: [], surcharges: [],
    lines: [{ sourceId: '40', orderLineId: LINE, sourceRecord: JSON.stringify(sourceLine) }] };
  const projection = vendureLineMoney(sourceLine);
  const accountSource = { id: ACCOUNT, storeId: STORE, promotionId: PROMOTION, currency: 'USD', sourceKey: SOURCE, sourceId: '1',
    sourceRecord: account, sourcePromotionRecord: promotion, sourceDigest: orderEditStoredFingerprint({ format: 'retained-pg-jsonb-text-v1', account, promotion }),
    promotion: { id: PROMOTION, storeId: STORE, type: 'account_credit' } };
  const redemptionSource = { id: REDEEM, storeId: STORE, sourceKey: SOURCE, sourceId: '2', sourceRecord: transaction,
    sourceDigest: orderEditStoredFingerprint({ format: 'retained-pg-jsonb-text-v1', transaction }), allocation, sourceOrderId: '10',
    orderId: ORDER, accountCreditId: ACCOUNT, kind: 'REDEEM', status: 'POSTED', amount: 101, delta: -101,
    operationalAllocation: { [LINE]: [34, 34, 33] } };
  return { storeId: STORE, orderId: ORDER, currency: 'USD', couponCodes: ['CREDIT'],
    metadata: { vendure: { id: '10', sourceKey: SOURCE, editBasisV1: { ...payload, sourceDigest: orderEditStoredFingerprint(payload) } } },
    totals: { subtotal: projection.lineSubtotal, discountTotal: projection.lineDiscount, shippingTotal: 0,
      taxTotal: projection.lineTax, grandTotal: projection.lineTotal, pointsDiscount: 0 },
    lines: [{ id: LINE, storeId: STORE, orderId: ORDER, quantity, ...projection, metadata: { vendure: { id: '40' } } }],
    accountSource, redemptionSource,
    evidence: { redemption: redemptionSource, history: [], historyComplete: true, refunds: [], refundsComplete: true,
      importedSource: { accountSource, redemptionSource } } };
}
function adopt(input: BuildImportedCreditOriginInput) {
  const origin = buildImportedCreditOrigin(input);
  const evidence: CreditPricingEvidence = { ...input.evidence, importedOrigin: origin };
  const view = readCurrentOrderPricingSnapshot(origin, { currency: 'USD', orderLines: input.lines, mode: 'settlement',
    totals: input.totals, creditEvidence: evidence })!;
  return { origin, evidence, view };
}
function ordinary(quantity: number) {
  const input: StackInput = { currency: 'USD', pricesIncludeTax: false, phase: 'PaymentSettled', couponCodes: [], promotions: [],
    lines: [{ key: LINE, quantity, placedQuantity: 3, unitListPrice: 100, priceIncludesTax: false, taxRateBps: 0 }],
    shipping: 0, shippingTaxRateBps: 0, shippingIncludesTax: false, couponContext: { activeVerifications: [] } };
  const result = calculatePromotionStack(input);
  return { input, snapshot: buildOrderPricingSnapshot(input, result, new Map([[LINE, LINE]])),
    facts: { [LINE]: { sourceAdjustmentTotal: result.lineSnapshots[0]!.sourceAdjustmentTotal!, sourceAdjustmentDivisor: result.lineSnapshots[0]!.sourceAdjustmentDivisor! } } };
}

describe('retained imported credit origin', () => {
  it('requires canonical retained account currencyCode without accepting a normalized currency alias', () => {
    const valid=fixture(),sourceRecord=buildImportedCreditOrigin(valid).accountSource.sourceRecord;
    if (typeof sourceRecord !== 'string') throw new Error('Expected retained account source record');
    expect(JSON.parse(sourceRecord)).toMatchObject({currencyCode:'USD'});
    for (const currencyCode of [undefined,'EUR']) {
      const input=fixture(),sourceRecord=input.accountSource.sourceRecord;
      if (typeof sourceRecord !== 'string') throw new Error('Expected retained account source record');
      const account=JSON.parse(sourceRecord);
      input.accountSource.sourceRecord=JSON.stringify({...account,currencyCode,currency:'USD'});
      input.accountSource.sourceDigest=orderEditStoredFingerprint({format:'retained-pg-jsonb-text-v1',
        account:input.accountSource.sourceRecord,promotion:input.accountSource.sourcePromotionRecord});
      expect(()=>buildImportedCreditOrigin(input)).toThrow('account/promotion native mapping');
    }
  });
  it('keeps real raw proof, reconciled native totals & distinct source refund rounding', () => {
    const input = fixture(), { origin, view } = adopt(input);
    expect(origin).not.toHaveProperty('applied');
    expect(origin.capture.totals.grandTotal).toBe(199); // retained raw header deliberately says 999
    expect(view.unitEconomics[LINE]!.map(unit => unit.cashRefundGross)).toEqual([66, 66, 66]);
    expect(view.unitEconomics[LINE]!.reduce((sum, unit) => sum + unit.gross, 0)).toBe(199);
    const raw = JSON.parse(JSON.stringify(origin));
    expect(decodeCreditPricingOrigin(raw, input.evidence).selectedCredit.allocation).toEqual({ [LINE]: [34, 34, 33] });
  });

  it('retains absent original funding in initial detached custody without a return', () => {
    const input = fixture(2), { origin, evidence, view } = adopt(input), pricing = ordinary(2);
    expect(view.originalUnitIndexes[LINE]).toEqual([0, 1]);
    expect(view.sourceRefundUnits[LINE]!.map(unit => [unit.originalIndex, unit.present])).toEqual([[0, true], [1, true], [2, false]]);
    expect(view.liveAllocation[LINE]).toEqual([34, 34]); expect(view.liveDetachedAllocation[LINE]).toEqual([33]);
    const targets = currentCreditFundingTargets(pricing.snapshot, view.originalUnitIndexes, 'net', pricing.facts,
      { sourceCustody: view.sourceCustody, liveDetachedAllocation: view.liveDetachedAllocation, consumedUnitIds: view.consumedSourceUnitIds });
    expect(targets[0]!.units.map(unit => [unit.originalIndex, unit.maximumCredit])).toEqual([[0, 100], [1, 100], [2, 33]]);
    const saved = buildCurrentCreditPricingSnapshot({ origin, ordinary: pricing.snapshot, ordinaryUnitFacts: pricing.facts, evidence,
      couponCodes: ['CREDIT'], originalUnitIndexes: view.originalUnitIndexes, unitIds: view.unitIds, predecessor: view,
      lineage: { editId: EDIT, predecessorSnapshotDigest: creditReturnSnapshotDigest(origin), consumedUnitIds: view.consumedSourceUnitIds } });
    expect(saved.credit.sourceCustodyAllocation![LINE]).toEqual([33]);
    expect(saved.totals.grandTotal).toBe(133);
    expect(Object.values(saved.credit.allocation).flat().reduce((sum, value) => sum + value, 0) + saved.credit.sourceCustodyAllocation![LINE]![0]!).toBe(101);
  });

  it('maps remaining source identities after a proven return & keeps detached consumed identity', () => {
    const input = fixture(2), returned = planCreditUnitReturn({ ...input.evidence, orderLineId: LINE, originalIndexes: [0],
      operation: { kind: 'manual_return', id: 'captured-manual-return' } });
    if (!returned.ok || !returned.posting) throw new Error('Expected source return');
    input.evidence.history = [{ ...returned.posting, id: 'source-return' }];
    const { view } = adopt(input);
    expect(view.originalUnitIndexes[LINE]).toEqual([1, 2]); expect(view.liveDetachedAllocation[LINE]).toEqual([0]);
    expect(view.consumedSourceUnitIds).toContain(`original:${REDEEM}:${LINE}:0`);
  });

  it('retains null-credit source slots outside current quantity & admits genuine historical cash rounding', () => {
    const input = fixture(), second = mapped('order-line', '41');
    const metadata = input.metadata as { vendure: { editBasisV1: { sourceDigest: string; lines: Array<{sourceId: string; orderLineId: string; sourceRecord: string}> } } };
    const raw = { id: 41, orderId: 10, quantity: 1, orderPlacedQuantity: 2, listPrice: 30, listPriceIncludesTax: false, adjustments: [], taxLines: [] };
    metadata.vendure.editBasisV1.lines.push({ sourceId: '41', orderLineId: second, sourceRecord: JSON.stringify(raw) });
    const { sourceDigest: _old, ...payload } = metadata.vendure.editBasisV1;
    metadata.vendure.editBasisV1.sourceDigest = orderEditStoredFingerprint(payload);
    input.lines.push({ id: second, orderId: ORDER, storeId: STORE, quantity: 1, ...vendureLineMoney(raw), metadata: { vendure: { id: '41' } } });
    input.totals.subtotal += 30; input.totals.grandTotal += 30;
    input.evidence.refunds = [{ id: 'historical-cash', state: 'Settled', amount: 17, metadata: { vendureId: '77', allocation: 'derived-source-allocation' },
      lines: [{ id: 'historical-line', orderLineId: second, quantity: 1, amount: 17 }] }];
    const { view } = adopt(input);
    expect(view.sourceRefundUnits[second]!.map(u=>[u.originalIndex,u.present,u.cashRefundGross])).toEqual([[null,true,30],[null,false,30]]);
    expect(view.consumedSourceUnitIds).toHaveLength(1);
    expect(view.sourceRefundUnits[second]![1]!.unitId).toBe(view.consumedSourceUnitIds[0]);
    expect(view.admittedLegacyRefundIds).toEqual(['historical-cash']);
    expect(view.liveDetachedAllocation[second]).toEqual([0]);
    input.evidence.refunds[0]!.state = 'Pending';
    const pending = adopt(input), unitIds = structuredClone(pending.origin.capture.currentUnitIds);
    const settled = { ...pending.evidence, refunds: pending.evidence.refunds!.map(refund=>({ ...refund, state: 'Settled',
      metadata: { ...refund.metadata as object, creditRestoration: { status: 'posted' } } })) };
    const after = readCurrentOrderPricingSnapshot(pending.origin, { currency: 'USD', orderLines: input.lines, mode: 'refund', creditEvidence: settled })!;
    expect(after.unitIds).toEqual(unitIds);
    expect(after.consumedSourceUnitIds).toContain(unitIds[second]![0]);
  });

  it('rejects forged raw records, mappings, currency, promotion semantics & capture digest', () => {
    for (const change of [
      (input: BuildImportedCreditOriginInput) => { input.accountSource.sourceRecord += ' '; },
      (input: BuildImportedCreditOriginInput) => { input.accountSource.promotionId = ACCOUNT; },
      (input: BuildImportedCreditOriginInput) => { input.accountSource.currency = 'EUR'; },
      (input: BuildImportedCreditOriginInput) => { input.redemptionSource.operationalAllocation![LINE]![0] = 33; },
    ]) { const input = fixture(); change(input); expect(() => buildImportedCreditOrigin(input)).toThrow(); }
    const input = fixture(), origin = buildImportedCreditOrigin(input); origin.capture.totals.grandTotal += 1;
    expect(() => decodeCreditPricingOrigin(origin, input.evidence)).toThrow('capture digest');
  });

  it('uses real linked credit source facts for unchanged rounding without altering placement evidence', () => {
    const origin = buildImportedCreditOrigin(fixture(2));
    expect(importedCreditOriginOrdinaryUnitFacts(origin)[LINE]).toEqual({ net: 100, gross: 100, sourceAdjustmentTotal: 0, sourceAdjustmentDivisor: 3 });
    const forged = structuredClone(origin), basis = forged.editBasisV1 as { lines: Array<{sourceRecord: string}> };
    const line = JSON.parse(basis.lines[0]!.sourceRecord); line.adjustments[0].data.itemDistribution[0] = -35;
    basis.lines[0]!.sourceRecord = JSON.stringify(line);
    expect(() => importedCreditOriginOrdinaryUnitFacts(forged)).toThrow('distribution proof');
  });

  it('preserves a proven negative source surcharge total without clamping or inferred tax', () => {
    const input = fixture();
    const metadata = input.metadata as { vendure: { editBasisV1: { sourceDigest: string; surcharges: Array<{sourceId: string; sourceRecord: string}> } } };
    metadata.vendure.editBasisV1.surcharges.push({ sourceId: '70', sourceRecord: JSON.stringify({ id: 70, orderId: 10,
      description: 'Retained credit', listPrice: -300, listPriceIncludesTax: false, adjustments: [], taxLines: [{ taxRate: 20 }] }) });
    const { sourceDigest: _old, ...payload } = metadata.vendure.editBasisV1;
    metadata.vendure.editBasisV1.sourceDigest = orderEditStoredFingerprint(payload);
    input.totals.taxTotal = -60; input.totals.grandTotal = -161;
    const { origin, view, evidence } = adopt(input), current = ordinary(3);
    const stackInput: StackInput = { currency: 'USD', pricesIncludeTax: false, phase: 'PaymentSettled', couponCodes: [], promotions: [],
      lines: current.input.lines, shipping: 0, shippingIncludesTax: false, shippingTaxRateBps: 0, couponContext: { activeVerifications: [] },
      adjustments: [{ amount: -300, sourceSurcharge: { sourceId: '70', sourceDigest: metadata.vendure.editBasisV1.sourceDigest, net: -300, gross: -360 } }] };
    const result = calculatePromotionStack(stackInput), saved = buildCurrentCreditPricingSnapshot({ origin,
      ordinary: buildOrderPricingSnapshot(stackInput, result, new Map([[LINE, LINE]])), ordinaryUnitFacts: current.facts,
      evidence, couponCodes: ['CREDIT'], originalUnitIndexes: view.originalUnitIndexes, unitIds: view.unitIds, predecessor: view,
      lineage: { editId: EDIT, predecessorSnapshotDigest: creditReturnSnapshotDigest(origin), consumedUnitIds: [] } });
    expect(saved.totals.grandTotal).toBe(-161); expect(saved.totals.taxTotal).toBe(-60);
  });

  it('reprices source shipping & tax while preserving actual prior shipping adjustment', () => {
    const input = fixture();
    const metadata = input.metadata as { vendure: { editBasisV1: { sourceDigest: string; shippingLines: Array<{sourceId: string; sourceRecord: string}> } } };
    metadata.vendure.editBasisV1.shippingLines.push({ sourceId: '60', sourceRecord: JSON.stringify({ id: 60, orderId: 10,
      shippingMethodId: null, listPrice: 100, listPriceIncludesTax: false, adjustments: [{amount:-20,type:'PROMOTION'}], taxLines: [{taxRate:20}] }) });
    const { sourceDigest: _old, ...payload } = metadata.vendure.editBasisV1;
    metadata.vendure.editBasisV1.sourceDigest = orderEditStoredFingerprint(payload);
    input.totals.shippingTotal = 80; input.totals.taxTotal = 16; input.totals.grandTotal = 295;
    const { origin, view, evidence } = adopt(input), current = ordinary(3);
    for (const amount of [50,10]) {
      const net=amount-20,gross=Math.round(net*1.1);
      const stackInput: StackInput = { currency:'USD',pricesIncludeTax:false,phase:'PaymentSettled',couponCodes:[],
        promotions:[{id:'free-now',code:null,kind:'free_shipping',scope:'order',value:0,priority:0,sequence:0,freeShipping:true,conditions:[]}],
        lines:current.input.lines,shipping:net,shippingIncludesTax:false,shippingTaxRateBps:0,couponContext:{activeVerifications:[]},
        retainedShipping:{sourceDigest:creditReturnSnapshotDigest(origin),mode:'recalculate-keep-promotions',lines:[{sourceId:'60',net,gross}],
          repricedBasis:[{sourceId:'60',amount,includesTax:false,taxRateBps:1000}]} };
      const result=calculatePromotionStack(stackInput),saved=buildCurrentCreditPricingSnapshot({origin,evidence,predecessor:view,
        ordinary:buildOrderPricingSnapshot(stackInput,result,new Map([[LINE,LINE]])),ordinaryUnitFacts:current.facts,couponCodes:['CREDIT'],
        originalUnitIndexes:view.originalUnitIndexes,unitIds:view.unitIds,
        lineage:{editId:EDIT,predecessorSnapshotDigest:creditReturnSnapshotDigest(origin),consumedUnitIds:[]} });
      expect(saved.totals.shippingTotal).toBe(net); expect(saved.totals.grandTotal).toBe(199+gross);
      expect(saved.totals.taxTotal).toBe(gross-net); expect(saved.ordinary.applied).toEqual([]);
    }
  });

  it('keeps immutable baseline refund facts while operational retries & pending state advance', () => {
    const captured = { id: 'legacy', state: 'Pending', amount: 67, metadata: { vendureId: '55', creditRestoration: { status: 'pending' } },
      lines: [{ id: 'legacy-line', orderLineId: LINE, quantity: 1, amount: 67 }] };
    const actual = { ...captured, state: 'Settled', metadata: { vendureId: '55', creditRestoration: { status: 'done' }, stockEffects: { done: true } } };
    expect(importedLegacyRefundProjection(captured).metadata).toEqual({ vendureId: '55' });
    expect(importedLegacyRefundMatches(captured, actual)).toBe(true);
    expect(importedLegacyRefundMatches({ ...captured, state: 'Settled' }, { ...actual, state: 'Failed' })).toBe(false);
    expect(importedLegacyRefundMatches(captured, { ...actual, lines: [{ ...actual.lines[0]!, amount: 66 }] })).toBe(false);
  });

  it('preserves unresolved pending original-credit facts without guessing a unit reservation', () => {
    const input = fixture();
    input.evidence.refunds = [{ id: 'pending-source', state: 'Pending', amount: 66, metadata: { vendureId: '78' },
      lines: [{ id: 'pending-line', orderLineId: LINE, quantity: 1, amount: 66 }] }];
    const before = structuredClone(input.evidence.refunds);
    expect(() => buildImportedCreditOrigin(input)).toThrow('restoration association');
    expect(input.evidence.refunds).toEqual(before);
    expect(input.evidence.history).toEqual([]);
  });
});
