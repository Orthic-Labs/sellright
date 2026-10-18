import { describe, expect, it } from 'vitest';
import { calculatePromotionStack, type StackInput, type StackLine, type ResolvedPromotion } from '../money/promotion-stack.js';
import { buildOrderPricingSnapshot, readOrderPricingSnapshot } from '../money/pricing-snapshot.js';
import { priceOrderEditStack, type OrderEditStackInput, type EditStackWorkingLine } from './order-edit-stack.js';

const A = 'cccccccc-0000-4000-8000-000000000001';
const B = 'cccccccc-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const D = 'cccccccc-0000-4000-8000-000000000004';
const ACCOUNT = 'cccccccc-0000-4000-8000-000000000005';
const line = (key: string, patch: Partial<StackLine> = {}): StackLine => ({ key, quantity: 1, placedQuantity: 1,
  unitListPrice: 101, priceIncludesTax: false, taxRateBps: 0, ...patch });
const promo = (patch: Partial<ResolvedPromotion> = {}): ResolvedPromotion => ({ id: 'half', code: 'HALF', kind: 'percentage',
  scope: 'order', value: 50, priority: 0, sequence: 0, freeShipping: false, conditions: [], ...patch });
function fixture(patch: Partial<StackInput> = {}): StackInput {
  return { lines: [line('a'), line('b')], promotions: [promo(), promo({ id: 'one', code: 'ONE', kind: 'fixed', value: 1, priority: 1, sequence: 1 })],
    couponCodes: ['HALF', 'ONE'], currency: 'USD', phase: 'PaymentSettled', pricesIncludeTax: false,
    shipping: 10, shippingTaxRateBps: 0, shippingIncludesTax: false, pointsDiscount: 0, adjustments: [],
    couponContext: { activeVerifications: [] }, ...patch };
}
function request(input = fixture(), snapshot = false): OrderEditStackInput {
  const result = calculatePromotionStack(input);
  const orderLines = input.lines.map((item, index) => ({ key: item.key, id: [A, B][index]!, quantity: item.quantity }));
  const { lines: _lines, phase: _phase, currency: _currency, ...pricing } = input;
  return { before: { basis: snapshot ? { kind: 'snapshot', snapshot: buildOrderPricingSnapshot(input, result, new Map(orderLines.map(item => [item.key, item.id]))) }
    : { kind: 'imported', input: structuredClone(input), result: structuredClone(result) },
    currency: input.currency, orderLines, totals: result, economicHash: result.quoteHash }, creditLedgerEvidence: [],
    lines: input.lines.map(item => ({ key: item.key, quantity: item.quantity, change: 'untouched' })), pricing: structuredClone(pricing) as OrderEditStackInput['pricing'] };
}
function refreshed(item: StackLine, quantity: number): EditStackWorkingLine {
  const { key, quantity: _old, ...basis } = item;
  return { key, quantity, change: 'touched', basis };
}
const refusal = (input: OrderEditStackInput, code = 'ORDER_EDIT_STACK_BASIS_INVALID') => {
  expect(() => priceOrderEditStack(input)).toThrow(expect.objectContaining({ code }));
};

