import { describe, expect, it } from 'vitest';
import { availableCreditRefundUnits, refundLineCashAmount, refundUnitBases, proveCreditMerchandiseReturn, refundCreditProjection, prepareCreditUnitReturns, readCreditUnitReturns } from './refund-credit.js';
import { buildImportedCreditOrigin } from '../money/imported-credit-origin.js';
import { migrationId } from '../import/context.js';
import { vendureLineMoney } from '../import/vendure-money.js';
import { orderEditStoredFingerprint } from '../orders/order-edit-stack.js';
import { buildEditStageProposal } from '../orders/edit-stage.js';
import { buildCurrentCreditPricingSnapshot, currentCreditFundingTargets, readCurrentOrderPricingSnapshot, type CreditPricingEvidence } from '../money/current-credit-pricing.js';
import { planCreditUnitReturn, planEditCreditFunding, originalCreditUnitId, creditReturnSnapshotDigest } from '../account-credit/edit-funding.js';
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

/** Actual retained rows, including importer mappings & raw byte digests. */
const importedCredit = (allocation = [34, 34, 33], returned = false, historical = false) => {
  const storeId = secondId, sourceKey = 'source', mapped = (kind: string, source: number) => migrationId(storeId, sourceKey, kind, source);
  const orderId = mapped('order', 9), lineId = mapped('order-line', 7), accountId = mapped('account-credit', 4), promotionId = mapped('promotion', 5);
  const amount = allocation.reduce((sum, cents) => sum + cents, 0);
  const rawLine = { id: 7, orderId: 9, quantity: 2, orderPlacedQuantity: 3, listPrice: 100, listPriceIncludesTax: true,
    adjustments: [{ amount: -amount, type: 'PROMOTION', adjustmentSource: 'PROMOTION:5' }], taxLines: [], shippingLineId: null };
  const money = vendureLineMoney(rawLine), totals = { subtotal: money.lineSubtotal, discountTotal: money.lineDiscount,
    taxTotal: money.lineTax, shippingTotal: 0, grandTotal: money.lineTotal, pointsDiscount: 0 };
  const basis = { version: 1, format: 'retained-pg-jsonb-text-v1', sourceKey, sourceOrderId: '9',
    sourceOrderRecord: JSON.stringify({ id: 9, currencyCode: 'USD', subTotal: money.lineTotal,
      subTotalWithTax: money.lineTotal, shipping: 0, shippingWithTax: 0, couponCodes: ['CREDIT'] }),
    channel: { sourceId: '1', projection: 'pricing-v1', sourceRecord: JSON.stringify({ id: 1, defaultCurrencyCode: 'USD', pricesIncludeTax: true, defaultTaxZoneId: null }),
      orderChannelRecord: JSON.stringify({ orderId: 9, channelId: 1 }) }, shippingMethods: [],
    header: { subTotal: String(money.lineTotal), subTotalWithTax: String(money.lineTotal), shipping: '0', shippingWithTax: '0' },
    lines: [{ sourceId: '7', orderLineId: lineId, sourceRecord: JSON.stringify(rawLine) }], shippingLines: [], surcharges: [] };
  const metadata = { vendure: { id: 9, sourceKey, editBasisV1: { ...basis, sourceDigest: orderEditStoredFingerprint(basis) } } };
  const lines = [{ id: lineId, orderId, storeId, quantity: 2, ...money, metadata: { vendure: { id: 7 } } }];
  const sourceRecord = JSON.stringify({ id: 4, promotionId: 5, currency: 'USD' });
  const sourcePromotionRecord = JSON.stringify({ id: 5, actions: [{ code: 'account_credit_discount' }], conditions: [{ code: 'account_credit_eligible' }] });
  const accountSource = { id: accountId, storeId, promotionId, currency: 'USD', sourceKey, sourceId: '4', sourceRecord, sourcePromotionRecord,
    sourceDigest: orderEditStoredFingerprint({ format: 'retained-pg-jsonb-text-v1', account: sourceRecord, promotion: sourcePromotionRecord }),
    promotion: { id: promotionId, storeId, type: 'account_credit' } };
  const transactionRecord = JSON.stringify({ id: 6, accountCreditId: 4, orderId: 9, kind: 'REDEEM', status: 'POSTED', amount, delta: -amount, allocation: { '7': allocation } });
  const redemptionSource = { id: mapped('account-credit-transaction', 6), storeId, orderId, accountCreditId: accountId, kind: 'REDEEM', status: 'POSTED', amount,
    delta: -amount, operationalAllocation: { [lineId]: allocation }, sourceKey, sourceId: '6', sourceRecord: transactionRecord,
    sourceDigest: orderEditStoredFingerprint({ format: 'retained-pg-jsonb-text-v1', transaction: transactionRecord }), allocation: JSON.stringify({ '7': allocation }), sourceOrderId: '9' };
  const refundId = mapped('refund', 8), originalIndex = historical ? 0 : allocation.length - 1;
  const plan = planCreditUnitReturn({ redemption: redemptionSource, history: [], historyComplete: true, orderLineId: lineId, originalIndexes: [originalIndex],
    operation: historical ? { kind: 'refund', id: refundId } : { kind: 'manual_return', id: 'source-return' } });
  if (!plan.ok || !plan.posting) throw new Error('Expected retained original posting');
  const history = returned ? [{ ...plan.posting, id: mapped('account-credit-transaction', 10), refundId: historical ? refundId : null }] : [];
  const refunds = historical ? [{ id: refundId, state: 'Settled', amount: 17, metadata: { vendureId: 8, allocation: 'derived-largest-remainder-by-placed-line-value' },
    lines: [{ id: mapped('refund-line', 11), orderLineId: lineId, quantity: 2, amount: 17 }] }] : [];
  const evidence = { redemption: redemptionSource, history, historyComplete: true as const, refunds, refundsComplete: true as const,
    importedSource: { accountSource, redemptionSource } };
  const origin = buildImportedCreditOrigin({ storeId, orderId, currency: 'USD', metadata, couponCodes: ['CREDIT'], totals, lines, evidence, accountSource, redemptionSource });
  return { order: { currency: 'USD', pricingSnapshot: origin }, lines, lineId, origin, evidence: { ...evidence, importedOrigin: origin } };
};

