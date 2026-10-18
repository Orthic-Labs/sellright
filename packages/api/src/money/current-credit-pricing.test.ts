import { describe, expect, it } from 'vitest';
import { orderEditStoredFingerprint } from '../orders/order-edit-stack.js';
import { buildEditStageProposal } from '../orders/edit-stage.js';
import { planEditCreditFunding, planCreditUnitReturn, originalCreditUnitId, creditReturnSnapshotDigest,
  type EditFundingHistoryRow, type EditFundingRedemption, type CreditRefundEvidence, type CreditUnitReturnsV2 } from '../account-credit/edit-funding.js';
import { calculatePromotionStack, type StackInput } from './promotion-stack.js';
import { buildOrderPricingSnapshot, readOrderPricingSnapshot, type OrderPricingSnapshotV1 } from './pricing-snapshot.js';
import { buildCurrentCreditPricingSnapshot, currentCreditFundingTargets, currentCreditPricingHash, currentShippingSourceFacts,
  readCurrentOrderPricingSnapshot, type BuildCurrentCreditPricingInput, type OrdinaryUnitFacts } from './current-credit-pricing.js';

const ORDER = 'cccccccc-0000-4000-8000-000000000001';
const ACCOUNT = 'cccccccc-0000-4000-8000-000000000002';
const PROMOTION = 'cccccccc-0000-4000-8000-000000000003';
const LINE = 'cccccccc-0000-4000-8000-000000000004';
const NEW = 'cccccccc-0000-4000-8000-000000000005';
const REDEEM = 'cccccccc-0000-4000-8000-000000000006';
const EDIT = 'cccccccc-0000-4000-8000-000000000007';
function stack(tax = 875, inclusive = false): StackInput {
  return { lines: [{ key: 'sku', quantity: 3, placedQuantity: 3, unitListPrice: 100, priceIncludesTax: inclusive, taxRateBps: tax }],
    promotions: [{ id: PROMOTION, code: 'CREDIT', kind: 'account_credit', scope: 'order', value: 0,
      priority: 0, sequence: 1, freeShipping: false, conditions: null, credit: { accountId: ACCOUNT, availableCents: 101 } }],
    couponCodes: ['CREDIT'], phase: 'PaymentSettled', currency: 'USD', pricesIncludeTax: inclusive,
    shipping: 50, shippingTaxRateBps: tax, shippingIncludesTax: inclusive, couponContext: { activeVerifications: [] } };
}
function snapshot(input: StackInput, ids = new Map([['sku', LINE]])) {
  const result = calculatePromotionStack(input);
  const ordinaryUnitFacts: OrdinaryUnitFacts = Object.fromEntries(result.lineSnapshots.map(l => [ids.get(l.lineKey)!, {
    sourceAdjustmentTotal: l.sourceAdjustmentTotal!, sourceAdjustmentDivisor: l.sourceAdjustmentDivisor!,
  }]));
  return { saved: buildOrderPricingSnapshot(input, result, ids), ordinaryUnitFacts };
}
type NativeInput = BuildCurrentCreditPricingInput & { origin: OrderPricingSnapshotV1 };
function fixture(tax = 875, inclusive = false): NativeInput {
  const input = stack(tax, inclusive), origin = snapshot(input).saved;
  const ordinary = snapshot({ ...input, promotions: [], couponCodes: [] });
  const redemption: EditFundingRedemption = { id: REDEEM, orderId: ORDER, accountCreditId: ACCOUNT, kind: 'REDEEM', status: 'POSTED',
    amount: 101, delta: -101, operationalAllocation: structuredClone(origin.selectedCredit!.allocation) };
  return { origin, ordinary: ordinary.saved, ordinaryUnitFacts: ordinary.ordinaryUnitFacts, couponCodes: ['CREDIT'],
    evidence: { redemption, history: [], historyComplete: true, refunds: [], refundsComplete: true }, originalUnitIndexes: { [LINE]: [0, 1, 2] },
    unitIds: { [LINE]: [0, 1, 2].map(index => originalCreditUnitId(REDEEM, LINE, index)) },
    lineage: { editId: EDIT, predecessorSnapshotDigest: creditReturnSnapshotDigest(origin), consumedUnitIds: [] } };
}
function sourceRow(saved: ReturnType<typeof buildCurrentCreditPricingSnapshot>, predecessor = saved.origin as unknown,
  history: readonly EditFundingHistoryRow[] = [], capturedPredecessor?: BuildCurrentCreditPricingInput['predecessor']) {
  const origin = saved.origin; if ('kind' in origin) throw new Error('Native fixture required');
  const own = history.filter(row => row.allocation && JSON.parse(row.allocation).editId === saved.lineage.editId);
  const requestDigest = own.length ? String(JSON.parse(own[0]!.allocation!).requestDigest) : '0'.repeat(64), postingKeys = own.map(row => row.idempotencyKey);
  const predecessorView = capturedPredecessor ?? readCurrentOrderPricingSnapshot(predecessor, {
    currency: saved.currency, orderLines: origin.lines.map(l => ({ id: l.orderLineId, quantity: l.quantity })), mode: 'settlement',
    creditEvidence: { redemption: { id: REDEEM, orderId: ORDER, accountCreditId: ACCOUNT, kind: 'REDEEM', status: 'POSTED',
      amount: 101, delta: -101, operationalAllocation: origin.selectedCredit!.allocation }, history, historyComplete: true,
      refunds: [], refundsComplete: true },
  })!;
  const payload = { editId: saved.lineage.editId, orderId: ORDER, pricingSnapshot: saved, requestDigest, postingKeys,
    lineIds: Object.fromEntries(saved.lines.map(l => [l.key, l.orderLineId])),
    activation: { unitIds: saved.unitIds, indexes: saved.originalUnitIndexes, predecessor: predecessorView,
      lineage: saved.lineage, origin: saved.origin, ordinary: saved.ordinary, ordinaryUnitFacts: saved.ordinaryUnitFacts } };
  const proposal = buildEditStageProposal({ ...payload, lines: saved.lines, couponCodes: saved.couponCodes,
    appliedPromotionIds: saved.ordinary.applied.map(p=>p.promotionId), fundingPlan: { requestDigest, postings: own },
    requestFingerprint: orderEditStoredFingerprint({ editId: saved.lineage.editId }), previewAcceptanceHash: saved.quoteHash,
    beforeFingerprint: orderEditStoredFingerprint(predecessor), beforeLedgerPrefixDigest: orderEditStoredFingerprint(history),
    settlementRequirement: { type: 'none', currency: saved.currency, requiredTender: 0, requiredRefund: 0 },
    stockReservationReceipt: { key: `order-edit:${saved.lineage.editId}:stock`, positiveDeltas: [] } });
  return { id: saved.lineage.editId, orderId: ORDER, before: { currentPricing: predecessor },
    after: { activatedPricingSnapshot: saved, proposal },
    settlement: { phase: 'activated', type: 'none', status: 'settled', activationReceipt: { proposalDigest: proposal.proposalDigest, requestDigest, postingKeys, activatedAt: '2026-10-18T00:00:00.000Z',
      activatedSnapshotHash: creditReturnSnapshotDigest(saved) } } };
}
function context(i: BuildCurrentCreditPricingInput, saved?: ReturnType<typeof buildCurrentCreditPricingSnapshot>) {
  return { currency: 'USD', orderLines: i.ordinary.lines.map(l => ({ id: l.orderLineId, quantity: l.quantity })),
    mode: 'settlement' as const, creditEvidence: i.evidence, pricingSources: saved ? [sourceRow(saved, i.predecessor?.snapshot ?? i.origin, i.evidence.history, i.predecessor)] : [] };
}
function plan(i: NativeInput) {
  const result = planEditCreditFunding({ ...i.evidence, editId: EDIT,
    lines: currentCreditFundingTargets(i.ordinary, i.originalUnitIndexes, i.origin.pricesIncludeTax ? 'gross' : 'net', i.ordinaryUnitFacts) });
  if (!result.ok || result.replay) throw new Error('Expected fresh funding plan');
  return result;
}
const posted = (p: ReturnType<typeof plan>['postings']): EditFundingHistoryRow[] => p.map(row => ({ ...row, id: row.idempotencyKey }));