describe('pure ordinary-promotion order edit candidate', () => {
  it.each([false, true])('recomputes complete coupon stack once from untouched bases (snapshot=%s)', snapshot => {
    const input = request(fixture(), snapshot);
    const saved = structuredClone(input);
    const result = priceOrderEditStack(input);
    expect(result.couponCodes).toEqual(['HALF', 'ONE']);
    expect(result.result).toMatchObject({ subtotal: 202, discountTotal: 102, shippingTotal: 10, grandTotal: 110, selectedCredit: null });
    expect(result.result.applied.map(entry => entry.promotionId)).toEqual(['half', 'one']);
    expect(result.result.applied[0]!.lineAllocations.map(part => part.units)).toEqual([[-50], [-51]]);
    expect([...result.perLine.values()].map(item => [item.unitPrice, item.lineTotal])).toEqual([[101, 51], [101, 49]]);
    expect(result.beforeEconomicHash).toBe(result.afterEconomicHash);
    expect(result.balance).toBe(0);
    expect(input).toEqual(saved);
  });

  it('preserves untouched price basis while touched/new lines use refreshed exact list prices', () => {
    const input = request();
    input.lines[1] = refreshed(line('b', { unitListPrice: 137, placedQuantity: 2, taxRateBps: 875 }), 2);
    input.lines.push({ key: 'new:0', quantity: 3, change: 'new', basis: { placedQuantity: 3, unitListPrice: 103, priceIncludesTax: true, taxRateBps: 2000 } });
    const result = priceOrderEditStack(input);
    expect(result.input.lines.map(item => item.unitListPrice)).toEqual([101, 137, 103]);
    expect([...result.perLine.values()].map(item => item.unitPrice)).toEqual([101, 137, 103]);
    expect(result.input.lines[1]).toMatchObject({ quantity: 2, placedQuantity: 2, taxRateBps: 875 });
    expect(result.afterEconomicHash).not.toBe(result.beforeEconomicHash);
    expect(result.balance).toBe(result.result.grandTotal - input.before.totals.grandTotal);
  });

  it('removes ordinary coupons without retaining their generated prior discounts', () => {
    const input = request(fixture(), true);
    input.pricing.couponCodes = []; input.pricing.promotions = [];
    const result = priceOrderEditStack(input);
    expect(result.result).toMatchObject({ subtotal: 202, discountTotal: 0, grandTotal: 212, applied: [] });
    expect(result.couponCodes).toEqual([]);
    expect(result.balance).toBe(102);
  });

  it('keeps mixed inclusive/exclusive tax line facts & rounded units separate from line averages', () => {
    const input = request(fixture({ lines: [line('a', { unitListPrice: 1, quantity: 2, placedQuantity: 2, taxRateBps: 5000 }),
      line('b', { unitListPrice: 120, priceIncludesTax: true, taxRateBps: 2000 })], promotions: [], couponCodes: [], shipping: 0 }));
    const result = priceOrderEditStack(input);
    expect(result.result).toMatchObject({ subtotal: 102, discountTotal: 0, taxTotal: 21, grandTotal: 123 });
    expect(result.result.lineSnapshots).toEqual([
      { lineKey: 'a', quantity: 2, proratedUnitPriceWithTax: 2, lineNet: 2, lineGross: 3 },
      { lineKey: 'b', quantity: 1, proratedUnitPriceWithTax: 120, lineNet: 100, lineGross: 120 },
    ]);
    expect(result.perLine.get('a')!.unitPrice).toBe(1);
  });

  it('retains placed-quantity provenance on reductions & explicit zero-money rows', () => {
    const input = request(fixture({ lines: [line('a', { quantity: 3, placedQuantity: 3 }), line('b')],
      promotions: [promo({ kind: 'fixed', value: 101 })], couponCodes: ['HALF'], shipping: 0 }));
    input.lines = [refreshed(line('a', { placedQuantity: 3 }), 1), refreshed(line('b'), 0)];
    const result = priceOrderEditStack(input);
    expect(result.input.lines.map(item => [item.quantity, item.placedQuantity])).toEqual([[1, 3], [0, 1]]);
    expect(result.result.applied[0]!.lineAllocations[0]).toMatchObject({ lineKey: 'a', sourceAdjustmentAmount: -101, amount: -34, units: [-34] });
    expect(result.result.grandTotal).toBe(67);
    expect(result.perLine.get('b')).toMatchObject({ quantity: 0, lineSubtotal: 0, lineDiscount: 0, lineTotal: 0 });
  });

  it('applies signed order adjustments & points exactly once', () => {
    const input = request(fixture({ lines: [line('a', { unitListPrice: 101 })], promotions: [promo()], couponCodes: ['HALF'],
      shipping: 0, pointsDiscount: 1, adjustments: [{ label: 'Manual credit', amount: -2 }] }));
    const result = priceOrderEditStack(input);
    expect(result.result).toMatchObject({ subtotal: 101, discountTotal: 51, pointsDiscount: 1, adjustmentTotal: -2, grandTotal: 48 });
    expect(result.result.applied[0]!.amount).toBe(-50);
  });

  it('binds item eligibility facts to logical line identities, beyond aggregate quantity', () => {
    const items = [
      { lineKey: 'a', quantity: 1, productId: 'eligible', tags: [], collectionIds: [] },
      { lineKey: 'b', quantity: 1, productId: 'other', tags: [], collectionIds: [] },
    ];
    const input = request(fixture({ promotions: [promo({ conditions: [{ code: 'at_least_n_products', args: [{ name: 'productIds', value: '["eligible"]' }] }] })],
      couponCodes: ['HALF'], couponContext: { activeVerifications: [], items } }));
    expect(priceOrderEditStack(input).result.applied).toHaveLength(1);
    input.pricing.couponContext.items![1]!.lineKey = 'a'; refusal(input);
    input.pricing.couponContext.items![1]!.lineKey = 'unrelated'; refusal(input);
  });

  it('keeps new logical keys & persisted UUIDs outside economic hashes, then binds snapshot bijectively', () => {
    const first = request();
    first.lines.push({ key: 'new:0', quantity: 2, change: 'new', basis: { placedQuantity: 2, unitListPrice: 107, priceIncludesTax: false, taxRateBps: 875 } });
    const second = structuredClone(first); second.lines[2]!.key = 'other-provisional-key';
    const a = priceOrderEditStack(first); const b = priceOrderEditStack(second);
    expect(a.afterEconomicHash).toBe(b.afterEconomicHash);
    const sa = buildOrderPricingSnapshot(a.snapshotDraft.input, a.snapshotDraft.result, new Map([['a', A], ['b', B], ['new:0', C]]));
    const sb = buildOrderPricingSnapshot(b.snapshotDraft.input, b.snapshotDraft.result, new Map([['a', B], ['b', A], ['other-provisional-key', D]]));
    expect(sa.quoteHash).toBe(sb.quoteHash);
    expect(sa.lines[2]!.orderLineId).toBe(C); expect(sb.lines[2]!.orderLineId).toBe(D);
    expect(readOrderPricingSnapshot(sa, { currency: 'USD', orderLines: sa.lines.map(item => ({ id: item.orderLineId, quantity: item.quantity })), totals: a.result, mode: 'settlement' })).toEqual(sa);
  });

  it.each(['order', 'item'] as const)('refuses retained generated %s adjustments instead of double-discounting', kind => {
    const input = request();
    const touched = refreshed(line('a'), 1);
    if (touched.change !== 'untouched') touched.basis.priorAdjustments = [{ kind, amount: -50, units: [-50], promotionId: 'half' }];
    input.lines[0] = touched; refusal(input);
  });

  it('accepts independently retained item vectors, rejecting incomplete vector provenance', () => {
    const input = request(fixture({ lines: [line('a', { priorAdjustments: [{ kind: 'item', amount: -1, units: [-1] }] })] }));
    expect(priceOrderEditStack(input).input.lines[0]!.priorAdjustments).toEqual([{ kind: 'item', amount: -1, units: [-1] }]);
    const touched = refreshed(line('a', { priorAdjustments: [{ kind: 'item', amount: -1, units: [] }] }), 1);
    input.lines = [touched]; refusal(input);
  });

  it('refuses stored drift, unbound hashes & incomplete native/logical line closure', () => {
    const cases: Array<(input: OrderEditStackInput) => void> = [
      input => { input.before.totals.grandTotal += 1; },
      input => { input.before.economicHash = '0'.repeat(64); },
      input => { input.before.orderLines.pop(); },
      input => { input.before.orderLines[0]!.key = 'other'; },
      input => { input.lines.pop(); },
      input => { input.lines.push(structuredClone(input.lines[0]!)); },
      input => { input.lines[0]!.quantity += 1; },
      input => { input.pricing.couponCodes = ['HALF', 'half']; },
      input => { input.pricing.couponCodes.push('UNRESOLVED'); },
      input => { input.pricing.pointsDiscount = undefined; },
      input => { input.pricing.couponContext.items = []; },
      input => { input.pricing.promotions[0]!.conditions = [{ code: 'minimum_order_amount', args: [{ name: 'amount', value: 'not money' }] }]; },
      input => { input.pricing.promotions[0]!.conditions = [{ code: 'verified_customer', args: [{ name: 'categories', value: '[invalid json' }] }]; },
    ];
    for (const mutate of cases) { const input = request(); mutate(input); refusal(input); }
    const snapshot = request(fixture(), true);
    if (snapshot.before.basis.kind === 'snapshot') (snapshot.before.basis.snapshot as { lines: StackLine[] }).lines[0]!.unitListPrice += 1;
    refusal(snapshot);
    const incomplete = request(fixture(), true);
    if (incomplete.before.basis.kind === 'snapshot') delete (incomplete.before.basis.snapshot as Partial<{ selectedCredit: null }>).selectedCredit;
    refusal(incomplete);
  });

  it('rejects invalid money & missing refreshed tax/placed facts before pricing', () => {
    for (const bad of [NaN, 1.5, -1, 2_147_483_648]) {
      const input = request(); input.lines[0] = refreshed(line('a', { unitListPrice: bad }), 1); refusal(input);
    }
    const input = request(); input.lines[0] = refreshed(line('a'), 2);
    if (input.lines[0].change !== 'untouched') delete (input.lines[0].basis as Partial<StackLine>).placedQuantity;
    refusal(input);
  });

  it('refuses every credit admission surface without inferring balances or eligibility', () => {
    const CREDIT = 'ORDER_EDIT_STACK_CREDIT_UNSUPPORTED';
    const cases: Array<(input: OrderEditStackInput) => void> = [
      input => { input.creditLedgerEvidence = [{ kind: 'RESERVE', status: 'VOID' }]; },
      input => { input.pricing.promotions[0]!.kind = 'account_credit'; },
      input => { input.pricing.promotions[0]!.credit = { accountId: ACCOUNT, availableCents: 0 }; },
      input => { input.pricing.promotions[0]!.conditions = [{ code: 'account_credit_eligible', args: [] }]; },
      input => { if (input.before.basis.kind !== 'snapshot') input.before.basis.input.promotions[0]!.kind = 'account_credit'; },
      input => { if (input.before.basis.kind !== 'snapshot') input.before.basis.result.applied[0]!.kind = 'account_credit'; },
      input => { if (input.before.basis.kind !== 'snapshot') input.before.basis.result.selectedCredit = { accountId: ACCOUNT, promotionId: A, appliedAmount: 1, allocation: {} }; },
      input => { if (input.before.basis.kind !== 'snapshot') input.before.basis.result.resolvedPromotions![0]!.credit = { accountId: ACCOUNT, availableCents: 0 }; },
    ];
    for (const mutate of cases) { const input = request(); mutate(input); refusal(input, CREDIT); }
    const creditInput = fixture({ lines: [line('a')], promotions: [promo({ id: A, kind: 'account_credit', value: 0, credit: { accountId: ACCOUNT, availableCents: 1 } })], couponCodes: ['HALF'] });
    refusal(request(creditInput, true), CREDIT);
    const missing = request(); delete (missing as Partial<OrderEditStackInput>).creditLedgerEvidence; refusal(missing);
  });
});
