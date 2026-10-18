/** Synthetic fixtures only. Root integration owns execution against a disposable *_test DB. */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { adjust, anchorImportedCreditOrigin, currentDiscount, disable, issue, previewAvailable, readCurrentCreditEvidence, redeem, redeemAfterSettlement, release, reserve, restoreManual, restoreRefund, restoreRefundAfterSettlement, prepareEditCreditFunding, postEditCreditFunding } from './service.js';
import { migrationId } from '../import/context.js';
import { orderEditStoredFingerprint } from '../orders/order-edit-stack.js';
import { buildEditStageProposal } from '../orders/edit-stage.js';
import { buildCurrentCreditPricingSnapshot, creditPricingSnapshotDigest, currentCreditFundingTargets, readCurrentOrderPricingSnapshot } from '../money/current-credit-pricing.js';
import { buildOrderPricingSnapshot } from '../money/pricing-snapshot.js';
import { calculatePromotionStack, type StackInput } from '../money/promotion-stack.js';
import { planEditCreditFunding } from './edit-funding.js';
import { availableCreditRefundUnits, prepareCreditUnitReturns } from '../payments/refund-credit.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'account-credit/service.db.test.ts');
const STORE = 'cccccccc-accc-4000-8000-000000000001';
const OTHER = 'cccccccc-accc-4000-8000-000000000002';
let accountId: string;
let promotionId: string;
let code: string;

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await withStore(STORE, async tx => {
    await tx.insert(s.store).values({ id: STORE, slug: 'credit-synthetic', name: 'Credit synthetic', currency: 'USD' });
    const result = await issue(tx, { storeId: STORE, amount: 1000, email: 'issued@example.invalid', issuanceKey: 'fixture-issue' });
    accountId = result.account.id; promotionId = result.account.promotionId; code = result.code;
  });
  await withStore(OTHER, async tx => {
    await tx.insert(s.store).values({ id: OTHER, slug: 'credit-other', name: 'Other synthetic', currency: 'USD' });
  });
});
async function order(currency = 'USD', quantity = 3) {
  return withStore(STORE, async tx => {
    const [o] = await tx.insert(s.order).values({ storeId: STORE, code: randomUUID(), currency, promotionId, subtotal: 1500, discountTotal: 101, grandTotal: 1499 }).returning();
    const [line] = await tx.insert(s.orderLine).values({ storeId: STORE, orderId: o!.id, variantSku: 'SYNTHETIC', variantName: 'Synthetic item',
      quantity, unitPrice: 500, lineSubtotal: quantity * 500, lineDiscount: 101, lineTotal: quantity * 500 - 101 }).returning();
    return { order: o!, line: line! };
  });
}
async function hold(orderId: string, amount = 101) {
  return withStore(STORE, tx => reserve(tx, { storeId: STORE, orderId, accountId, appliedAmount: amount, phase: 'ArrangingPayment' }));
}
async function settled(orderId: string) {
  return withStore(STORE, async tx => {
    const [payment] = await tx.insert(s.payment).values({ storeId: STORE, orderId, amount: 1499, method: 'synthetic', state: 'Settled', currency: 'USD' }).returning();
    await tx.update(s.order).set({ state: 'Paid' }).where(eq(s.order.id, orderId));
    return payment!;
  });
}
async function account() {
  return withStore(STORE, async tx => (await tx.select().from(s.accountCredit).where(eq(s.accountCredit.id, accountId)))[0]!);
}
async function entries() {
  return withStore(STORE, tx => tx.select().from(s.accountCreditTransaction).where(eq(s.accountCreditTransaction.accountCreditId, accountId)));
}
async function refund(orderId: string, paymentId: string, lineId: string, quantity: number) {
  return withStore(STORE, async tx => {
    const [row] = await tx.insert(s.refund).values({ storeId: STORE, orderId, paymentId, amount: 466 * quantity, state: 'Settled' }).returning();
    await tx.insert(s.refundLine).values({ storeId: STORE, refundId: row!.id, orderLineId: lineId, quantity, amount: 466 * quantity });
    return row!;
  });
}
const op = { operationKey: 'operator-1', actor: 'synthetic-operator', reason: 'Synthetic correction' };

