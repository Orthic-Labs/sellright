import { describe, expect, it } from 'vitest';
import { planEditCreditFunding, type EditFundingHistoryRow, type EditFundingRedemption } from '../account-credit/edit-funding.js';
import { calculatePromotionStack, type StackInput } from './promotion-stack.js';
import { buildOrderPricingSnapshot, readOrderPricingSnapshot } from './pricing-snapshot.js';
import { buildCurrentCreditPricingSnapshot, currentCreditFundingTargets, currentCreditPricingHash,
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
function fixture(tax = 875, inclusive = false): BuildCurrentCreditPricingInput {
  const input = stack(tax, inclusive), origin = snapshot(input).saved;
  const ordinary = snapshot({ ...input, promotions: [], couponCodes: [] });
  const redemption: EditFundingRedemption = { id: REDEEM, orderId: ORDER, accountCreditId: ACCOUNT, kind: 'REDEEM', status: 'POSTED',
    amount: 101, delta: -101, operationalAllocation: structuredClone(origin.selectedCredit!.allocation) };
  return { origin, ordinary: ordinary.saved, ordinaryUnitFacts: ordinary.ordinaryUnitFacts, couponCodes: ['CREDIT'],
    evidence: { redemption, history: [], historyComplete: true }, originalUnitIndexes: { [LINE]: [0, 1, 2] } };
}
function context(i: BuildCurrentCreditPricingInput) {
  return { currency: 'USD', orderLines: i.ordinary.lines.map(l => ({ id: l.orderLineId, quantity: l.quantity })),
    mode: 'settlement' as const, creditEvidence: i.evidence };
}
function plan(i: BuildCurrentCreditPricingInput) {
  const result = planEditCreditFunding({ ...i.evidence, editId: EDIT,
    lines: currentCreditFundingTargets(i.ordinary, i.originalUnitIndexes, i.origin.pricesIncludeTax ? 'gross' : 'net', i.ordinaryUnitFacts) });
  if (!result.ok || result.replay) throw new Error('Expected fresh funding plan');
  return result;
}
const posted = (p: ReturnType<typeof plan>['postings']): EditFundingHistoryRow[] => p.map(row => ({ ...row, id: row.idempotencyKey }));

describe('current edited credit pricing proof', () => {
  it.each([[0, false], [875, false], [5000, false], [875, true], [5000, true]] as const)(
    'preserves unchanged aggregate placement prices at tax %i inclusive %s', (tax, inclusive) => {
      const i = fixture(tax, inclusive), saved = buildCurrentCreditPricingSnapshot(i);
      expect(saved.totals).toEqual(i.origin.totals);
      expect(saved.lines.map(l => [l.lineNet, l.lineGross])).toEqual(i.origin.lines.map(l => [l.lineNet, l.lineGross]));
      expect(saved.credit.allocation).toEqual(i.origin.selectedCredit!.allocation);
      expect(saved.credit.basis).toBe(inclusive ? 'gross' : 'net');
      expect(readCurrentOrderPricingSnapshot(JSON.parse(JSON.stringify(saved)), { ...context(i), totals: saved.totals })?.snapshot).toEqual(saved);
      expect(readOrderPricingSnapshot(i.origin, { ...context(i), totals: i.origin.totals })).toEqual(i.origin);
    });

  it('keeps uneven original funding on original units & new positions fully cash priced', () => {
    const i = fixture(0), input = stack(0);
    input.lines[0]!.quantity = 4;
    const ordinary = snapshot({ ...input, promotions: [], couponCodes: [] });
    i.ordinary = ordinary.saved; i.ordinaryUnitFacts = ordinary.ordinaryUnitFacts;
    i.originalUnitIndexes[LINE] = [2, null, 0, 1];
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
    expect(() => readCurrentOrderPricingSnapshot(saved, { ...context(i), creditEvidence: { ...i.evidence, history: [] } })).toThrow('absent');
    const changed = structuredClone(i.evidence); changed.history[0]!.amount += 1;
    expect(() => readCurrentOrderPricingSnapshot(saved, { ...context(i), creditEvidence: changed })).toThrow('digest');
    expect(() => readCurrentOrderPricingSnapshot(saved, { ...context(i), creditEvidence: { ...i.evidence, historyComplete: false } as never })).toThrow('Complete');
  });

  it('allows later merchandise RESTOREs without rewriting saved prices or activation allocation', () => {
    const i = fixture(0), saved = buildCurrentCreditPricingSnapshot(i);
    const later = structuredClone(i); later.originalUnitIndexes[LINE] = [1, 2];
    const ordinary = snapshot({ ...stack(0), promotions: [], couponCodes: [], lines: [{ ...stack(0).lines[0]!, quantity: 2 }] });
    later.ordinary = ordinary.saved; later.ordinaryUnitFacts = ordinary.ordinaryUnitFacts;
    const effects = plan(later), history = posted(effects.postings);
    const read = readCurrentOrderPricingSnapshot(saved, { ...context(i), mode: 'refund',
      orderLines: [{ id: LINE, quantity: 2 }], creditEvidence: { ...i.evidence, history } })!;
    expect(read.lines).toEqual(saved.lines); expect(read.totals).toEqual(saved.totals);
    expect(read.selectedCredit!.allocation).toEqual(saved.credit.allocation);
    expect(read.liveAllocation[LINE]).toEqual([0, saved.credit.allocation[LINE]![1], saved.credit.allocation[LINE]![2]]);
    expect(read.fundingState!.restored).toBe(i.origin.selectedCredit!.allocation[LINE]![0]);
    later.evidence.history = history;
    const next = buildCurrentCreditPricingSnapshot(later);
    expect(next.originalUnitIndexes[LINE]).toEqual([1, 2]);
    later.originalUnitIndexes[LINE] = [0, 2];
    expect(() => buildCurrentCreditPricingSnapshot(later)).toThrow('reattached');
  });

  it('rejects transferred, duplicated, omitted & forged identities or producer pricing', () => {
    for (const indexes of [[0, 0, 2], [0, null, 2], [0, 1, 99]]) {
      const i = fixture(); i.originalUnitIndexes[LINE] = indexes;
      expect(() => buildCurrentCreditPricingSnapshot(i)).toThrow(/index/);
    }
    const i = fixture(); i.ordinary.lines[0]!.orderLineId = NEW;
    expect(() => buildCurrentCreditPricingSnapshot(i)).toThrow();
    const bad = fixture(); bad.ordinaryUnitFacts[LINE]!.sourceAdjustmentTotal = -1;
    expect(() => buildCurrentCreditPricingSnapshot(bad)).toThrow('provenance');
    const forged = fixture(); forged.evidence.redemption.operationalAllocation![LINE]!.reverse();
    expect(() => buildCurrentCreditPricingSnapshot(forged)).toThrow('origin');
    const saved = buildCurrentCreditPricingSnapshot(fixture()); saved.lines[0]!.cashRefundGrossUnits.reverse();
    saved.quoteHash = currentCreditPricingHash(saved);
    expect(() => readCurrentOrderPricingSnapshot(saved, context(fixture()))).toThrow('facts/hash');
  });

  it('uses genuine source facts including points & leaves V1 refund rounding unchanged', () => {
    const input = stack(875); input.promotions = []; input.couponCodes = []; input.pointsDiscount = 11;
    const ordinary = snapshot(input);
    expect(ordinary.ordinaryUnitFacts[LINE]).toEqual({ sourceAdjustmentTotal: -11, sourceAdjustmentDivisor: 3 });
    const i = fixture(); i.ordinary = ordinary.saved; i.ordinaryUnitFacts = ordinary.ordinaryUnitFacts;
    const saved = buildCurrentCreditPricingSnapshot(i);
    expect(readCurrentOrderPricingSnapshot(saved, context(i))?.lines).toEqual(saved.lines);
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
});
