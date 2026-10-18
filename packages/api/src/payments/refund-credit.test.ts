import { describe, expect, it } from 'vitest';
import { refundLineCashAmount, refundUnitBases, proveCreditMerchandiseReturn, refundCreditProjection, prepareCreditUnitReturns, readCreditUnitReturns } from './refund-credit.js';
import { buildCurrentCreditPricingSnapshot, readCurrentOrderPricingSnapshot } from '../money/current-credit-pricing.js';
import { planCreditUnitReturn, originalCreditUnitId, creditReturnSnapshotDigest } from '../account-credit/edit-funding.js';
import { buildOrderPricingSnapshot } from '../money/pricing-snapshot.js';
import { calculatePromotionStack, type StackInput } from '../money/promotion-stack.js';

const id = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const imported = (overrides: Record<string, unknown> = {}) => ({ id, quantity: 3, unitPrice: 100, lineTotal: 299,
  metadata: { vendure: { quantity: 3, placedQuantity: 3, listPrice: 100, listPriceIncludesTax: true,
    adjustments: [{ amount: -1, type: 'PROMOTION' }], taxLines: [], ...overrides } } });
const redeem = { id: '33333333-3333-4333-8333-333333333333', accountCreditId: '44444444-4444-4444-8444-444444444444', orderId: '55555555-5555-4555-8555-555555555555', kind: 'REDEEM', status: 'POSTED', amount: 101, delta: -101, operationalAllocation: { [id]: [0, 50, 51] } };
const selection = (quantity = 1) => [{ orderLineId: id, quantity }];
const currentSnapshot = (lines: Array<{ id: string; unitListPrice: number; quantity: number }>) => {
  const input: StackInput = { currency: 'USD', pricesIncludeTax: true, couponCodes: [], phase: 'PaymentSettled',
    lines: lines.map(line => ({ key: line.id, quantity: line.quantity, placedQuantity: line.quantity, unitListPrice: line.unitListPrice,
      priceIncludesTax: true, taxRateBps: 0 })), promotions: [], shipping: 0, shippingTaxRateBps: 0,
    shippingIncludesTax: true, couponContext: { activeVerifications: [] } };
  return buildOrderPricingSnapshot(input, calculatePromotionStack(input), new Map(lines.map(line => [line.id, line.id])));
};