async function retainedOrder() {
  return withStore(STORE, async tx => {
    const sourceKey = 'retained-synthetic', mapped = (kind: string, source: number) => migrationId(STORE, sourceKey, kind, source);
    const orderId = mapped('order', 9), lineId = mapped('order-line', 7), creditId = mapped('account-credit', 4), promoId = mapped('promotion', 5);
    const rawLine = { id: 7, orderId: 9, quantity: 2, orderPlacedQuantity: 3, listPrice: 100, listPriceIncludesTax: true,
      adjustments: [{ amount: -101, type: 'PROMOTION', adjustmentSource: 'PROMOTION:5' }], taxLines: [], shippingLineId: null };
    const basis = { version: 1, format: 'retained-pg-jsonb-text-v1', sourceKey, sourceOrderId: '9',
      sourceOrderRecord: JSON.stringify({ id: 9, currencyCode: 'USD', subTotal: 133, subTotalWithTax: 133, shipping: 0, shippingWithTax: 0, couponCodes: ['IMPORTED'] }),
      channel: { sourceId: '1', projection: 'pricing-v1', sourceRecord: JSON.stringify({ id: 1, defaultCurrencyCode: 'USD', pricesIncludeTax: true, defaultTaxZoneId: null }),
        orderChannelRecord: JSON.stringify({ orderId: 9, channelId: 1 }) }, shippingMethods: [],
      header: { subTotal: '133', subTotalWithTax: '133', shipping: '0', shippingWithTax: '0' },
      lines: [{ sourceId: '7', orderLineId: lineId, sourceRecord: JSON.stringify(rawLine) }], shippingLines: [], surcharges: [] };
    const sourceRecord = JSON.stringify({ id: 4, promotionId: 5, currency: 'USD' });
    const sourcePromotionRecord = JSON.stringify({ id: 5, actions: [{ code: 'account_credit_discount' }], conditions: [{ code: 'account_credit_eligible' }] });
    await tx.insert(s.promotion).values({ id: promoId, storeId: STORE, code: 'IMPORTED', type: 'account_credit', value: 0 });
    await tx.insert(s.accountCredit).values({ id: creditId, storeId: STORE, promotionId: promoId, currency: 'USD', emailNormalized: 'retained@example.invalid',
      issuanceKey: 'retained', initialAmount: 1000, balance: 899, sourceKey, sourceId: '4', sourceRecord, sourcePromotionRecord,
      sourceDigest: orderEditStoredFingerprint({ format: 'retained-pg-jsonb-text-v1', account: sourceRecord, promotion: sourcePromotionRecord }) });
    await tx.insert(s.order).values({ id: orderId, storeId: STORE, code: 'RETAINED', state: 'Paid', currency: 'USD', promotionId: promoId,
      subtotal: 200, discountTotal: 67, grandTotal: 133, couponCodes: ['IMPORTED'], metadata: { vendure: { id: 9, sourceKey,
        editBasisV1: { ...basis, sourceDigest: orderEditStoredFingerprint(basis) } } } });
    await tx.insert(s.orderLine).values({ id: lineId, storeId: STORE, orderId, variantSku: 'RETAINED', variantName: 'Retained', quantity: 2,
      unitPrice: 100, lineSubtotal: 200, lineDiscount: 67, lineTotal: 133, metadata: { vendure: { id: 7 } } });
    const transactionRecord = JSON.stringify({ id: 6, accountCreditId: 4, orderId: 9, kind: 'REDEEM', status: 'POSTED', amount: 101, delta: -101, allocation: { '7': [34, 34, 33] } });
    await tx.insert(s.accountCreditTransaction).values({ id: mapped('account-credit-transaction', 6), storeId: STORE, accountCreditId: creditId, orderId,
      kind: 'REDEEM', status: 'POSTED', amount: 101, delta: -101, balanceAfter: 899, idempotencyKey: 'retained-redeem',
      operationalAllocation: { [lineId]: [34, 34, 33] }, allocation: JSON.stringify({ '7': [34, 34, 33] }),
      sourceKey, sourceId: '6', sourceOrderId: '9', sourceRecord: transactionRecord,
      sourceDigest: orderEditStoredFingerprint({ format: 'retained-pg-jsonb-text-v1', transaction: transactionRecord }) });
    return { orderId, lineId, creditId };
  });
}

async function pendingRetainedStage() {
  const fixture = await retainedOrder();
  return withStore(STORE, async tx => {
    const [storedOrder] = await tx.select().from(s.order).where(eq(s.order.id, fixture.orderId));
    const financialLines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, fixture.orderId));
    const evidence = (await readCurrentCreditEvidence(tx, { storeId: STORE, orderId: fixture.orderId }))!, origin = evidence.importedOrigin!;
    const predecessor = readCurrentOrderPricingSnapshot(origin, { currency: 'USD', orderLines: financialLines, mode: 'settlement', creditEvidence: evidence })!;
    const editId = randomUUID();
    const pricingInput: StackInput = { currency: 'USD', pricesIncludeTax: true, couponCodes: [], phase: 'PaymentSettled',
      lines: [{ key: fixture.lineId, quantity: 2, placedQuantity: 3, unitListPrice: 20, priceIncludesTax: true, taxRateBps: 0 }],
      promotions: [], shipping: 0, shippingTaxRateBps: 0, shippingIncludesTax: true, couponContext: { activeVerifications: [] } };
    const priced = calculatePromotionStack(pricingInput), ordinary = buildOrderPricingSnapshot(pricingInput, priced, new Map([[fixture.lineId, fixture.lineId]]));
    const ordinaryUnitFacts = { [fixture.lineId]: { sourceAdjustmentTotal: priced.lineSnapshots[0]!.sourceAdjustmentTotal!,
      sourceAdjustmentDivisor: priced.lineSnapshots[0]!.sourceAdjustmentDivisor! } };
    const targets = currentCreditFundingTargets(ordinary, predecessor.originalUnitIndexes, 'gross', ordinaryUnitFacts,
      { consumedPositions: predecessor.consumedPositions, sourceCustody: predecessor.sourceCustody,
        liveDetachedAllocation: predecessor.liveDetachedAllocation, consumedUnitIds: predecessor.consumedSourceUnitIds });
    const fundingPlan = planEditCreditFunding({ ...evidence, editId, lines: targets });
    if (!fundingPlan.ok || fundingPlan.replay || fundingPlan.postings.length !== 1) throw new Error('Expected staged repricing restoration');
    const restoreRows = fundingPlan.postings.map(posting => ({ ...posting, id: randomUUID(), refundId: null }));
    const pricingSnapshot = buildCurrentCreditPricingSnapshot({ origin, ordinary, ordinaryUnitFacts, couponCodes: ['IMPORTED'],
      evidence: { ...evidence, history: [...evidence.history, ...restoreRows] }, predecessor,
      originalUnitIndexes: predecessor.originalUnitIndexes, unitIds: predecessor.unitIds,
      lineage: { editId, predecessorSnapshotDigest: creditPricingSnapshotDigest(origin), consumedUnitIds: predecessor.consumedSourceUnitIds } });
    const fingerprint = orderEditStoredFingerprint({ editId, fixture }), storedFingerprint = orderEditStoredFingerprint({ order: storedOrder, lines: financialLines });
    const before = { currentPricing: origin, storedOrder: storedOrder!, financialLines, storedFingerprint };
    const activation = { beforeOrder: storedOrder!, predecessor, origin, ordinary, ordinaryUnitFacts,
      indexes: predecessor.originalUnitIndexes, unitIds: predecessor.unitIds, lineage: pricingSnapshot.lineage, targets };
    const proposal = buildEditStageProposal({ editId, orderId: fixture.orderId, requestFingerprint: fingerprint,
      previewAcceptanceHash: orderEditStoredFingerprint(pricingSnapshot), beforeFingerprint: storedFingerprint,
      beforeLedgerPrefixDigest: orderEditStoredFingerprint({ redemption: evidence.redemption,
        history: [...evidence.history].sort((left, right) => left.id.localeCompare(right.id)) }),
      pricingSnapshot, fundingPlan, requestDigest: fundingPlan.requestDigest, postingKeys: fundingPlan.postings.map(posting => posting.idempotencyKey),
      lineIds: { [fixture.lineId]: fixture.lineId }, lines: financialLines, couponCodes: ['IMPORTED'], appliedPromotionIds: [origin.accountSource.promotionId],
      settlementRequirement: { type: 'refund_now', currency: 'USD', requiredTender: 0, requiredRefund: 133 },
      stockReservationReceipt: { key: `order-edit:${editId}:stock`, positiveDeltas: [] }, activation });
    const [payment] = await tx.insert(s.payment).values({ storeId: STORE, orderId: fixture.orderId, amount: 133, currency: 'USD', method: 'synthetic', state: 'Settled' }).returning();
    const [refund] = await tx.insert(s.refund).values({ storeId: STORE, orderId: fixture.orderId, paymentId: payment!.id,
      amount: 133, state: 'Pending', metadata: { purpose: 'order_edit', editId } }).returning();
    const settlement = { phase: 'awaiting_refund', type: 'refund_now', status: 'pending', refundId: refund!.id };
    await tx.insert(s.orderEdit).values({ id: editId, storeId: STORE, orderId: fixture.orderId, idempotencyKey: `pending:${editId}`, fingerprint,
      before, after: { proposal }, balance: -133, settlement, actor: 'synthetic-operator' });
    return { ...fixture, editId, origin, before, activation, proposal, restoreRows, refundId: refund!.id, settlement };
  });
}