describe('refund cash unit & independent credit unit authority', () => {
  it('keeps still-live detached original source funding & refunds combined source units', () => {
    const fixture = importedCredit(), { order, lines, evidence, lineId } = fixture;
    const view = readCurrentOrderPricingSnapshot(order.pricingSnapshot, { currency: 'USD', orderLines: lines, mode: 'refund', creditEvidence: evidence })!;
    expect(view.liveAllocation[lineId]).toEqual([34, 34]);
    expect(view.liveDetachedAllocation[lineId]).toEqual([33]);
    expect(view.sourceRefundUnits[lineId]?.map(unit => unit.present)).toEqual([true, true, false]);
    expect(availableCreditRefundUnits(order, lines, evidence, []).get(lineId)).toEqual([0, 1, 2]);
    const frozen = prepareCreditUnitReturns(order, lines, evidence, [{ orderLineId: lineId, quantity: 3 }], []);
    expect(frozen).toMatchObject({ version: 2, lines: [{ positions: [0, 1, 2], originalIndexes: [0, 1, 2], creditCents: [34, 34, 33] }] });
    if (frozen.version !== 2) throw new Error('Expected source unit receipt');
    expect(frozen.lines[0]?.presentUnitIds).toEqual(frozen.lines[0]!.unitIds.slice(0, 2));
    const { requestDigest: _digest, ...physicalBase } = { ...frozen, lines: [{ ...frozen.lines[0]!, presentUnitIds: frozen.lines[0]!.unitIds }] };
    const forgedPhysical = { ...physicalBase, requestDigest: creditReturnSnapshotDigest(physicalBase) };
    expect(() => availableCreditRefundUnits(order, lines, { ...evidence, refunds: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      state: 'Pending', amount: 198, metadata: { creditUnitReturns: forgedPhysical }, lines: [{ orderLineId: lineId, quantity: 3, amount: 198 }] }] }, [])).toThrow(/physical|present/);
    expect(refundUnitBases(order, lines, evidence).get(lineId)).toEqual([66, 66, 66]);
    expect(readCreditUnitReturns({ creditUnitReturns: frozen })).toEqual(frozen);
    expect(() => availableCreditRefundUnits(order, lines, { ...evidence, importedSource: { ...evidence.importedSource,
      accountSource: { ...evidence.importedSource.accountSource, currency: 'EUR' } } }, [])).toThrow(/source rows differ/);
    expect(() => availableCreditRefundUnits(order, lines, { ...evidence, importedSource: { ...evidence.importedSource,
      redemptionSource: { ...evidence.importedSource.redemptionSource, sourceRecord: `${evidence.importedSource.redemptionSource.sourceRecord} ` } } }, [])).toThrow(/source rows differ/);
    const returned = importedCredit([34, 34, 33], true);
    expect(availableCreditRefundUnits(returned.order, returned.lines, returned.evidence, []).get(returned.lineId)).toEqual([0, 1]);
  });
  it('reserves unfunded detached cash by stable ID until definitive Failed', () => {
    const { order, lines, evidence, lineId } = importedCredit([1, 0]);
    const first = prepareCreditUnitReturns(order, lines, evidence, [{ orderLineId: lineId, quantity: 2 }], []);
    const pending = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', state: 'Pending', amount: 200,
      metadata: { creditUnitReturns: first }, lines: [{ orderLineId: lineId, quantity: 2, amount: 200 }] };
    const withPending = { ...evidence, refunds: [pending] };
    const cashOnly = prepareCreditUnitReturns(order, lines, withPending, [{ orderLineId: lineId, quantity: 1 }], []);
    expect(cashOnly).toMatchObject({ version: 2, lines: [{ positions: [2], originalIndexes: [null], creditCents: [0], unitEconomics: [{ net: 0, gross: 0, cashRefundGross: 100 }] }] });
    expect(cashOnly).toMatchObject({ lines: [{ presentUnitIds: [] }] });
    const second = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', state: 'Pending', amount: 100,
      metadata: { creditUnitReturns: cashOnly }, lines: [{ orderLineId: lineId, quantity: 1, amount: 100 }] };
    expect(availableCreditRefundUnits(order, lines, { ...withPending, refunds: [pending, second] }, []).get(lineId)).toEqual([]);
    expect(availableCreditRefundUnits(order, lines, { ...withPending, refunds: [pending, { ...second, state: 'Settled' }] }, []).get(lineId)).toEqual([]);
    expect(availableCreditRefundUnits(order, lines, { ...withPending, refunds: [pending, { ...second, state: 'Failed' }] }, []).get(lineId)).toEqual([2]);
  });
  it('admits captured historical derived amounts without fabricating a unit envelope', () => {
    const { order, lines, evidence, lineId, origin } = importedCredit([1], true, true);
    expect(evidence.refunds[0]!.lines[0]!.amount).toBe(17);
    expect(readCreditUnitReturns(evidence.refunds[0]!.metadata)).toBeNull();
    expect(origin.capture.legacyRefunds[0]?.id).toBe(evidence.refunds[0]!.id);
    const available = availableCreditRefundUnits(order, lines, evidence, []).get(lineId)!;
    expect(available).toHaveLength(1);
    const fresh = prepareCreditUnitReturns(order, lines, evidence, [{ orderLineId: lineId, quantity: 1 }], []);
    expect(fresh.lines[0]?.creditCents).toEqual([0]);
    expect(refundUnitBases(order, lines, evidence).get(lineId)).toEqual([100, 100, 100]);
    expect(() => availableCreditRefundUnits(order, lines, { ...evidence, history: [] }, [])).toThrow(/prefix/);
    expect(() => availableCreditRefundUnits(order, lines, { ...evidence, refunds: [{ ...evidence.refunds[0]!, amount: 18 }] }, [])).toThrow(/refund prefix/);
  });
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
    const sourceRow = (saved: ReturnType<typeof buildCurrentCreditPricingSnapshot>, predecessor: NonNullable<ReturnType<typeof readCurrentOrderPricingSnapshot>>,
      activationEvidence: CreditPricingEvidence) => {
      const fundingPlan = planEditCreditFunding({ ...activationEvidence, editId: saved.lineage.editId,
        lines: currentCreditFundingTargets(saved.ordinary, saved.originalUnitIndexes, saved.credit.basis, saved.ordinaryUnitFacts,
          { consumedPositions: predecessor.consumedPositions }) });
      if (!fundingPlan.ok || fundingPlan.replay || fundingPlan.postings.length) throw new Error('Expected no-posting activated fixture');
      const { requestDigest } = fundingPlan, postingKeys = fundingPlan.postings.map(posting => posting.idempotencyKey);
      const proposal = buildEditStageProposal({ editId: saved.lineage.editId, orderId: redemption.orderId,
        requestFingerprint: orderEditStoredFingerprint({ editId: saved.lineage.editId }),
        previewAcceptanceHash: orderEditStoredFingerprint(saved), beforeFingerprint: orderEditStoredFingerprint(predecessor),
        beforeLedgerPrefixDigest: orderEditStoredFingerprint({ redemption: activationEvidence.redemption,
          history: [...activationEvidence.history].sort((a, b) => a.id.localeCompare(b.id)) }), pricingSnapshot: saved, fundingPlan, requestDigest, postingKeys,
        lines: saved.lines, couponCodes: saved.couponCodes,
        appliedPromotionIds: [...new Set([...saved.ordinary.applied.map(applied => applied.promotionId), saved.credit.promotionId])],
        settlementRequirement: { type: 'leave_credit', currency: saved.currency, requiredTender: 0, requiredRefund: 0 },
        stockReservationReceipt: { key: `order-edit:${saved.lineage.editId}:stock`, positiveDeltas: [] },
        lineIds: Object.fromEntries(saved.lines.map(line => [line.key, line.orderLineId])), activation: {
          unitIds: saved.unitIds, indexes: saved.originalUnitIndexes, predecessor, lineage: saved.lineage,
          origin: saved.origin, ordinary: saved.ordinary, ordinaryUnitFacts: saved.ordinaryUnitFacts } });
      return { id: saved.lineage.editId, orderId: redemption.orderId, before: { currentPricing: predecessor.snapshot },
        after: { activatedPricingSnapshot: saved, proposal },
        settlement: { phase: 'activated', type: 'leave_credit', status: 'settled', activationReceipt: { proposalDigest: proposal.proposalDigest, requestDigest, postingKeys,
          activatedAt: '2026-01-01T00:00:00.000Z',
          activatedSnapshotHash: creditReturnSnapshotDigest(saved) } } };
    };
    const snapshot = buildCurrentCreditPricingSnapshot({ origin, ordinary, couponCodes: ['CREDIT'], evidence,
      ordinaryUnitFacts: { [id]: { sourceAdjustmentTotal: result.lineSnapshots[0]!.sourceAdjustmentTotal!,
        sourceAdjustmentDivisor: result.lineSnapshots[0]!.sourceAdjustmentDivisor! } }, originalUnitIndexes: { [id]: [2, null, 0, 1] },
      unitIds: { [id]: [originalCreditUnitId(redemption.id, id, 2), `edit:${editId}:${id}:0`, originalCreditUnitId(redemption.id, id, 0), originalCreditUnitId(redemption.id, id, 1)] },
      lineage: { editId, predecessorSnapshotDigest: creditReturnSnapshotDigest(origin), consumedUnitIds: [] } });
    const pricingSources = [sourceRow(snapshot, originView, evidence)];
    const lines = [{ id, quantity: 4, unitPrice: 100, lineTotal: snapshot.lines[0]!.lineGross }];
    const order = { currency: 'USD', pricingSnapshot: snapshot };
    const first = prepareCreditUnitReturns(order, lines, evidence, selection(), [], pricingSources);
    expect(first.lines[0]).toMatchObject({ positions: [0], originalIndexes: [2], creditCents: [33] });
    const brokenReceipt = structuredClone(pricingSources);
    brokenReceipt[0]!.settlement.activationReceipt.requestDigest = 'f'.repeat(64);
    expect(() => prepareCreditUnitReturns(order, lines, evidence, selection(), [], brokenReceipt)).toThrow(/activation operation receipt/);
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
    const laterSources = [...pricingSources, sourceRow(later, predecessor, settled)];
    expect(prepareCreditUnitReturns({ ...order, pricingSnapshot: later }, lines, settled, selection(), [], laterSources).lines[0]?.positions).toEqual([2]);
    expect(refundUnitBases(order, lines, live, pricingSources).get(id)).toEqual(basis);
  });

});