describe('refund cash unit & independent credit unit authority', () => {
  it('rounds imported gross UNIT before multiplying selected quantity', () => {
    const line = imported(); const unit = refundUnitBases({ currency: 'USD', pricingSnapshot: null }, [line]).get(id)!;
    expect(unit).toBe(100);
    expect(refundLineCashAmount(line, 3, unit, true)).toBe(300); // line projection is 299
  });
  it('uses placed quantity after source cancellation & source gross tax conversion', () => {
    const line = { ...imported({ quantity: 1, placedQuantity: 3, listPriceIncludesTax: false, adjustments: [{ amount: -30 }], taxLines: [{ taxRate: 10 }] }), quantity: 1 };
    expect(refundUnitBases({ currency: 'USD', pricingSnapshot: null }, [line]).get(id)).toBe(99);
    expect(refundUnitBases({ currency: 'USD', pricingSnapshot: null }, [imported({ placedQuantity: 0 })]).get(id)).toBe(0);
  });
  it('uses validated native frozen units & refuses a changed economic hash', () => {
    const input: StackInput = { currency: 'USD', pricesIncludeTax: true, couponCodes: [], phase: 'PaymentSettled',
      lines: [{ key: 'line', quantity: 3, placedQuantity: 3, unitListPrice: 100, priceIncludesTax: true, taxRateBps: 0,
        priorAdjustments: [{ kind: 'order', amount: -1 }] }], promotions: [], shipping: 0, shippingTaxRateBps: 0,
      shippingIncludesTax: true, couponContext: { activeVerifications: [] } };
    const snapshot = buildOrderPricingSnapshot(input, calculatePromotionStack(input), new Map([['line', id]]));
    const line = { id, quantity: 2, unitPrice: 100, lineTotal: 199 };
    expect(refundUnitBases({ currency: 'USD', pricingSnapshot: snapshot }, [line]).get(id)).toBe(100);
    snapshot.lines[0]!.proratedUnitPriceWithTax = 99;
    expect(() => refundUnitBases({ currency: 'USD', pricingSnapshot: snapshot }, [line])).toThrow();
  });
  it('uses validated current snapshot for every all-imported line over retained source units', () => {
    const lines = [imported(), { ...imported(), id: secondId }];
    const snapshot = currentSnapshot([{ id, quantity: 3, unitListPrice: 200 }, { id: secondId, quantity: 3, unitListPrice: 300 }]);
    expect(refundUnitBases({ currency: 'USD', pricingSnapshot: snapshot }, lines)).toEqual(new Map([[id, 200], [secondId, 300]]));
  });
  it('uses one validated current snapshot across mixed imported & native lines', () => {
    const lines = [imported(), { id: secondId, quantity: 3, unitPrice: 1000, lineTotal: 3000 }];
    const snapshot = currentSnapshot([{ id, quantity: 3, unitListPrice: 250 }, { id: secondId, quantity: 3, unitListPrice: 400 }]);
    expect(refundUnitBases({ currency: 'USD', pricingSnapshot: snapshot }, lines)).toEqual(new Map([[id, 250], [secondId, 400]]));
  });
  it('refuses malformed nonnull all-imported snapshots & incomplete order-line closure', () => {
    const lines = [imported(), { ...imported(), id: secondId }];
    const snapshot = currentSnapshot([{ id, quantity: 3, unitListPrice: 200 }, { id: secondId, quantity: 3, unitListPrice: 300 }]);
    expect(() => refundUnitBases({ currency: 'USD', pricingSnapshot: snapshot }, [lines[0]!])).toThrow(/line closure/);
    snapshot.quoteHash = 'changed';
    expect(() => refundUnitBases({ currency: 'USD', pricingSnapshot: snapshot }, lines)).toThrow(/economic hash/);
    expect(() => refundUnitBases({ currency: 'USD', pricingSnapshot: {} }, lines)).toThrow();
  });
  it('preserves generic legacy fallback but never treats it as credit proof', () => {
    const line = { id, quantity: 3, unitPrice: 100, lineTotal: 299 };
    expect(refundUnitBases({ currency: 'USD', pricingSnapshot: null }, [line]).get(id)).toBeNull();
    expect(refundLineCashAmount(line, 2, null, false)).toBe(199);
    expect(() => refundLineCashAmount(line, 2, null, true)).toThrow();
    expect(() => refundUnitBases({ currency: 'USD', pricingSnapshot: null }, [imported({ listPrice: '100' })])).toThrow();
  });
  it('accepts a zero-valued selected credit unit & advances exact posted prefix', () => {
    expect(proveCreditMerchandiseReturn(redeem, [], selection())).toEqual({ redemptionId: redeem.id, accountId: redeem.accountCreditId });
    const prior = { id: 'legacy', idempotencyKey: 'legacy', kind: 'RESTORE', status: 'POSTED', orderId: redeem.orderId, accountCreditId: redeem.accountCreditId, relatedTransactionId: redeem.id, orderLineId: id, quantity: 1, amount: 0, delta: 0, allocation: null, operationalAllocation: null };
    expect(proveCreditMerchandiseReturn(redeem, [prior], selection(2))).toEqual({ redemptionId: redeem.id, accountId: redeem.accountCreditId });
    expect(() => proveCreditMerchandiseReturn(redeem, [{ ...prior, amount: 1, delta: 1 }], selection())).toThrow();
    expect(() => proveCreditMerchandiseReturn(redeem, [{ ...prior, orderLineId: null }], selection())).toThrow();
    expect(() => proveCreditMerchandiseReturn(redeem, [{ ...prior, relatedTransactionId: 'other' }], selection())).toThrow();
  });
  it('refuses missing/foreign/unlinked/excess/duplicate merchandise & bad redemption signs', () => {
    expect(() => proveCreditMerchandiseReturn(undefined, [], selection())).toThrow();
    expect(() => proveCreditMerchandiseReturn(redeem, [], [])).toThrow();
    expect(() => proveCreditMerchandiseReturn(redeem, [], [...selection(), ...selection()])).toThrow();
    expect(() => proveCreditMerchandiseReturn(redeem, [], [{ orderLineId: 'other', quantity: 1 }])).toThrow();
    expect(() => proveCreditMerchandiseReturn(redeem, [], selection(4))).toThrow();
    expect(() => proveCreditMerchandiseReturn({ ...redeem, delta: 101 }, [], selection())).toThrow();
    expect(() => proveCreditMerchandiseReturn({ ...redeem, amount: 1, delta: -1 }, [], selection(3))).toThrow();
  });
  it('projects only bounded credit reconciliation facts', () => {
    expect(refundCreditProjection({ creditRestoration: { state: 'posted', amount: 0, private: 'hidden' } })).toEqual({ state: 'posted', amount: 0 });
    expect(refundCreditProjection({ creditRestoration: { state: 'other', amount: 0 } })).toBeNull();
  });
  it('freezes actual reserved position sets & protects digest after JSONB key reordering', () => {
    const order = { currency: 'USD', pricingSnapshot: null }, evidence = { redemption: redeem, history: [], historyComplete: true as const };
    const lines = [imported()];
    const first = prepareCreditUnitReturns(order, lines, evidence, selection(), []);
    const second = prepareCreditUnitReturns(order, lines, evidence, selection(), [{ metadata: { creditUnitReturns: first }, lines: selection() }]);
    expect(first.lines[0]).toMatchObject({ positions: [0], originalIndexes: [0], creditCents: [0] });
    expect(second.lines[0]).toMatchObject({ positions: [1], originalIndexes: [1], creditCents: [50] });
    const olderBase = { version: 1 as const, redemptionId: first.redemptionId, snapshotDigest: 'a'.repeat(64), lines: first.lines };
    const older = { ...olderBase, requestDigest: creditReturnSnapshotDigest(olderBase) };
    // Posted/settled status never releases immutable merchandise identity after
    // repricing moves its capture position or changes snapshot digest.
    expect(prepareCreditUnitReturns(order, lines, evidence, selection(), [{ metadata: { creditUnitReturns: older }, restored: true, state: 'Settled', lines: selection() }]).lines[0]?.positions).toEqual([1]);
    expect(prepareCreditUnitReturns(order, lines, evidence, selection(), [{ metadata: { creditUnitReturns: first }, state: 'Failed', lines: selection() }]).lines[0]?.positions).toEqual([0]);
    // Failed reservations are omitted by caller, so their exact positions release.
    expect(prepareCreditUnitReturns(order, lines, evidence, selection(), [{ metadata: { creditUnitReturns: second }, lines: selection() }]).lines[0]?.positions).toEqual([0]);
    const reordered = { lines: first.lines, requestDigest: first.requestDigest, snapshotDigest: first.snapshotDigest, redemptionId: first.redemptionId, version: first.version };
    expect(readCreditUnitReturns({ creditUnitReturns: reordered })).toEqual(first);
    expect(() => readCreditUnitReturns({ creditUnitReturns: { ...first, lines: [{ ...first.lines[0], creditCents: [1] }] } })).toThrow(/digest/);
  });
  it('sums explicit per-unit cash amounts without averaging edited residuals', () => {
    expect(refundLineCashAmount(imported(), 2, [0, 17], true)).toBe(17);
    expect(() => refundLineCashAmount(imported(), 2, [17], true)).toThrow();
  });

  it('returns uneven edited units by frozen current positions & refuses unfrozen V2 reservations', () => {
    const account = redeem.accountCreditId, promotion = '66666666-6666-4666-8666-666666666666';
    const input: StackInput = { currency: 'USD', pricesIncludeTax: true, couponCodes: ['CREDIT'], phase: 'PaymentSettled',
      lines: [{ key: id, quantity: 3, placedQuantity: 3, unitListPrice: 100, priceIncludesTax: true, taxRateBps: 0 }],
      promotions: [{ id: promotion, code: 'CREDIT', kind: 'account_credit', scope: 'order', value: 0, priority: 0,
        sequence: 1, freeShipping: false, conditions: null, credit: { accountId: account, availableCents: 101 } }],
      shipping: 0, shippingTaxRateBps: 0, shippingIncludesTax: true, couponContext: { activeVerifications: [] } };
    const origin = buildOrderPricingSnapshot(input, calculatePromotionStack(input), new Map([[id, id]]));
    const ordinaryInput = { ...input, couponCodes: [], promotions: [], lines: [{ ...input.lines[0]!, quantity: 4 }] };
    const result = calculatePromotionStack(ordinaryInput);
    const ordinary = buildOrderPricingSnapshot(ordinaryInput, result, new Map([[id, id]]));
    const redemption = { ...redeem, operationalAllocation: origin.selectedCredit!.allocation };
    const evidence = { redemption, history: [], historyComplete: true as const, refunds: [], refundsComplete: true as const };
    const editId = '88888888-8888-4888-8888-888888888888';
    const originView = readCurrentOrderPricingSnapshot(origin, { currency: 'USD', orderLines: origin.lines.map(line => ({ id: line.orderLineId, quantity: line.quantity })),
      mode: 'settlement', creditEvidence: evidence })!;
    const sourceRow = (saved: ReturnType<typeof buildCurrentCreditPricingSnapshot>, predecessor: NonNullable<ReturnType<typeof readCurrentOrderPricingSnapshot>>) => {
      const requestDigest = '0'.repeat(64), postingKeys: string[] = [];
      const payload = { editId: saved.lineage.editId, orderId: redemption.orderId, pricingSnapshot: saved, requestDigest, postingKeys,
        lineIds: Object.fromEntries(saved.lines.map(line => [line.key, line.orderLineId])), activation: {
          unitIds: saved.unitIds, indexes: saved.originalUnitIndexes, predecessor, lineage: saved.lineage,
          origin: saved.origin, ordinary: saved.ordinary, ordinaryUnitFacts: saved.ordinaryUnitFacts } };
      const proposalDigest = creditReturnSnapshotDigest(payload);
      return { id: saved.lineage.editId, orderId: redemption.orderId, before: { currentPricing: predecessor.snapshot },
        after: { activatedPricingSnapshot: saved, proposal: { ...payload, proposalDigest } },
        settlement: { phase: 'activated', activationReceipt: { proposalDigest, requestDigest, postingKeys,
          activatedSnapshotHash: creditReturnSnapshotDigest(saved) } } };
    };
    const snapshot = buildCurrentCreditPricingSnapshot({ origin, ordinary, couponCodes: ['CREDIT'], evidence,
      ordinaryUnitFacts: { [id]: { sourceAdjustmentTotal: result.lineSnapshots[0]!.sourceAdjustmentTotal!,
        sourceAdjustmentDivisor: result.lineSnapshots[0]!.sourceAdjustmentDivisor! } }, originalUnitIndexes: { [id]: [2, null, 0, 1] },
      unitIds: { [id]: [originalCreditUnitId(redemption.id, id, 2), `edit:${editId}:${id}:0`, originalCreditUnitId(redemption.id, id, 0), originalCreditUnitId(redemption.id, id, 1)] },
      lineage: { editId, predecessorSnapshotDigest: creditReturnSnapshotDigest(origin), consumedUnitIds: [] } });
    const pricingSources = [sourceRow(snapshot, originView)];
    const lines = [{ id, quantity: 4, unitPrice: 100, lineTotal: snapshot.lines[0]!.lineGross }];
    const order = { currency: 'USD', pricingSnapshot: snapshot };
    const first = prepareCreditUnitReturns(order, lines, evidence, selection(), [], pricingSources);
    expect(first.lines[0]).toMatchObject({ positions: [0], originalIndexes: [2], creditCents: [33] });
    const basis = refundUnitBases(order, lines, evidence, pricingSources).get(id)!;
    expect(basis).toEqual([67, 100, 66, 66]);
    expect(refundLineCashAmount(lines[0]!, 1, [67], true)).toBe(67);
    expect(() => prepareCreditUnitReturns(order, lines, { ...evidence, refunds: [{ id: '77777777-7777-4777-8777-777777777777', state: 'Pending', metadata: null,
      lines: [{ orderLineId: id, quantity: 1, amount: 67 }] }] }, selection(), [], pricingSources)).toThrow(/frozen/);
    const returned = planCreditUnitReturn({ ...evidence, orderLineId: id, originalIndexes: [2],
      operation: { kind: 'refund', id: '77777777-7777-4777-8777-777777777777' } });
    if (!returned.ok || !returned.posting) throw new Error('Expected indexed return');
    const originalRefund = { id: '77777777-7777-4777-8777-777777777777', state: 'Settled', metadata: { creditUnitReturns: first },
      lines: [{ orderLineId: id, quantity: 1, amount: 67 }] };
    const live = { ...evidence, history: [{ ...returned.posting, id: 'return-row' }], refunds: [originalRefund] };
    const next = prepareCreditUnitReturns(order, lines, live, selection(), [], pricingSources);
    expect(next.lines[0]).toMatchObject({ positions: [1], originalIndexes: [null], creditCents: [0] });
    const cashOnly = { id: '99999999-9999-4999-8999-999999999999', state: 'Settled', metadata: { creditUnitReturns: next },
      lines: [{ orderLineId: id, quantity: 1, amount: 100 }] };
    expect(prepareCreditUnitReturns(order, lines, { ...live, refunds: [originalRefund, cashOnly] }, selection(), [], pricingSources).lines[0]?.positions).toEqual([2]);
    expect(prepareCreditUnitReturns(order, lines, { ...live, refunds: [originalRefund, { ...cashOnly, state: 'Pending' }] }, selection(), [], pricingSources).lines[0]?.positions).toEqual([2]);
    expect(prepareCreditUnitReturns(order, lines, { ...live, refunds: [originalRefund, { ...cashOnly, state: 'Failed' }] }, selection(), [], pricingSources).lines[0]?.positions).toEqual([1]);
    const settled = { ...live, refunds: [originalRefund, cashOnly] };
    const predecessor = readCurrentOrderPricingSnapshot(snapshot, { currency: 'USD', orderLines: lines, mode: 'refund', creditEvidence: settled, pricingSources })!;
    const laterEditId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const later = buildCurrentCreditPricingSnapshot({ origin, ordinary, couponCodes: ['CREDIT'], evidence: settled, predecessor,
      ordinaryUnitFacts: snapshot.ordinaryUnitFacts, originalUnitIndexes: snapshot.originalUnitIndexes, unitIds: snapshot.unitIds,
      lineage: { editId: laterEditId, predecessorSnapshotDigest: creditReturnSnapshotDigest(snapshot),
        consumedUnitIds: [snapshot.unitIds[id]![0]!, snapshot.unitIds[id]![1]!] } });
    const laterSources = [...pricingSources, sourceRow(later, predecessor)];
    expect(prepareCreditUnitReturns({ ...order, pricingSnapshot: later }, lines, settled, selection(), [], laterSources).lines[0]?.positions).toEqual([2]);
    expect(refundUnitBases(order, lines, live, pricingSources).get(id)).toEqual(basis);
  });

});