describe('monetary account credit', () => {
  it('reuses pending first-import origin after linked settlement & staged RESTORE without adopting new capture', async () => {
    const stage = await pendingRetainedStage(), input = { storeId: STORE, orderId: stage.orderId };
    const prepared = await withStore(STORE, tx => readCurrentCreditEvidence(tx, input));
    expect(prepared?.importedOrigin).toEqual(stage.origin);
    await withStore(STORE, async tx => {
      await tx.update(s.refund).set({ state: 'Settled' }).where(eq(s.refund.id, stage.refundId));
      await tx.update(s.orderEdit).set({ settlement: { ...stage.settlement, phase: 'ready', status: 'settled' } }).where(eq(s.orderEdit.id, stage.editId));
      for (const row of stage.restoreRows) await tx.insert(s.accountCreditTransaction).values({ ...row, storeId: STORE, balanceAfter: 927,
        reason: 'Committed order edit', actor: null });
      await tx.update(s.accountCredit).set({ balance: 927 }).where(eq(s.accountCredit.id, stage.creditId));
    });
    for (let replay = 0; replay < 2; replay++) await withStore(STORE, async tx => {
      const evidence = await readCurrentCreditEvidence(tx, input);
      expect(evidence?.importedOrigin).toEqual(stage.origin);
      expect(evidence?.importedOrigin?.capture.restoreIds).toEqual([]);
      expect(evidence?.importedOrigin?.capture.legacyRefunds).toEqual([]);
      expect(evidence?.history).toHaveLength(1);
      const activated = buildCurrentCreditPricingSnapshot({ origin: evidence!.importedOrigin!,
        ordinary: stage.activation.ordinary, ordinaryUnitFacts: stage.activation.ordinaryUnitFacts,
        couponCodes: ['IMPORTED'], evidence: evidence!, pricingSources: evidence!.pricingSources,
        predecessor: stage.activation.predecessor, originalUnitIndexes: stage.activation.indexes,
        unitIds: stage.activation.unitIds, lineage: stage.activation.lineage });
      expect(activated).toEqual(stage.proposal.pricingSnapshot);
      expect((await tx.select().from(s.order).where(eq(s.order.id, stage.orderId)))[0]?.pricingSnapshot).toBeNull();
      expect((await tx.select().from(s.accountCredit).where(eq(s.accountCredit.id, stage.creditId)))[0]?.balance).toBe(927);
    });
  });
  it('refuses independent manual restoration before a pending imported edit can anchor origin', async () => {
    const stage = await pendingRetainedStage();
    await expect(withStore(STORE, tx => restoreManual(tx, { storeId: STORE, accountId: stage.creditId,
      orderId: stage.orderId, orderLineId: stage.lineId, quantity: 1, expectedCents: 34,
      operationKey: 'pending-manual', actor: 'synthetic-operator', reason: 'Independent return' })))
      .rejects.toThrow('Resolve pending order edit before manual credit restoration');
    await withStore(STORE, async tx => {
      expect((await tx.select().from(s.order).where(eq(s.order.id, stage.orderId)))[0]?.pricingSnapshot).toBeNull();
      expect((await tx.select().from(s.accountCredit).where(eq(s.accountCredit.id, stage.creditId)))[0]?.balance).toBe(899);
      expect((await tx.select().from(s.accountCreditTransaction).where(eq(s.accountCreditTransaction.orderId, stage.orderId)))
        .filter(row => row.kind === 'RESTORE')).toEqual([]);
    });
  });
  it.each(['order', 'fingerprint', 'financial capture', 'source origin', 'normalized predecessor'] as const)(
    'refuses forged pending imported %s proof', async tamper => {
      const stage = await pendingRetainedStage(), before = structuredClone(stage.before), activation = structuredClone(stage.activation);
      if (tamper === 'financial capture') before.financialLines[0]!.lineTotal++;
      if (tamper === 'source origin') {
        before.currentPricing.capture.totals.grandTotal++;
        before.currentPricing.captureDigest = creditPricingSnapshotDigest({ ...before.currentPricing, captureDigest: undefined });
        activation.origin = before.currentPricing;
        activation.predecessor.snapshot = before.currentPricing;
      }
      if (tamper === 'normalized predecessor') activation.predecessor.unitEconomics[stage.lineId]![0]!.gross++;
      const { version: _version, proposalDigest: _digest, ...payload } = stage.proposal;
      const proposal = buildEditStageProposal({ ...payload, activation, ...(tamper === 'order' ? { orderId: OTHER } : {}) });
      await withStore(STORE, tx => tx.update(s.orderEdit).set({ before, after: { proposal },
        ...(tamper === 'fingerprint' ? { fingerprint: 'f'.repeat(64) } : {}) }).where(eq(s.orderEdit.id, stage.editId)));
      await expect(withStore(STORE, tx => readCurrentCreditEvidence(tx, { storeId: STORE, orderId: stage.orderId }))).rejects.toThrow('Pending imported origin proof differs');
      await withStore(STORE, async tx => {
        expect((await tx.select().from(s.order).where(eq(s.order.id, stage.orderId)))[0]?.pricingSnapshot).toBeNull();
        expect((await tx.select().from(s.accountCredit).where(eq(s.accountCredit.id, stage.creditId)))[0]?.balance).toBe(899);
        expect((await tx.select().from(s.accountCreditTransaction).where(eq(s.accountCreditTransaction.orderId, stage.orderId))).filter(row => row.kind === 'RESTORE')).toEqual([]);
      });
    });
  it('anchors first retained refund once & replays restoration against original captured prefix', async () => {
    const fixture = await retainedOrder(), input = { storeId: STORE, orderId: fixture.orderId };
    const first = await withStore(STORE, async tx => {
      const { order, evidence } = await anchorImportedCreditOrigin(tx, input);
      const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, fixture.orderId));
      const frozen = prepareCreditUnitReturns(order, lines, evidence!, [{ orderLineId: fixture.lineId, quantity: 1 }], []);
      const [payment] = await tx.insert(s.payment).values({ ...input, amount: 133, currency: 'USD', method: 'synthetic', state: 'Settled' }).returning();
      const [refund] = await tx.insert(s.refund).values({ ...input, paymentId: payment!.id, state: 'Settled', amount: 66, metadata: { creditUnitReturns: frozen } }).returning();
      await tx.insert(s.refundLine).values({ storeId: STORE, refundId: refund!.id, orderLineId: fixture.lineId, quantity: 1, amount: 66 });
      return { snapshot: order.pricingSnapshot, refundId: refund!.id };
    });
    const restored = await withStore(STORE, tx => restoreRefund(tx, { ...input, refundId: first.refundId }));
    expect(restored[0]?.amount).toBe(34);
    expect((await withStore(STORE, tx => restoreRefund(tx, { ...input, refundId: first.refundId })))[0]?.id).toBe(restored[0]!.id);
    await withStore(STORE, async tx => {
      const anchored = await anchorImportedCreditOrigin(tx, input);
      expect(anchored.order.pricingSnapshot).toEqual(first.snapshot);
      expect(anchored.evidence?.importedOrigin?.capture.restoreIds).toEqual([]);
      const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, fixture.orderId));
      expect(availableCreditRefundUnits(anchored.order, lines, anchored.evidence!, []).get(fixture.lineId)).toEqual([1, 2]);
      expect((await tx.select().from(s.accountCredit).where(eq(s.accountCredit.id, fixture.creditId)))[0]?.balance).toBe(933);
      expect((await tx.select().from(s.accountCreditTransaction).where(eq(s.accountCreditTransaction.orderId, fixture.orderId))).filter(row => row.kind === 'RESTORE')).toHaveLength(1);
    });
  });
  it('anchors retained manual return before posting & leaves captured prefix stable on replay', async () => {
    const fixture = await retainedOrder();
    const input = { storeId: STORE, orderId: fixture.orderId, orderLineId: fixture.lineId, accountId: fixture.creditId, quantity: 1, expectedCents: 34, ...op };
    const restored = await withStore(STORE, tx => restoreManual(tx, input));
    expect((await withStore(STORE, tx => restoreManual(tx, input))).id).toBe(restored.id);
    await withStore(STORE, async tx => {
      const evidence = await readCurrentCreditEvidence(tx, input);
      expect(evidence?.importedOrigin?.capture.restoreIds).toEqual([]);
      expect(evidence?.history).toHaveLength(1);
      expect((await tx.select().from(s.orderLine).where(eq(s.orderLine.id, fixture.lineId)))[0]?.quantity).toBe(2);
      expect((await tx.select().from(s.accountCredit).where(eq(s.accountCredit.id, fixture.creditId)))[0]?.balance).toBe(933);
    });
  });
  it('accepts exact inclusive promotion end instant & rejects following millisecond', async () => {
    const endsAt = new Date('2030-01-01T00:00:00.000Z');
    await withStore(STORE, tx => tx.update(s.promotion).set({ endsAt }).where(eq(s.promotion.id, promotionId)));
    expect(await withStore(STORE, tx => previewAvailable(tx, { storeId: STORE, code, currency: 'USD', now: endsAt }))).toBe(1000);
    expect(await withStore(STORE, tx => previewAvailable(tx, { storeId: STORE, code, currency: 'USD', now: new Date(endsAt.getTime() + 1) }))).toBe(0);
  });

  it('serializes native issuance ranks after existing same-store promotions without changing replay ranks', async () => {
    await withStore(STORE, tx => tx.insert(s.promotion).values({ storeId: STORE, code: 'NATIVE-RANK', type: 'fixed', value: 1, stackOrder: 50 }));
    const issued = await Promise.all(['rank-one', 'rank-two'].map(issuanceKey => withStore(STORE, tx => issue(tx, {
      storeId: STORE, amount: 10, email: 'rank@example.invalid', issuanceKey,
    }))));
    const ranks = await withStore(STORE, async tx => {
      const values: Array<number | null> = [];
      for (const item of issued) values.push((await tx.select().from(s.promotion).where(eq(s.promotion.id, item.account.promotionId)))[0]!.stackOrder);
      return values;
    });
    expect([...ranks].sort((a, b) => a! - b!)).toEqual([51, 52]);
    const replay = await withStore(STORE, tx => issue(tx, { storeId: STORE, amount: 10, email: 'rank@example.invalid', issuanceKey: 'rank-one' }));
    expect(replay.created).toBe(false);
    expect(replay.account.promotionId).toBe(issued[0]!.account.promotionId);
    expect(await withStore(STORE, async tx => (await tx.select().from(s.promotion).where(eq(s.promotion.id, replay.account.promotionId)))[0]!.stackOrder)).toBe(ranks[0]);
  });

  it('quotes anonymously or for a different-email customer without writing or holding', async () => {
    const before = await entries();
    const anonymous = await withStore(STORE, tx => previewAvailable(tx, { storeId: STORE, code: ` ${code.toLowerCase()} `, currency: 'USD' }));
    const o = await order();
    await withStore(STORE, async tx => {
      const [customer] = await tx.insert(s.customer).values({ storeId: STORE, email: 'different@example.invalid' }).returning();
      await tx.update(s.order).set({ customerId: customer!.id }).where(eq(s.order.id, o.order.id));
      expect(await previewAvailable(tx, { storeId: STORE, code, currency: 'USD', orderId: o.order.id })).toBe(anonymous);
    });
    expect(anonymous).toBe(1000);
    expect(await entries()).toEqual(before);
    expect((await account()).balance).toBe(1000);
  });
  it('enforces store/currency/promotion window/enabled/deleted state while disabled owners keep their holds', async () => {
    const o = await order();
    await hold(o.order.id, 400);
    await withStore(STORE, tx => disable(tx, { storeId: STORE, accountId, disabled: true, ...op }));
    await withStore(STORE, async tx => {
      expect(await previewAvailable(tx, { storeId: STORE, code, currency: 'USD' })).toBe(0);
      expect(await previewAvailable(tx, { storeId: STORE, code, currency: 'USD', orderId: o.order.id })).toBe(1000);
      expect(await previewAvailable(tx, { storeId: STORE, code, currency: 'EUR', orderId: o.order.id })).toBe(0);
      expect(await currentDiscount(tx, { storeId: STORE, promotionId, currency: 'USD', orderId: o.order.id, phase: 'ArrangingPayment' })).toBe(400);
      await tx.update(s.promotion).set({ startsAt: new Date('2099-01-01') }).where(eq(s.promotion.id, promotionId));
      expect(await previewAvailable(tx, { storeId: STORE, code, currency: 'USD', orderId: o.order.id })).toBe(0);
      await tx.update(s.promotion).set({ startsAt: null, endsAt: new Date('2000-01-01') }).where(eq(s.promotion.id, promotionId));
      expect(await previewAvailable(tx, { storeId: STORE, code, currency: 'USD', orderId: o.order.id })).toBe(0);
      await tx.update(s.promotion).set({ endsAt: null, enabled: false }).where(eq(s.promotion.id, promotionId));
      expect(await previewAvailable(tx, { storeId: STORE, code, currency: 'USD', orderId: o.order.id })).toBe(0);
      await tx.update(s.promotion).set({ enabled: true }).where(eq(s.promotion.id, promotionId));
      await tx.update(s.accountCredit).set({ sourcePromotionRecord: '{"deletedAt":"2026-01-01"}' }).where(eq(s.accountCredit.id, accountId));
      expect(await previewAvailable(tx, { storeId: STORE, code, currency: 'USD', orderId: o.order.id })).toBe(0);
    });
    expect(await withStore(OTHER, tx => previewAvailable(tx, { storeId: OTHER, code, currency: 'USD' }))).toBe(0);
    await expect(withStore(OTHER, tx => adjust(tx, { storeId: OTHER, accountId, delta: 1, ...op }))).rejects.toThrow('missing in store');
  });
  it('serializes competing orders so credit cannot be overreserved; repeated and changed holds are exact', async () => {
    const a = await order(); const b = await order();
    const results = await Promise.allSettled([hold(a.order.id, 700), hold(b.order.id, 700)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const successful = results[0]!.status === 'fulfilled' ? a : b;
    const first = await hold(successful.order.id, 700);
    expect((await hold(successful.order.id, 700)).id).toBe(first.id);
    const changed = await hold(successful.order.id, 600);
    expect(changed.relatedTransactionId).toBe(first.id);
    const all = await entries();
    expect(all.find(row => row.id === first.id)?.status).toBe('VOID');
    expect(all.filter(row => row.kind === 'RESERVE' && row.status === 'PENDING')).toHaveLength(1);
    expect(await withStore(STORE, tx => previewAvailable(tx, { storeId: STORE, code, currency: 'USD' }))).toBe(400);
  });
  it('fails closed when another coupon shares the case-insensitive code', async () => {
    await withStore(STORE, async tx => {
      await tx.insert(s.promotion).values({ storeId: STORE, type: 'fixed', value: 500, code: code.toLowerCase() });
      expect(await previewAvailable(tx, { storeId: STORE, code, currency: 'USD' })).toBe(0);
    });
  });
  it('rejects wrong phase, currency and zero payable totals', async () => {
    const eur = await order('EUR');
    await expect(hold(eur.order.id)).rejects.toThrow('unavailable');
    const o = await order();
    await expect(withStore(STORE, tx => reserve(tx, { storeId: STORE, orderId: o.order.id, accountId, appliedAmount: 100, phase: 'AddingItems' as 'ArrangingPayment' }))).rejects.toThrow('payment preparation');
    await withStore(STORE, tx => tx.update(s.order).set({ grandTotal: 0 }).where(eq(s.order.id, o.order.id)));
    await expect(hold(o.order.id)).rejects.toThrow('payable');
  });
  it('posts partial redemption once, releases unused hold and rejects changed callback payloads', async () => {
    const o = await order(); await hold(o.order.id, 200); await settled(o.order.id);
    const input = { storeId: STORE, orderId: o.order.id, appliedAmount: 101, allocation: { [o.line.id]: [34, 34, 33] } };
    const first = await withStore(STORE, tx => redeem(tx, input));
    expect((await withStore(STORE, tx => redeem(tx, input)))?.id).toBe(first!.id);
    expect((await account()).balance).toBe(899);
    expect((await entries()).filter(row => row.kind === 'RELEASE').map(row => row.amount)).toEqual([99]);
    await expect(withStore(STORE, tx => redeem(tx, { ...input, allocation: { [o.line.id]: [33, 34, 34] } }))).rejects.toThrow('replay');
  });
  it('zero redemption voids and releases the whole hold', async () => {
    const o = await order(); await hold(o.order.id, 200); await settled(o.order.id);
    await withStore(STORE, tx => tx.update(s.order).set({ promotionId: null }).where(eq(s.order.id, o.order.id)));
    await withStore(STORE, tx => redeem(tx, { storeId: STORE, orderId: o.order.id, appliedAmount: 0, allocation: {} }));
    expect((await account()).balance).toBe(1000);
    expect((await entries()).filter(row => row.kind === 'RESERVE')[0]?.status).toBe('VOID');
    expect((await entries()).filter(row => row.kind === 'RELEASE')[0]?.amount).toBe(200);
  });
  it('preserves settled payment on posting failure and keeps failed hold unavailable', async () => {
    const o = await order(); await hold(o.order.id, 200);
    const result = await withStore(STORE, async tx => {
      await tx.insert(s.payment).values({ storeId: STORE, orderId: o.order.id, amount: 1499, method: 'synthetic', state: 'Settled' });
      await tx.update(s.order).set({ state: 'Paid' }).where(eq(s.order.id, o.order.id));
      return redeemAfterSettlement(tx, { storeId: STORE, orderId: o.order.id, appliedAmount: 101, allocation: { [o.line.id]: [101] } });
    });
    expect(result).toMatchObject({ ok: false, event: 'account_credit.reconciliation_required', errorCode: 'allocation' });
    expect((await account()).balance).toBe(1000);
    expect((await entries()).find(row => row.kind === 'RESERVE')?.status).toBe('PENDING');
    await withStore(STORE, async tx => {
      expect((await tx.select().from(s.payment).where(eq(s.payment.orderId, o.order.id)))[0]?.state).toBe('Settled');
      expect(await previewAvailable(tx, { storeId: STORE, code, currency: 'USD' })).toBe(800);
    });
  });
  it('releases only matching code removal or cancellation; time alone leaves holds live', async () => {
    const o = await order(); await hold(o.order.id, 200);
    expect(await withStore(STORE, tx => release(tx, { storeId: STORE, orderId: o.order.id, cause: 'coupon_removed', couponCode: 'OTHER' }))).toBe(false);
    await withStore(STORE, async tx => {
      await tx.execute(sql`UPDATE account_credit_transaction SET created_at = '2000-01-01' WHERE account_credit_id = ${accountId}`);
      expect(await previewAvailable(tx, { storeId: STORE, code, currency: 'USD', now: new Date('2099-01-01') })).toBe(800);
    });
    expect(await withStore(STORE, tx => release(tx, { storeId: STORE, orderId: o.order.id, cause: 'coupon_removed', couponCode: code.toLowerCase() }))).toBe(true);
    await hold(o.order.id, 300);
    await expect(withStore(STORE, tx => release(tx, { storeId: STORE, orderId: o.order.id, cause: 'cancelled' }))).rejects.toThrow('cancelled order');
    await withStore(STORE, tx => tx.update(s.order).set({ state: 'Cancelled' }).where(eq(s.order.id, o.order.id)));
    expect(await withStore(STORE, tx => release(tx, { storeId: STORE, orderId: o.order.id, cause: 'cancelled' }))).toBe(true);
    expect(await withStore(STORE, tx => previewAvailable(tx, { storeId: STORE, code, currency: 'USD' }))).toBe(1000);
  });
  it('rolls back an actual SQL posting failure to its savepoint without losing provider settlement', async () => {
    const o = await order(); const reserved = await hold(o.order.id, 200);
    await withStore(STORE, tx => tx.insert(s.accountCreditTransaction).values({ storeId: STORE, accountCreditId: accountId,
      kind: 'ADJUST', status: 'POSTED', amount: 0, delta: 0, idempotencyKey: `redeem:${reserved.id}` }));
    const result = await withStore(STORE, async tx => {
      await tx.insert(s.payment).values({ storeId: STORE, orderId: o.order.id, amount: 1499, method: 'synthetic', state: 'Settled' });
      await tx.update(s.order).set({ state: 'Paid' }).where(eq(s.order.id, o.order.id));
      return redeemAfterSettlement(tx, { storeId: STORE, orderId: o.order.id, appliedAmount: 101, allocation: { [o.line.id]: [34, 34, 33] } });
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'posting_failed' });
    expect((await account()).balance).toBe(1000);
    expect((await entries()).find(row => row.id === reserved.id)?.status).toBe('PENDING');
    await withStore(STORE, async tx => {
      expect((await tx.select().from(s.payment).where(eq(s.payment.orderId, o.order.id)))[0]?.state).toBe('Settled');
      expect((await tx.select().from(s.order).where(eq(s.order.id, o.order.id)))[0]?.state).toBe('Paid');
    });
  });
  it('restores next exact units across refunds/manual operations, with replay and overrestore protection', async () => {
    const o = await order(); await hold(o.order.id); const payment = await settled(o.order.id);
    await withStore(STORE, tx => redeem(tx, { storeId: STORE, orderId: o.order.id, appliedAmount: 101, allocation: { [o.line.id]: [34, 34, 33] } }));
    const r1 = await refund(o.order.id, payment.id, o.line.id, 1);
    const first = await withStore(STORE, tx => restoreRefund(tx, { storeId: STORE, orderId: o.order.id, refundId: r1.id }));
    expect(first[0]?.amount).toBe(34);
    expect((await withStore(STORE, tx => restoreRefund(tx, { storeId: STORE, orderId: o.order.id, refundId: r1.id })))[0]?.id).toBe(first[0]!.id);
    const input = { storeId: STORE, accountId, orderId: o.order.id, orderLineId: o.line.id, quantity: 1, expectedCents: 34, ...op };
    const manual = await withStore(STORE, tx => restoreManual(tx, input));
    expect((await withStore(STORE, tx => restoreManual(tx, input))).id).toBe(manual.id);
    await expect(withStore(STORE, tx => restoreManual(tx, { ...input, expectedCents: 33 }))).rejects.toThrow('conflicts');
    const r2 = await refund(o.order.id, payment.id, o.line.id, 1);
    expect((await withStore(STORE, tx => restoreRefund(tx, { storeId: STORE, orderId: o.order.id, refundId: r2.id })))[0]?.amount).toBe(33);
    expect((await account()).balance).toBe(1000);
    const r3 = await refund(o.order.id, payment.id, o.line.id, 1);
    expect(await withStore(STORE, tx => restoreRefundAfterSettlement(tx, { storeId: STORE, orderId: o.order.id, refundId: r3.id }))).toMatchObject({ ok: false, errorCode: 'allocation' });
    expect((await account()).balance).toBe(1000);
  });
  it('keeps unresolved legacy refund units reserved per target line & full quantity', async () => {
    const o = await order('USD', 1);
    const second = await withStore(STORE, async tx => (await tx.insert(s.orderLine).values({ storeId: STORE, orderId: o.order.id,
      variantSku: 'SECOND', variantName: 'Second synthetic item', quantity: 2, unitPrice: 500,
      lineSubtotal: 1000, lineDiscount: 67, lineTotal: 933 }).returning())[0]!);
    await hold(o.order.id); const payment = await settled(o.order.id);
    const redeemed = await withStore(STORE, tx => redeem(tx, { storeId: STORE, orderId: o.order.id, appliedAmount: 101,
      allocation: { [o.line.id]: [34], [second.id]: [34, 33] } }));
    const r = await refund(o.order.id, payment.id, o.line.id, 1);
    const secondRefundLine = await withStore(STORE, async tx => (await tx.insert(s.refundLine).values({ storeId: STORE,
      refundId: r.id, orderLineId: second.id, quantity: 1, amount: 466 }).returning())[0]!);
    await withStore(STORE, async tx => {
      await tx.insert(s.accountCreditTransaction).values({ storeId: STORE, accountCreditId: accountId, orderId: o.order.id,
        relatedTransactionId: redeemed!.id, orderLineId: o.line.id, refundId: r.id, kind: 'RESTORE', status: 'POSTED',
        amount: 34, delta: 34, balanceAfter: 933, quantity: 1, idempotencyKey: 'legacy-refund-line-a',
        reason: 'Settled merchandise refund', actor: null });
      await tx.update(s.accountCredit).set({ balance: 933 }).where(eq(s.accountCredit.id, accountId));
    });
    const manual = { storeId: STORE, accountId, orderId: o.order.id, orderLineId: second.id, quantity: 1,
      expectedCents: 34, operationKey: 'reserved-line-b', actor: op.actor, reason: op.reason };
    await expect(withStore(STORE, tx => restoreManual(tx, manual))).rejects.toThrow('Unmapped refund reserves');
    expect((await account()).balance).toBe(933);
    expect((await entries()).filter(row => row.kind === 'RESTORE')).toHaveLength(1);
    // Even a valid same-line POSTED row cannot release an incomplete quantity.
    await withStore(STORE, async tx => {
      await tx.update(s.refundLine).set({ quantity: 2 }).where(eq(s.refundLine.id, secondRefundLine.id));
      await tx.insert(s.accountCreditTransaction).values({ storeId: STORE, accountCreditId: accountId, orderId: o.order.id,
        relatedTransactionId: redeemed!.id, orderLineId: second.id, refundId: r.id, kind: 'RESTORE', status: 'POSTED',
        amount: 34, delta: 34, balanceAfter: 967, quantity: 1, idempotencyKey: 'legacy-refund-line-b-partial',
        reason: 'Settled merchandise refund', actor: null });
      await tx.update(s.accountCredit).set({ balance: 967 }).where(eq(s.accountCredit.id, accountId));
    });
    await expect(withStore(STORE, tx => restoreManual(tx, { ...manual, expectedCents: 33 }))).rejects.toThrow('Unmapped refund reserves');
    expect((await account()).balance).toBe(967);
    expect((await entries()).filter(row => row.kind === 'RESTORE')).toHaveLength(2);
    expect((await entries()).some(row => row.idempotencyKey === 'manual:reserved-line-b')).toBe(false);
  });
  it('keeps preparation nonspendable, posts edit residual atomically & requires durable replay receipt', async () => {
    const o = await order(); await hold(o.order.id); await settled(o.order.id);
    const redeemed = await withStore(STORE, tx => redeem(tx, { storeId: STORE, orderId: o.order.id, appliedAmount: 101, allocation: { [o.line.id]: [34, 34, 33] } }));
    const input = { storeId: STORE, orderId: o.order.id, editId: randomUUID(), lines: [{ orderLineId: o.line.id,
      units: [{ originalIndex: 1, maximumCredit: 20 }, { originalIndex: 2, maximumCredit: 100 }, { originalIndex: null, maximumCredit: 100 }] }] };
    const prepared = await withStore(STORE, tx => prepareEditCreditFunding(tx, input));
    expect(prepared?.plan).toMatchObject({ ok: true, replay: false, allocation: { [o.line.id]: [20, 33, 0] } });
    expect((await account()).balance).toBe(899);
    expect((await entries()).filter(row => row.kind === 'RESTORE')).toEqual([]);
    // An activation rollback cannot leak restored balance or ledger effects.
    await expect(withStore(STORE, async tx => { await postEditCreditFunding(tx, input); throw new Error('activation rollback'); })).rejects.toThrow('activation rollback');
    expect((await account()).balance).toBe(899);
    expect((await entries()).filter(row => row.kind === 'RESTORE')).toEqual([]);
    const activated = await withStore(STORE, tx => postEditCreditFunding(tx, input));
    if (!activated || activated.plan.replay) throw new Error('Expected edit activation');
    expect((await account()).balance).toBe(947);
    const committedEdit = { editId: input.editId, requestDigest: activated.plan.requestDigest,
      postingKeys: activated.plan.postings.map(row => row.idempotencyKey) };
    expect(await withStore(STORE, tx => postEditCreditFunding(tx, { ...input, committedEdit }))).toMatchObject({ plan: { replay: true, postings: [] } });
    expect((await account()).balance).toBe(947);
    await expect(withStore(STORE, tx => postEditCreditFunding(tx, input))).rejects.toThrow('durable edit receipt');
    const original = (await entries()).find(row => row.id === redeemed!.id)!;
    expect(original.operationalAllocation).toEqual({ [o.line.id]: [34, 34, 33] });
    expect(original.amount).toBe(101);
    expect((await entries()).filter(row => row.kind === 'REDEEM')).toHaveLength(1);
  });
  it('loads malformed potential restorations & rolls back all edit restoration effects', async () => {
    const o = await order(); await hold(o.order.id); await settled(o.order.id);
    const redeemed = await withStore(STORE, tx => redeem(tx, { storeId: STORE, orderId: o.order.id, appliedAmount: 101, allocation: { [o.line.id]: [34, 34, 33] } }));
    await withStore(STORE, tx => tx.insert(s.accountCreditTransaction).values({ storeId: STORE, accountCreditId: accountId,
      orderId: o.order.id, relatedTransactionId: redeemed!.id, orderLineId: o.line.id, kind: 'RESTORE', status: 'VOID',
      amount: 1, delta: 0, quantity: 1, idempotencyKey: 'malformed-potential-restore' }));
    await expect(withStore(STORE, tx => postEditCreditFunding(tx, { storeId: STORE, orderId: o.order.id, editId: randomUUID(), lines: [] }))).rejects.toThrow('posted amount');
    expect((await account()).balance).toBe(899);
  });
  it('fails clearly without proven operational allocation and preserves historical raw text', async () => {
    const o = await order(); await hold(o.order.id); const payment = await settled(o.order.id);
    const redeemRow = await withStore(STORE, tx => redeem(tx, { storeId: STORE, orderId: o.order.id, appliedAmount: 101, allocation: { [o.line.id]: [34, 34, 33] } }));
    const raw = '{"source-opaque-line":[34,34,33]}';
    await withStore(STORE, tx => tx.update(s.accountCreditTransaction).set({ allocation: raw, operationalAllocation: null }).where(eq(s.accountCreditTransaction.id, redeemRow!.id)));
    const r = await refund(o.order.id, payment.id, o.line.id, 1);
    await expect(withStore(STORE, tx => restoreRefund(tx, { storeId: STORE, orderId: o.order.id, refundId: r.id }))).rejects.toThrow('Proven credit allocation missing');
    expect((await entries()).find(row => row.id === redeemRow!.id)?.allocation).toBe(raw);
  });
  it('replays imported numeric-key restorations by mapped refund identity without restoring next units twice', async () => {
    const o = await order(); await hold(o.order.id); const payment = await settled(o.order.id);
    const redeemed = await withStore(STORE, tx => redeem(tx, { storeId: STORE, orderId: o.order.id, appliedAmount: 101, allocation: { [o.line.id]: [34, 34, 33] } }));
    const r = await refund(o.order.id, payment.id, o.line.id, 1);
    const imported = await withStore(STORE, async tx => {
      const [row] = await tx.insert(s.accountCreditTransaction).values({ storeId: STORE, accountCreditId: accountId,
        orderId: o.order.id, orderLineId: o.line.id, refundId: r.id, relatedTransactionId: redeemed!.id,
        kind: 'RESTORE', status: 'POSTED', amount: 34, delta: 34, balanceAfter: 933, quantity: 1,
        idempotencyKey: 'refund:42:line:7', reason: 'Settled merchandise refund', actor: null,
        sourceKey: 'synthetic-import', sourceId: '91', sourceOrderId: '12', sourceRefundId: '42', sourceOrderLineId: '7',
        sourceDigest: 'synthetic-digest', sourceRecord: '{"id":91,"idempotencyKey":"refund:42:line:7","amount":34}' }).returning();
      await tx.update(s.accountCredit).set({ balance: 933 }).where(eq(s.accountCredit.id, accountId));
      return row!;
    });
    const input = { storeId: STORE, orderId: o.order.id, refundId: r.id };
    expect((await withStore(STORE, tx => restoreRefund(tx, input)))[0]?.id).toBe(imported.id);
    expect((await account()).balance).toBe(933);
    expect((await entries()).filter(row => row.kind === 'RESTORE')).toHaveLength(1);
    expect((await entries()).find(row => row.id === imported.id)?.idempotencyKey).toBe('refund:42:line:7');
    // Replay remains valid after another operation consumes subsequent units.
    const later = await refund(o.order.id, payment.id, o.line.id, 2);
    await withStore(STORE, tx => restoreRefund(tx, { ...input, refundId: later.id }));
    expect((await withStore(STORE, tx => restoreRefund(tx, input)))[0]?.id).toBe(imported.id);
    expect((await account()).balance).toBe(1000);
    // Neither changed callback quantity nor altered imported amount/operator/
    // reason may silently pass as the prior operation.
    await withStore(STORE, tx => tx.update(s.refundLine).set({ quantity: 2 }).where(eq(s.refundLine.refundId, r.id)));
    await expect(withStore(STORE, tx => restoreRefund(tx, input))).rejects.toThrow('conflicts');
    await withStore(STORE, tx => tx.update(s.refundLine).set({ quantity: 1 }).where(eq(s.refundLine.refundId, r.id)));
    for (const change of [{ amount: 35, delta: 35 }, { actor: 'different-operator' }, { reason: 'Different reason' }]) {
      await withStore(STORE, tx => tx.update(s.accountCreditTransaction).set(change).where(eq(s.accountCreditTransaction.id, imported.id)));
      await expect(withStore(STORE, tx => restoreRefund(tx, input))).rejects.toThrow('conflicts');
      await withStore(STORE, tx => tx.update(s.accountCreditTransaction).set({ amount: 34, delta: 34, actor: null, reason: 'Settled merchandise refund' }).where(eq(s.accountCreditTransaction.id, imported.id)));
    }
    expect((await account()).balance).toBe(1000);
    expect((await entries()).filter(row => row.kind === 'RESTORE')).toHaveLength(2);
  });
  it('binds issuance/adjustment/disable keys to exact payload and respects outstanding holds', async () => {
    const same = await withStore(STORE, tx => issue(tx, { storeId: STORE, email: ' ISSUED@EXAMPLE.INVALID ', amount: 1000, issuanceKey: 'fixture-issue' }));
    expect(same).toMatchObject({ created: false, account: { id: accountId } });
    await expect(withStore(STORE, tx => issue(tx, { storeId: STORE, email: 'other@example.invalid', amount: 1000, issuanceKey: 'fixture-issue' }))).rejects.toThrow('conflicts');
    const o = await order(); await hold(o.order.id, 900);
    await expect(withStore(STORE, tx => adjust(tx, { storeId: STORE, accountId, delta: -101, ...op }))).rejects.toThrow('available credit');
    await withStore(STORE, tx => adjust(tx, { storeId: STORE, accountId, delta: 50, ...op }));
    await withStore(STORE, tx => adjust(tx, { storeId: STORE, accountId, delta: 50, ...op }));
    expect((await account()).balance).toBe(1050);
    await expect(withStore(STORE, tx => adjust(tx, { storeId: STORE, accountId, delta: 51, ...op }))).rejects.toThrow('conflicts');
    await withStore(STORE, tx => disable(tx, { storeId: STORE, accountId, disabled: true, ...op }));
    await withStore(STORE, tx => disable(tx, { storeId: STORE, accountId, disabled: true, ...op }));
    await expect(withStore(STORE, tx => disable(tx, { storeId: STORE, accountId, disabled: false, ...op }))).rejects.toThrow('conflicts');
    expect((await entries()).filter(row => row.kind === 'DISABLE')).toHaveLength(1);
    expect((await entries()).filter(row => row.kind === 'ADJUST')).toHaveLength(1);
  });
});
