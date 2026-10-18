/** Synthetic fixtures only; root runs against a disposable *_test database. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { isDisposablePostgresUrl } from '../db/test-database-url.js';
import { env } from '../env.js';
import { pool, withStore } from '../db/client.js';
import { withLockedSet } from '../db/locks.js';
import * as s from '../db/schema.js';
import { issue } from '../account-credit/service.js';
import type { RefundResult } from './provider.js';

const providerMethods: string[] = [];
let outcome: RefundResult = { state: 'Settled', providerRef: 'synthetic-refund' };
let providerCalls = 0;
vi.mock('./provider.js', async original => {
  const actual = await original<typeof import('./provider.js')>();
  return { ...actual, getProvider(method: string) {
    providerMethods.push(method);
    if (method !== 'manual') throw new Error('External provider resolution forbidden by this fixture');
    return { method, requiresRedirect: false, async createPayment() { throw new Error('unused'); },
      async refundPayment() { providerCalls++; return outcome; } };
  } };
});
vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: vi.fn() }));
import { requestRefund, finalizeRefund, type RefundRequest } from './refunds.js';

const STORE = 'eeeeeeee-7777-4777-8777-777777777777';
const disposable = isDisposablePostgresUrl(process.env.DATABASE_URL ?? env.DATABASE_URL);
async function seed(options: { cashUnit?: number; allocation?: number[]; state?: 'Paid' | 'Refunded'; method?: string; paymentAmount?: number; redemption?: boolean } = {}) {
  const cashUnit = options.cashUnit ?? 0, allocation = options.allocation ?? [0, 100];
  return withStore(STORE, async tx => {
    await tx.insert(s.store).values({ id: STORE, slug: 'refund-credit-synthetic', name: 'Synthetic', currency: 'USD' });
    const issued = await issue(tx, { storeId: STORE, amount: 1000, email: 'synthetic@example.invalid', issuanceKey: 'refund-fixture' });
    const [order] = await tx.insert(s.order).values({ storeId: STORE, code: randomUUID(), state: options.state ?? 'Paid', currency: 'USD',
      subtotal: cashUnit * 2 + 100, discountTotal: 100, shippingTotal: 50, grandTotal: cashUnit * 2 + 50,
      metadata: { contact: { email: 'buyer@example.invalid' } } }).returning();
    const [product] = await tx.insert(s.product).values({ storeId: STORE, slug: 'synthetic', name: 'Synthetic', status: 'active' }).returning();
    const [variant] = await tx.insert(s.productVariant).values({ storeId: STORE, productId: product!.id, sku: 'SYNTHETIC', name: 'Synthetic', price: 100, fulfillmentType: 'physical' }).returning();
    await tx.insert(s.stock).values({ storeId: STORE, variantId: variant!.id, onHand: 10, allocated: 0 });
    const [line] = await tx.insert(s.orderLine).values({ storeId: STORE, orderId: order!.id, variantId: variant!.id, variantSku: 'SYNTHETIC', variantName: 'Synthetic',
      quantity: 2, fulfilledQty: 2, unitPrice: cashUnit + 50, lineSubtotal: (cashUnit + 50) * 2, lineDiscount: 100, lineTotal: cashUnit * 2,
      metadata: { vendure: { quantity: 2, placedQuantity: 2, listPrice: cashUnit + 50, listPriceIncludesTax: true,
        adjustments: [{ amount: -100, type: 'PROMOTION' }], taxLines: [] } } }).returning();
    const [payment] = await tx.insert(s.payment).values({ storeId: STORE, orderId: order!.id, amount: options.paymentAmount ?? cashUnit * 2 + 50,
      method: options.method ?? 'nmi', state: 'Settled', currency: 'USD' }).returning();
    const redeemed = allocation.reduce((n, v) => n + v, 0);
    const redemptionId = randomUUID();
    if (options.redemption !== false) {
      await tx.update(s.accountCredit).set({ balance: 1000 - redeemed }).where(eq(s.accountCredit.id, issued.account.id));
      await tx.insert(s.accountCreditTransaction).values({ id: redemptionId, storeId: STORE, accountCreditId: issued.account.id,
        kind: 'REDEEM', status: 'POSTED', orderId: order!.id, orderCode: order!.code, amount: redeemed, delta: -redeemed,
        balanceAfter: 1000 - redeemed, idempotencyKey: 'fixture-redeem', operationalAllocation: { [line!.id]: allocation } });
    }
    if (options.state === 'Refunded') await tx.insert(s.refund).values({ storeId: STORE, orderId: order!.id, paymentId: payment!.id,
      amount: payment!.amount, itemsAmount: 0, shippingAmount: payment!.amount, state: 'Settled', metadata: { effectsApplied: true } });
    return { order: order!, line: line!, payment: payment!, accountId: issued.account.id, redemptionId, variantId: variant!.id };
  });
}
function request(f: Awaited<ReturnType<typeof seed>>, key: string, extra: Partial<RefundRequest> = {}): RefundRequest {
  return { storeId: STORE, orderId: f.order.id, actor: 'synthetic', idempotencyKey: key,
    lines: [{ orderLineId: f.line.id, quantity: 1, restock: true }], creditMerchandiseReturn: true, ...extra };
}
async function snapshot(f: Awaited<ReturnType<typeof seed>>) {
  return withStore(STORE, async tx => ({
    order: (await tx.select().from(s.order).where(eq(s.order.id, f.order.id)))[0]!,
    line: (await tx.select().from(s.orderLine).where(eq(s.orderLine.id, f.line.id)))[0]!,
    account: (await tx.select().from(s.accountCredit).where(eq(s.accountCredit.id, f.accountId)))[0]!,
    stock: (await tx.select().from(s.stock).where(eq(s.stock.variantId, f.variantId)))[0]!,
    restores: await tx.select().from(s.accountCreditTransaction).where(and(eq(s.accountCreditTransaction.orderId, f.order.id), eq(s.accountCreditTransaction.kind, 'RESTORE'))),
    redemption: (await tx.select().from(s.accountCreditTransaction).where(eq(s.accountCreditTransaction.id, f.redemptionId)))[0],
    refunds: await tx.select().from(s.refund).where(eq(s.refund.orderId, f.order.id)),
    attempts: await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.orderId, f.order.id)),
    reversals: await tx.select().from(s.settlementOperation).where(and(eq(s.settlementOperation.orderId, f.order.id), eq(s.settlementOperation.operationKind, 'order_refunded'))),
    emails: (await tx.execute(sql`SELECT count(*)::int AS n FROM email_outbox WHERE store_id = ${STORE} AND kind = 'order-refund-confirmation'`)).rows as { n: number }[],
  }));
}

describe.skipIf(!disposable)('settled refund credit restoration & explicit zero-cash authority', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE store CASCADE'); providerMethods.length = 0; providerCalls = 0;
    outcome = { state: 'Settled', providerRef: 'synthetic-refund' };
  });
  afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); await pool.end(); });

  it('returns zero-valued units after cash is exhausted, keeps original payment, & replays without repeating effects', async () => {
    const f = await seed({ state: 'Refunded' }); // original NMI account/mode deliberately absent
    const redemption = (await snapshot(f)).redemption;
    const input = request(f, 'zero-first');
    const first = await requestRefund(input);
    expect(first).toMatchObject({ refundState: 'Settled', refunded: 0, state: 'Refunded', creditRestoration: { state: 'posted', amount: 0 } });
    expect(await requestRefund(input)).toEqual(first);
    let state = await snapshot(f);
    expect(state.line.refundedQty).toBe(1); expect(state.stock.onHand).toBe(11); expect(state.account.balance).toBe(900);
    expect(state.restores).toHaveLength(1); expect(state.restores[0]).toMatchObject({ quantity: 1, amount: 0, refundId: first.refundId });
    expect(state.attempts[0]).toMatchObject({ method: 'credit_merchandise', mode: 'internal', amount: 0, paymentId: f.payment.id, status: 'settled', providerRef: null });
    expect(state.refunds.find(r => r.id === first.refundId)).toMatchObject({ paymentId: f.payment.id, amount: 0, state: 'Settled' });
    expect(state.reversals).toHaveLength(0); expect(state.emails[0]!.n).toBe(1);
    const second = await requestRefund(request(f, 'zero-second'));
    expect(second).toMatchObject({ creditRestoration: { state: 'posted', amount: 100 } });
    state = await snapshot(f);
    expect(state.account.balance).toBe(1000); expect(state.line.refundedQty).toBe(2); expect(state.stock.onHand).toBe(12);
    expect(state.redemption).toEqual(redemption);
    expect(state.reversals).toHaveLength(1); expect(providerMethods).toEqual([]); expect(providerCalls).toBe(0);
    await expect(requestRefund(request(f, 'zero-excess'))).rejects.toThrow('quantity');
    await expect(requestRefund({ ...input, creditMerchandiseReturn: false })).rejects.toThrow('Idempotency');
  });
  it('rejects implicit/money-only zero, missing redemption, missing allocation & positive cash overridden to zero', async () => {
    const f = await seed();
    await expect(requestRefund(request(f, 'implicit', { creditMerchandiseReturn: false }))).rejects.toThrow('balance');
    await expect(requestRefund(request(f, 'money-zero', { lines: [], amount: 0 }))).rejects.toThrow('explicit zero-cash');
    await withStore(STORE, tx => tx.update(s.accountCreditTransaction).set({ operationalAllocation: {} }).where(eq(s.accountCreditTransaction.id, f.redemptionId)));
    await expect(requestRefund(request(f, 'missing-link'))).rejects.toThrow('allocation');
    await withStore(STORE, tx => tx.delete(s.accountCreditTransaction).where(eq(s.accountCreditTransaction.id, f.redemptionId)));
    await expect(requestRefund(request(f, 'missing-redeem'))).rejects.toThrow('explicit zero-cash');
    expect((await snapshot(f)).attempts).toHaveLength(0); expect(providerMethods).toEqual([]);
  });
  it('requires original settled payment & rejects a positive-cash selected unit under zero authority', async () => {
    const f = await seed({ cashUnit: 100 });
    await expect(requestRefund(request(f, 'positive', { amount: 0 }))).rejects.toThrow('explicit zero-cash');
    await withStore(STORE, tx => tx.update(s.payment).set({ state: 'Failed' }).where(eq(s.payment.id, f.payment.id)));
    await expect(requestRefund(request(f, 'no-payment'))).rejects.toThrow('No settled payment');
    expect((await snapshot(f)).attempts).toHaveLength(0);
  });
  it('database rejects zero gateway attempts & incomplete/internal authority while retaining positive gateway amounts', async () => {
    const f = await seed();
    const valid = { storeId: STORE, orderId: f.order.id, paymentId: f.payment.id, operation: 'refund',
      method: 'credit_merchandise', accountId: f.accountId, mode: 'internal', amount: 0, currency: 'USD',
      fingerprint: 'synthetic', context: { authority: 'credit_merchandise', redemptionId: f.redemptionId } };
    const invalid: Array<Partial<typeof s.paymentAttempt.$inferInsert>> = [
      { method: 'stripe', mode: 'live' }, { method: 'nmi', mode: 'test' }, { method: 'sezzle', mode: 'live' },
      { context: null }, { context: { authority: 'credit_merchandise' } },
      { context: { authority: 'cash_refund', redemptionId: f.redemptionId } },
      { context: { authority: 'credit_merchandise', redemptionId: '' } },
      { mode: 'live' }, { operation: 'charge' }, { amount: -1 }, { amount: 1 },
      { paymentId: null }, { providerRef: 'not-a-cash-refund' },
    ];
    for (const [index, override] of invalid.entries()) {
      await expect(withStore(STORE, tx => tx.insert(s.paymentAttempt).values({ ...valid, ...override,
        idempotencyKey: `invalid-zero-${index}` }))).rejects.toMatchObject({ cause: { code: '23514' } });
    }
    await withStore(STORE, tx => tx.insert(s.paymentAttempt).values({ ...valid, method: 'stripe', mode: 'test',
      amount: 1, idempotencyKey: 'positive-gateway' }));
    expect((await snapshot(f)).attempts).toMatchObject([{ method: 'stripe', mode: 'test', amount: 1 }]);
    expect(providerMethods).toEqual([]); expect(providerCalls).toBe(0);
  });
  it('restores only after Settled; failed posting preserves cash settlement & exact retry never repeats qty/stock/email', async () => {
    const f = await seed({ cashUnit: 100, allocation: [50, 51], method: 'manual' });
    outcome = { state: 'Pending', providerRef: null };
    const input = request(f, 'cash', { creditMerchandiseReturn: false });
    const pending = await requestRefund(input);
    expect(pending.refundState).toBe('Pending'); expect((await snapshot(f)).restores).toHaveLength(0);
    let state = await snapshot(f); const attempt = state.attempts[0]!;
    await withStore(STORE, tx => tx.update(s.accountCreditTransaction).set({ operationalAllocation: {} }).where(eq(s.accountCreditTransaction.id, f.redemptionId)));
    const settled = await withLockedSet(STORE, { kind: 'order', orderId: f.order.id }, tx => finalizeRefund(tx, STORE, attempt.id, { state: 'Settled', providerRef: 'synthetic-settled' }));
    expect(settled).toMatchObject({ refundState: 'Settled', refunded: 100, creditRestoration: { state: 'reconciliation_required', amount: 0 } });
    state = await snapshot(f); expect(state.line.refundedQty).toBe(1); expect(state.stock.onHand).toBe(11); expect(state.emails[0]!.n).toBe(1);
    await withStore(STORE, tx => tx.update(s.accountCreditTransaction).set({ operationalAllocation: { [f.line.id]: [50, 51] } }).where(eq(s.accountCreditTransaction.id, f.redemptionId)));
    expect(await requestRefund(input)).toMatchObject({ refundState: 'Settled', creditRestoration: { state: 'posted', amount: 50 } });
    expect(await requestRefund(input)).toMatchObject({ creditRestoration: { state: 'posted', amount: 50 } });
    state = await snapshot(f); expect(state.line.refundedQty).toBe(1); expect(state.stock.onHand).toBe(11); expect(state.emails[0]!.n).toBe(1);
    expect(state.restores).toHaveLength(1); expect(state.account.balance).toBe(949); expect(providerCalls).toBe(1);
    await withLockedSet(STORE, { kind: 'order', orderId: f.order.id }, tx => finalizeRefund(tx, STORE, attempt.id, { state: 'Failed', providerRef: null }));
    expect((await snapshot(f)).refunds[0]!.state).toBe('Settled');
  });
  it('partial zero return on a historical amount-zero payment does not fully reverse order', async () => {
    const f = await seed({ paymentAmount: 0 });
    expect(await requestRefund(request(f, 'historical-zero'))).toMatchObject({ state: 'PartiallyRefunded', refundState: 'Settled' });
    expect((await snapshot(f)).reversals).toHaveLength(0);
  });
});