describe('current edited credit pricing proof', () => {
  it('resolves direct noncredit shipping ancestry through exact saved financial rows', () => {
    const plain = snapshot({...stack(0),promotions:[],couponCodes:[]}).saved;
    const quote = (prior:OrderPricingSnapshotV1, amount:number, mode:'keep'|'revalidate-promotions'|'recalculate-keep-promotions', waive=false) => snapshot({
      ...stack(0),shipping:amount,couponCodes:[],promotions:waive ? [{id:'shipping-action',code:null,kind:'free_shipping',scope:'order',value:0,
        priority:0,sequence:0,freeShipping:true,conditions:[]}] : [], retainedShipping:{sourceDigest:creditReturnSnapshotDigest(prior),mode,
        lines:[{sourceId:'current-shipping',net:amount,gross:amount}],
        carriers:[{sourceId:'current-shipping',methodCode:'courier',lineKeys:['sku']}],
        ...(mode === 'recalculate-keep-promotions' ? {repricedBasis:[{sourceId:'current-shipping',amount:80,includesTax:false,taxRateBps:0}]} : {})}
    }).saved;
    const saved = (s:OrderPricingSnapshotV1) => ({totals:structuredClone(s.totals),lines:s.lines.map(l=>({id:l.orderLineId,quantity:l.quantity,lineTotal:l.lineGross}))});
    const row = (id:string,prior:OrderPricingSnapshotV1,next:OrderPricingSnapshotV1) => ({id,orderId:ORDER,
      before:{...saved(prior),currentPricing:prior},after:{...saved(next),currentPricing:next,currentPricingDigest:creditReturnSnapshotDigest(next)},settlement:{type:'none',status:'none'}});
    const first=quote(plain,50,'revalidate-promotions',true), firstRow=row(EDIT,plain,first);
    const second=quote(first,0,'keep'), secondRow=row(NEW,first,second);
    const view=(s:OrderPricingSnapshotV1)=>readCurrentOrderPricingSnapshot(s,{currency:'USD',orderLines:[{id:LINE,quantity:3}],mode:'settlement'})!;
    expect(currentShippingSourceFacts(view(second),undefined,[firstRow,secondRow],{orderId:ORDER})).toEqual({
      basis:[{sourceId:'current-shipping',amount:50,includesTax:false,taxRateBps:0}],adjustments:{'current-shipping':-50},
      carriers:[{sourceId:'current-shipping',methodCode:'courier',lineKeys:['sku']}]} );
    const third=quote(second,30,'recalculate-keep-promotions'), thirdRow=row(REDEEM,second,third);
    expect(currentShippingSourceFacts(view(third),undefined,[firstRow,secondRow,thirdRow],{orderId:ORDER})).toEqual({
      basis:[{sourceId:'current-shipping',amount:80,includesTax:false,taxRateBps:0}],adjustments:{'current-shipping':-50},
      carriers:[{sourceId:'current-shipping',methodCode:'courier',lineKeys:['sku']}]} );
    const revalidated=snapshot({...stack(0),shipping:50,promotions:[],couponCodes:[],retainedShipping:{
      sourceDigest:creditReturnSnapshotDigest(third),mode:'revalidate-promotions',lines:[{sourceId:'current-shipping',net:50,gross:50}],
      repricedBasis:[{sourceId:'current-shipping',amount:50,includesTax:false,taxRateBps:0}],
      carriers:[{sourceId:'current-shipping',methodCode:null,lineKeys:['sku']}]}}).saved;
    const revalidatedRow=row(ACCOUNT,third,revalidated);
    expect(currentShippingSourceFacts(view(revalidated),undefined,[firstRow,secondRow,thirdRow,revalidatedRow],{orderId:ORDER})).toEqual({
      basis:[{sourceId:'current-shipping',amount:50,includesTax:false,taxRateBps:0}],adjustments:{'current-shipping':0},
      carriers:[{sourceId:'current-shipping',methodCode:null,lineKeys:['sku']}]});
    const removed=snapshot({...stack(0),shipping:0,promotions:[],couponCodes:[],retainedShipping:{
      sourceDigest:creditReturnSnapshotDigest(second),mode:'recalculate-keep-promotions',lines:[],repricedBasis:[],carriers:[]}}).saved;
    expect(currentShippingSourceFacts(view(removed),undefined,[firstRow,secondRow,row(ACCOUNT,second,removed)],{orderId:ORDER})).toEqual({basis:[],adjustments:{},carriers:[]});
    expect(()=>currentShippingSourceFacts(view(second),undefined,[secondRow],{orderId:ORDER})).toThrow('ancestry');
    const forged=structuredClone(firstRow);forged.after.totals.grandTotal++;
    expect(()=>currentShippingSourceFacts(view(second),undefined,[forged,secondRow],{orderId:ORDER})).toThrow('saved totals');
    expect(()=>currentShippingSourceFacts(view(second),undefined,[firstRow,secondRow],{orderId:ACCOUNT})).toThrow('source');
  });
  it('rejects reassigned membership even when source amounts & hashes are internally consistent', () => {
    const i=fixture(0),secondKey='second';
    const firstQuote=snapshot({...stack(0),promotions:[],couponCodes:[],shipping:50,
      lines:[...stack(0).lines,{...stack(0).lines[0]!,key:secondKey,quantity:1,placedQuantity:1}],
      retainedShipping:{sourceDigest:creditReturnSnapshotDigest(i.origin),mode:'revalidate-promotions',lines:[{sourceId:'current-shipping',net:50,gross:50}],
        carriers:[{sourceId:'current-shipping',methodCode:'courier',lineKeys:['sku']}] }},new Map([['sku',LINE],[secondKey,NEW]]));
    const firstInput={...i,ordinary:firstQuote.saved,ordinaryUnitFacts:firstQuote.ordinaryUnitFacts,
      originalUnitIndexes:{...i.originalUnitIndexes,[NEW]:[null]},unitIds:{...i.unitIds,[NEW]:[`edit:${EDIT}:${NEW}:0`]}};
    const first=buildCurrentCreditPricingSnapshot(firstInput),row=sourceRow(first),prior=readCurrentOrderPricingSnapshot(first,{...context(firstInput),pricingSources:[row]})!;
    const nextQuote=snapshot({...stack(0),promotions:[],couponCodes:[],shipping:50,
      lines:[...stack(0).lines,{...stack(0).lines[0]!,key:secondKey,quantity:1,placedQuantity:1}],
      retainedShipping:{sourceDigest:creditReturnSnapshotDigest(first),mode:'keep',lines:[{sourceId:'current-shipping',net:50,gross:50}],
        carriers:[{sourceId:'current-shipping',methodCode:'courier',lineKeys:[secondKey]}]}},new Map([['sku',LINE],[secondKey,NEW]]));
    expect(()=>buildCurrentCreditPricingSnapshot({...firstInput,ordinary:nextQuote.saved,ordinaryUnitFacts:nextQuote.ordinaryUnitFacts,
      predecessor:prior,pricingSources:[row],lineage:{editId:REDEEM,predecessorSnapshotDigest:creditReturnSnapshotDigest(first),consumedUnitIds:[]}})).toThrow('membership transferred');
  });
  it('recovers shipping base through kept-zero vectors only from durable predecessor receipts', () => {
    const i = fixture(0), originDigest = creditReturnSnapshotDigest(i.origin);
    const quote = (shipping: number, sourceDigest: string, mode: 'keep' | 'revalidate-promotions', waive = false) => snapshot({ ...stack(0), shipping,
      couponCodes: [], promotions: waive ? [{ id: 'shipping-action', code: null, kind: 'free_shipping', scope: 'order', value: 0,
        priority: 0, sequence: 0, freeShipping: true, conditions: [] }] : [],
      retainedShipping: { sourceDigest, mode, lines: [{ sourceId: 'current-shipping', net: shipping, gross: shipping }] } });
    const firstQuote = quote(50, originDigest, 'revalidate-promotions', true);
    const firstInput = { ...i, ordinary: firstQuote.saved, ordinaryUnitFacts: firstQuote.ordinaryUnitFacts };
    const first = buildCurrentCreditPricingSnapshot(firstInput), firstRow = sourceRow(first);
    const firstView = readCurrentOrderPricingSnapshot(first, { ...context(i), pricingSources: [firstRow] })!;
    const keptQuote = quote(0, creditReturnSnapshotDigest(first), 'keep');
    const secondInput = { ...i, ordinary: keptQuote.saved, ordinaryUnitFacts: keptQuote.ordinaryUnitFacts, predecessor: firstView,
      lineage: { editId: NEW, predecessorSnapshotDigest: creditReturnSnapshotDigest(first), consumedUnitIds: [] }, pricingSources: [firstRow] };
    const second = buildCurrentCreditPricingSnapshot(secondInput), secondRow = sourceRow(second, first, [], firstView);
    const sources = [firstRow, secondRow], secondView = readCurrentOrderPricingSnapshot(second, { ...context(i), pricingSources: sources })!;
    const baseQuote = quote(50, creditReturnSnapshotDigest(second), 'revalidate-promotions');
    const thirdInput = { ...i, ordinary: baseQuote.saved, ordinaryUnitFacts: baseQuote.ordinaryUnitFacts, predecessor: secondView,
      lineage: { editId: 'cccccccc-0000-4000-8000-000000000008', predecessorSnapshotDigest: creditReturnSnapshotDigest(second), consumedUnitIds: [] } };
    expect(() => buildCurrentCreditPricingSnapshot(thirdInput)).toThrow('ancestry');
    expect(buildCurrentCreditPricingSnapshot({ ...thirdInput, pricingSources: sources }).totals.grandTotal).toBe(i.origin.totals.grandTotal);
    const forged = structuredClone(sources); forged[1]!.settlement.activationReceipt.activatedSnapshotHash = '0'.repeat(64);
    expect(() => buildCurrentCreditPricingSnapshot({ ...thirdInput, pricingSources: forged })).toThrow('receipt');
  });
  it.each([[0, false], [875, false], [5000, false], [875, true], [5000, true]] as const)(
    'preserves unchanged aggregate placement prices at tax %i inclusive %s', (tax, inclusive) => {
      const i = fixture(tax, inclusive), saved = buildCurrentCreditPricingSnapshot(i);
      expect(saved.totals).toEqual(i.origin.totals);
      expect(saved.lines.map(l => [l.lineNet, l.lineGross])).toEqual(i.origin.lines.map(l => [l.lineNet, l.lineGross]));
      expect(saved.credit.allocation).toEqual(i.origin.selectedCredit!.allocation);
      expect(saved.credit.basis).toBe(inclusive ? 'gross' : 'net');
      expect(readCurrentOrderPricingSnapshot(JSON.parse(JSON.stringify(saved)), { ...context(i, saved), totals: saved.totals })?.snapshot).toEqual(saved);
      expect(readOrderPricingSnapshot(i.origin, { ...context(i), totals: i.origin.totals })).toEqual(i.origin);
    });

  it('keeps uneven original funding on original units & new positions fully cash priced', () => {
    const i = fixture(0), input = stack(0);
    input.lines[0]!.quantity = 4;
    const ordinary = snapshot({ ...input, promotions: [], couponCodes: [] });
    i.ordinary = ordinary.saved; i.ordinaryUnitFacts = ordinary.ordinaryUnitFacts;
    i.originalUnitIndexes[LINE] = [2, null, 0, 1];
    i.unitIds[LINE] = [i.unitIds[LINE]![2]!, `edit:${EDIT}:${LINE}:0`, i.unitIds[LINE]![0]!, i.unitIds[LINE]![1]!];
    const saved = buildCurrentCreditPricingSnapshot(i), origin = i.origin.selectedCredit!.allocation[LINE]!;
    expect(saved.credit.allocation[LINE]).toEqual([origin[2], 0, origin[0], origin[1]]);
    expect(saved.lines[0]!.cashRefundGrossUnits).toEqual([100 - origin[2]!, 100, 100 - origin[0]!, 100 - origin[1]!]);
    expect(saved.lines[0]!.lineGross).toBe(299);
    expect(saved.lines[0]!.cashRefundGrossUnits[1]).toBe(100);
  });

  it('activates only after exact posted restoration & refuses missing, changed or incomplete evidence', () => {
    const i = fixture(0); const ordinary = snapshot({ ...stack(0), promotions: [], couponCodes: [],
      lines: [{ ...stack(0).lines[0]!, unitListPrice: 20 }] });
    i.ordinary = ordinary.saved; i.ordinaryUnitFacts = ordinary.ordinaryUnitFacts;
    expect(() => buildCurrentCreditPricingSnapshot(i)).toThrow('funding exceeds');
    const effects = plan(i); i.evidence.history = posted(effects.postings);
    const saved = buildCurrentCreditPricingSnapshot(i);
    expect(saved.credit.allocation[LINE]).toEqual([20, 20, 20]);
    expect(saved.lines[0]!.cashRefundGrossUnits).toEqual([0, 0, 0]);
    expect(saved.credit.atPricingRestoreIds).toEqual(i.evidence.history.map(h => h.id).sort());
    expect(() => readCurrentOrderPricingSnapshot(saved, { ...context(i, saved), creditEvidence: { ...i.evidence, history: [] } })).toThrow('absent');
    const changed = structuredClone(i.evidence); changed.history[0]!.amount += 1;
    expect(() => readCurrentOrderPricingSnapshot(saved, { ...context(i, saved), creditEvidence: changed })).toThrow('digest');
    expect(() => readCurrentOrderPricingSnapshot(saved, { ...context(i, saved), creditEvidence: { ...i.evidence, historyComplete: false } as never })).toThrow('Complete');
  });

  it('allows later merchandise RESTOREs without rewriting saved prices or activation allocation', () => {
    const i = fixture(0), saved = buildCurrentCreditPricingSnapshot(i);
    const later = structuredClone(i); later.originalUnitIndexes[LINE] = [1, 2];
    const ordinary = snapshot({ ...stack(0), promotions: [], couponCodes: [], lines: [{ ...stack(0).lines[0]!, quantity: 2 }] });
    later.ordinary = ordinary.saved; later.ordinaryUnitFacts = ordinary.ordinaryUnitFacts;
    const effects = plan(later), history = posted(effects.postings);
    const read = readCurrentOrderPricingSnapshot(saved, { ...context(i, saved), mode: 'refund',
      orderLines: [{ id: LINE, quantity: 2 }], creditEvidence: { ...i.evidence, history } })!;
    expect(read.lines).toEqual(saved.lines); expect(read.totals).toEqual(saved.totals);
    expect(read.selectedCredit!.allocation).toEqual(saved.credit.allocation);
    expect(read.liveAllocation[LINE]).toEqual([0, saved.credit.allocation[LINE]![1], saved.credit.allocation[LINE]![2]]);
    expect(read.fundingState!.restored).toBe(i.origin.selectedCredit!.allocation[LINE]![0]);
    expect(read.consumedPositions[LINE]).toEqual([0]);
  });

  it('rejects transferred, duplicated, omitted & forged identities or producer pricing', () => {
    for (const indexes of [[0, 0, 2], [0, null, 2], [0, 1, 99]]) {
      const i = fixture(); i.originalUnitIndexes[LINE] = indexes;
      expect(() => buildCurrentCreditPricingSnapshot(i)).toThrow(/index|unit/);
    }
    const i = fixture(); i.ordinary.lines[0]!.orderLineId = NEW;
    expect(() => buildCurrentCreditPricingSnapshot(i)).toThrow();
    const bad = fixture(); bad.ordinaryUnitFacts[LINE]!.sourceAdjustmentTotal = -1;
    expect(() => buildCurrentCreditPricingSnapshot(bad)).toThrow('provenance');
    const forged = fixture(); forged.evidence.redemption.operationalAllocation![LINE]!.reverse();
    expect(() => buildCurrentCreditPricingSnapshot(forged)).toThrow('origin');
    const saved = buildCurrentCreditPricingSnapshot(fixture()); saved.unitEconomics[LINE]![0]!.gross += 1;
    saved.quoteHash = currentCreditPricingHash(saved);
    expect(() => readCurrentOrderPricingSnapshot(saved, context(fixture(), saved))).toThrow('facts/hash');
  });

  it('uses genuine source facts including points & leaves V1 refund rounding unchanged', () => {
    const input = stack(875); input.promotions = []; input.couponCodes = []; input.pointsDiscount = 11;
    const ordinary = snapshot(input);
    expect(ordinary.ordinaryUnitFacts[LINE]).toEqual({ sourceAdjustmentTotal: -11, sourceAdjustmentDivisor: 3 });
    const i = fixture(); i.ordinary = ordinary.saved; i.ordinaryUnitFacts = ordinary.ordinaryUnitFacts;
    const saved = buildCurrentCreditPricingSnapshot(i);
    expect(readCurrentOrderPricingSnapshot(saved, context(i, saved))?.lines).toEqual(saved.lines);
    const v1 = readCurrentOrderPricingSnapshot(i.origin, { ...context(i), creditEvidence: undefined })!;
    expect(v1.lines[0]!.cashRefundGrossUnits).toEqual(Array(3).fill(i.origin.lines[0]!.proratedUnitPriceWithTax));
    expect(saved.ordinary.lines[0]).not.toHaveProperty('sourceAdjustmentTotal');
  });

  it('retains original debit basis when current channel & tax change', () => {
    const i = fixture(0, false), input = stack(5000, false);
    input.pricesIncludeTax = true; input.promotions = []; input.couponCodes = [];
    const ordinary = snapshot(input); i.ordinary = ordinary.saved; i.ordinaryUnitFacts = ordinary.ordinaryUnitFacts;
    const saved = buildCurrentCreditPricingSnapshot(i);
    expect(saved.credit.basis).toBe('net');
    expect(saved.lines[0]!.lineNet).toBe(199);
    expect(saved.lines[0]!.lineGross).toBe(299);
    expect(saved.lines[0]!.cashRefundGrossUnits).toEqual(i.origin.selectedCredit!.allocation[LINE]!.map(n => Math.round((100 - n) * 1.5)));
  });

  it('freezes refunded original custody so a no-price edit keeps 199 instead of inventing restored credit due', () => {
    const i = fixture(0);
    const noShipping = stack(0); noShipping.shipping = 0;
    const origin = snapshot(noShipping).saved, ordinary = snapshot({ ...noShipping, promotions: [], couponCodes: [] });
    i.origin = origin; i.ordinary = ordinary.saved; i.ordinaryUnitFacts = ordinary.ordinaryUnitFacts;
    i.lineage.predecessorSnapshotDigest = creditReturnSnapshotDigest(origin);
    const returned = planCreditUnitReturn({ ...i.evidence, orderLineId: LINE, originalIndexes: [0],
      operation: { kind: 'manual_return', id: 'native-return' } });
    if (!returned.ok || !returned.posting) throw new Error('Expected return posting');
    i.evidence.history = [{ ...returned.posting, id: 'posted-return' }];
    i.predecessor = readCurrentOrderPricingSnapshot(origin, { ...context(i), creditEvidence: i.evidence })!;
    i.lineage.consumedUnitIds = [i.unitIds[LINE]![0]!];
    const saved = buildCurrentCreditPricingSnapshot(i);
    expect(saved.totals.grandTotal).toBe(199);
    expect(saved.unitEconomics[LINE]![0]).toEqual(i.predecessor.unitEconomics[LINE]![0]);
    expect(saved.credit.allocation[LINE]![0]).toBe(0);
    expect(saved.originalUnitIndexes[LINE]).toEqual([0, 1, 2]);
    const targets = currentCreditFundingTargets(i.ordinary, i.originalUnitIndexes, 'net', i.ordinaryUnitFacts,
      { consumedPositions: i.predecessor.consumedPositions });
    expect(targets[0]!.units[0]).toMatchObject({ originalIndex: 0, consumed: true });
    const read = readCurrentOrderPricingSnapshot(saved, context(i, saved))!;
    expect(read.consumedPositions[LINE]).toEqual([0]);
    const lowered = snapshot({ ...noShipping, promotions: [], couponCodes: [], lines: [{ ...noShipping.lines[0]!, unitListPrice: 0 }] });
    const next = { ...i, ordinary: lowered.saved, ordinaryUnitFacts: lowered.ordinaryUnitFacts, predecessor: read,
      lineage: { editId: NEW, predecessorSnapshotDigest: creditReturnSnapshotDigest(saved), consumedUnitIds: [i.unitIds[LINE]![0]!] } };
    const effects = planEditCreditFunding({ ...next.evidence, editId: NEW,
      lines: currentCreditFundingTargets(next.ordinary, next.originalUnitIndexes, 'net', next.ordinaryUnitFacts, { consumedPositions: read.consumedPositions }) });
    if (!effects.ok || effects.replay) throw new Error('Expected lower-price correction');
    next.evidence = { ...i.evidence, history: [...i.evidence.history, ...posted(effects.postings)] };
    const lowerSaved = buildCurrentCreditPricingSnapshot(next);
    expect(lowerSaved.totals.discountTotal).toBe(-i.predecessor.unitEconomics[LINE]![0]!.net);
    expect(lowerSaved.totals.grandTotal).toBe(i.predecessor.unitEconomics[LINE]![0]!.gross);
    expect(lowerSaved.unitEconomics[LINE]![0]).toEqual(saved.unitEconomics[LINE]![0]);
  });

  it('retains refunded null unit ID, economics & reservation across reorder and blocks forged source custody', () => {
    const i = fixture(0), expanded = stack(0); expanded.lines[0]!.quantity = 4;
    const ordinary = snapshot({ ...expanded, promotions: [], couponCodes: [] });
    i.ordinary = ordinary.saved; i.ordinaryUnitFacts = ordinary.ordinaryUnitFacts;
    const born = `edit:${EDIT}:${LINE}:0`;
    i.originalUnitIndexes[LINE] = [0, 1, 2, null]; i.unitIds[LINE]!.push(born);
    const first = buildCurrentCreditPricingSnapshot(i), position = 3, econ = first.unitEconomics[LINE]![position]!;
    const payload = { version: 2 as const, redemptionId: REDEEM, snapshotHash: first.quoteHash,
      snapshotDigest: creditReturnSnapshotDigest(first), lines: [{ orderLineId: LINE, positions: [position], unitIds: [born],
        originalIndexes: [null], creditCents: [0], unitEconomics: [econ] }] };
    const refund: CreditRefundEvidence = { id: NEW, state: 'Settled', metadata: { creditUnitReturns: {
      ...payload, requestDigest: creditReturnSnapshotDigest(payload) } }, lines: [{ orderLineId: LINE, quantity: 1, amount: econ.cashRefundGross }] };
    i.evidence.refunds = [refund];
    const predecessor = readCurrentOrderPricingSnapshot(first, context(i, first))!;
    expect(predecessor.consumedPositions[LINE]).toEqual([3]);
    const next = { ...i, predecessor, unitIds: { [LINE]: [born, ...i.unitIds[LINE]!.slice(0, 3)] },
      originalUnitIndexes: { [LINE]: [null, 0, 1, 2] },
      lineage: { editId: NEW, predecessorSnapshotDigest: creditReturnSnapshotDigest(first), consumedUnitIds: [born] } };
    const second = buildCurrentCreditPricingSnapshot(next);
    expect(second.unitEconomics[LINE]![0]).toEqual(econ);
    expect(second.totals).toEqual(first.totals);
    const read = readCurrentOrderPricingSnapshot(second, { ...context(next), pricingSources: [sourceRow(first), sourceRow(second, first, [], predecessor)] })!;
    expect(read.consumedPositions[LINE]).toEqual([0]);
    const tampered = structuredClone(predecessor); tampered.unitEconomics[LINE]![3]!.net += 1;
    expect(() => buildCurrentCreditPricingSnapshot({ ...next, predecessor: tampered })).toThrow('normalized predecessor');
    const bad = structuredClone(refund), frozen = (bad.metadata as { creditUnitReturns: typeof payload & { requestDigest: string } }).creditUnitReturns;
    frozen.lines[0]!.unitEconomics[0]!.net += 1;
    const { requestDigest: _old, ...badPayload } = frozen; frozen.requestDigest = creditReturnSnapshotDigest(badPayload);
    expect(() => readCurrentOrderPricingSnapshot(first, { ...context(i, first), creditEvidence: { ...i.evidence, refunds: [bad] } })).toThrow('source economics');
    expect(() => readCurrentOrderPricingSnapshot(first, { ...context(i), pricingSources: [] })).toThrow('custody');
    const badRow = sourceRow(first); badRow.settlement.activationReceipt.activatedSnapshotHash = '0'.repeat(64);
    expect(() => readCurrentOrderPricingSnapshot(first, { ...context(i), pricingSources: [badRow] })).toThrow('receipt');
  });

  it('joins each posted refund restore to its exact settled frozen selection', () => {
    const i = fixture(0), source = readCurrentOrderPricingSnapshot(i.origin, context(i))!;
    const returned = planCreditUnitReturn({ ...i.evidence, orderLineId: LINE, originalIndexes: [1],
      operation: { kind: 'refund', id: NEW } });
    if (!returned.ok || !returned.posting) throw new Error('Expected linked return posting');
    i.evidence.history = [{ ...returned.posting, id: 'posted-refund' }];
    const frozenRefund = (index: number, state = 'Settled'): CreditRefundEvidence => {
      const economics = source.unitEconomics[LINE]![index]!;
      const payload = { version: 2 as const, redemptionId: REDEEM, snapshotHash: source.quoteHash,
        snapshotDigest: creditReturnSnapshotDigest(i.origin), lines: [{ orderLineId: LINE, positions: [index],
          unitIds: [source.unitIds[LINE]![index]!], originalIndexes: [index],
          creditCents: [i.origin.selectedCredit!.allocation[LINE]![index]!], unitEconomics: [economics] }] };
      return { id: NEW, state, metadata: { creditUnitReturns: { ...payload, requestDigest: creditReturnSnapshotDigest(payload) } },
        lines: [{ orderLineId: LINE, quantity: 1, amount: economics.cashRefundGross }] };
    };
    i.evidence.refunds = [frozenRefund(1)];
    expect(readCurrentOrderPricingSnapshot(i.origin, context(i))!.consumedPositions[LINE]).toEqual([1]);
    expect(i.origin.selectedCredit!.allocation[LINE]![1]).toBe(i.origin.selectedCredit!.allocation[LINE]![2]);
    for (const refunds of [[], [frozenRefund(1, 'Failed')], [frozenRefund(1, 'Pending')], [frozenRefund(2)]]) {
      expect(() => readCurrentOrderPricingSnapshot(i.origin, { ...context(i), creditEvidence: { ...i.evidence, refunds } })).toThrow(/restoration|refund selection/);
    }
    const wrongCents = frozenRefund(1), frozen = (wrongCents.metadata as { creditUnitReturns: CreditUnitReturnsV2 }).creditUnitReturns;
    frozen.lines[0]!.creditCents[0]! -= 1;
    const { requestDigest: _old, ...payload } = frozen; frozen.requestDigest = creditReturnSnapshotDigest(payload);
    expect(() => readCurrentOrderPricingSnapshot(i.origin, { ...context(i), creditEvidence: { ...i.evidence, refunds: [wrongCents] } })).toThrow('unit closure');
  });
});
