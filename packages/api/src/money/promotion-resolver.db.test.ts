import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { resolvePromotionStack, type ResolvePromotionStackInput } from './promotion-resolver.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'promotion-resolver.db.test.ts');
const STORE = 'b0600000-0000-4000-8000-000000000001';
const OTHER = 'b0600000-0000-4000-8000-000000000002';
const ORDER = 'b0600000-0000-4000-8000-000000000003';
const CREDIT_A = 'b0600000-0000-4000-8000-000000000004';
const CREDIT_B = 'b0600000-0000-4000-8000-000000000005';
const ACCOUNT_A = 'b0600000-0000-4000-8000-000000000006';
const ACCOUNT_B = 'b0600000-0000-4000-8000-000000000007';
const input = (patch: Partial<ResolvePromotionStackInput> = {}): ResolvePromotionStackInput => ({
  storeId: STORE, currency: 'USD', couponCodes: ['SAVE'], phase: 'AddingItems',
  pricesIncludeTax: false, lines: [{ key: 'SKU', quantity: 1, placedQuantity: 1, unitListPrice: 1000, priceIncludesTax: false, taxRateBps: 0 }],
  shipping: 100, shippingTaxRateBps: 0, shippingIncludesTax: false, couponContext: { activeVerifications: [] }, ...patch,
});
beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  for (const [id, slug] of [[STORE, 'stack'], [OTHER, 'stack-other']] as const) await withStore(id, async tx => {
    await tx.insert(s.store).values({ id, slug, name: slug, currency: 'USD' });
    await tx.insert(s.promotion).values({ storeId: id, code: 'SAVE', type: 'percentage', value: id === STORE ? 10 : 99,
      discountScope: 'order', priority: 0, stackOrder: 0 });
    if (id === STORE) {
      await tx.insert(s.order).values({ id: ORDER, storeId: STORE, code: 'CREDIT-ORDER', currency: 'USD', state: 'Paid' });
      for (const [promotionId, accountId, code, priority] of [[CREDIT_A, ACCOUNT_A, 'CREDIT-A', 10], [CREDIT_B, ACCOUNT_B, 'CREDIT-B', 20]] as const) {
        await tx.insert(s.promotion).values({ id: promotionId, storeId: STORE, code, type: 'account_credit', value: 0,
          discountScope: 'order', priority, stackOrder: priority, conditions: [] });
        await tx.insert(s.accountCredit).values({ id: accountId, storeId: STORE, promotionId, currency: 'USD', emailNormalized: 'private-issuance@example.test',
          issuanceKey: code, initialAmount: 500, balance: 500 });
      }
    }
  });
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); });
const resolve = (patch: Partial<ResolvePromotionStackInput> = {}) => withStore(STORE, tx => resolvePromotionStack(tx, input(patch)));

describe('promotion resolver transaction eligibility', () => {
  it('casefolds requested codes, retains all automatic promos & confines resolution to current store', async () => {
    await withStore(STORE, tx => tx.insert(s.promotion).values({ storeId: STORE, type: 'fixed', value: 100,
      code: null, discountScope: 'order', priority: 1, stackOrder: 1 }));
    const result = await resolve({ couponCodes: ['save', 'SAVE'] });
    expect(result.coupons).toHaveLength(1);
    expect(result.discountTotal).toBe(200);
    expect(result.applied).toHaveLength(2);
    expect(result.coupons[0]).toMatchObject({ code: 'save', applied: true, appliedAmount: 100 });
  });

  it('quotes credit by bearer code with no issuance email/customer ownership requirement', async () => {
    const result = await resolve({ couponCodes: [' CREDIT-A '] });
    expect(result.selectedCredit).toMatchObject({ accountId: ACCOUNT_A, appliedAmount: 500 });
    expect(result.coupons[0]?.code).toBe('CREDIT-A');
    expect(JSON.stringify(result)).not.toContain('private-issuance');
    await expect(resolve({ currency: 'EUR' })).rejects.toThrow(/currency/);
    await expect(resolve({ orderId: 'b0600000-0000-4000-8000-000000000099' })).rejects.toThrow(/order/);
  });

  it('payment candidate gives only first credit code budget; later pricing reads exact own hold', async () => {
    const candidate = await resolve({ couponCodes: ['CREDIT-B', 'CREDIT-A'], mode: 'payment', orderId: ORDER });
    expect(candidate.selectedCredit).toMatchObject({ accountId: ACCOUNT_B, appliedAmount: 500 });
    expect(candidate.coupons.find(status => status.code === 'CREDIT-A')).toMatchObject({ applied: false, appliedAmount: 0 });
    await withStore(STORE, tx => tx.insert(s.accountCreditTransaction).values({ storeId: STORE, accountCreditId: ACCOUNT_B,
      orderId: ORDER, orderCode: 'CREDIT-ORDER', kind: 'RESERVE', status: 'PENDING', amount: 123, delta: 0, idempotencyKey: 'hold-test' }));
    const reserved = await resolve({ couponCodes: ['CREDIT-B', 'CREDIT-A'], orderId: ORDER, phase: 'ArrangingPayment' });
    expect(reserved.selectedCredit).toMatchObject({ accountId: ACCOUNT_B, appliedAmount: 123 });
    expect(reserved.applied.filter(entry => entry.kind === 'account_credit')).toHaveLength(1);
  });

  it('skips disabled or missing-account credit rows when choosing first payment credit', async () => {
    await withStore(STORE, async tx => {
      await tx.update(s.promotion).set({ enabled: false }).where(eq(s.promotion.id, CREDIT_A));
      await tx.insert(s.promotion).values({ storeId: STORE, code: 'MISSING-ACCOUNT', type: 'account_credit', value: 0,
        discountScope: 'order', priority: 5, stackOrder: 5 });
    });
    const result = await resolve({ couponCodes: ['CREDIT-A', 'MISSING-ACCOUNT', 'CREDIT-B'], mode: 'payment', orderId: ORDER });
    expect(result.selectedCredit).toMatchObject({ accountId: ACCOUNT_B, appliedAmount: 500 });
    expect(result.coupons.slice(0, 2).every(status => !status.applied)).toBe(true);
  });

  it('refuses payment rather than silently charging cash when first matched credit stops applying', async () => {
    await withStore(STORE, tx => tx.update(s.promotion).set({ conditions: [{ code: 'minimum_order_amount', args: [{ name: 'amount', value: '2000' }] }] }).where(eq(s.promotion.id, CREDIT_B)));
    const quote = await resolve({ couponCodes: ['CREDIT-B'], orderId: ORDER });
    expect(quote.selectedCredit).toBeNull();
    expect(quote.coupons[0]).toMatchObject({ applied: false });
    await expect(resolve({ couponCodes: ['CREDIT-B', 'CREDIT-A'], mode: 'payment', orderId: ORDER })).rejects.toMatchObject({ code: 'CREDIT_AMOUNT_CHANGED' });
    await withStore(STORE, tx => tx.update(s.accountCredit).set({ balance: 0 }).where(eq(s.accountCredit.id, ACCOUNT_B)));
    await expect(resolve({ couponCodes: ['CREDIT-B', 'CREDIT-A'], mode: 'payment', orderId: ORDER })).rejects.toMatchObject({ code: 'CREDIT_AMOUNT_CHANGED' });
  });

  it('admits matching own hold & refuses disabled, missing or mismatched credit before cash fallback', async () => {
    await withStore(STORE, tx => tx.insert(s.accountCreditTransaction).values({ storeId: STORE, accountCreditId: ACCOUNT_B,
      orderId: ORDER, orderCode: 'CREDIT-ORDER', kind: 'RESERVE', status: 'PENDING', amount: 500, delta: 0, idempotencyKey: 'matching-own-hold' }));
    const admitted = await resolve({ couponCodes: ['CREDIT-B'], mode: 'payment', orderId: ORDER, phase: 'ArrangingPayment' });
    expect(admitted.selectedCredit).toMatchObject({ accountId: ACCOUNT_B, appliedAmount: 500 });
    await expect(resolve({ couponCodes: ['CREDIT-A'], mode: 'payment', orderId: ORDER })).rejects.toMatchObject({ code: 'CREDIT_AMOUNT_CHANGED' });
    await expect(resolve({ couponCodes: [], mode: 'payment', orderId: ORDER })).rejects.toMatchObject({ code: 'CREDIT_AMOUNT_CHANGED' });
    await withStore(STORE, tx => tx.update(s.promotion).set({ enabled: false }).where(eq(s.promotion.id, CREDIT_B)));
    await expect(resolve({ couponCodes: ['CREDIT-B'], mode: 'payment', orderId: ORDER })).rejects.toMatchObject({ code: 'CREDIT_AMOUNT_CHANGED' });
  });

  it('reports expired/disabled/limited/ambiguous codes without applying them', async () => {
    await withStore(STORE, async tx => {
      await tx.insert(s.promotion).values([
        { storeId: STORE, code: 'EXPIRED', type: 'fixed', value: 100, endsAt: new Date('2000-01-01T00:00:00Z') },
        { storeId: STORE, code: 'DISABLED', type: 'fixed', value: 100, enabled: false },
        { storeId: STORE, code: 'LIMITED', type: 'fixed', value: 100, usageLimit: 1, usedCount: 1 },
        { storeId: STORE, code: 'DUPE', type: 'fixed', value: 100 }, { storeId: STORE, code: 'dupe', type: 'fixed', value: 200 },
      ]);
    });
    const result = await resolve({ couponCodes: ['EXPIRED', 'DISABLED', 'LIMITED', 'DUPE'] });
    expect(result.discountTotal).toBe(0);
    expect(result.coupons.every(status => !status.applied && !!status.reason)).toBe(true);
    expect(result.coupons.find(status => status.code === 'DUPE')?.promotionId).toBeNull();
  });

  it('refuses unproven source order-action ties instead of sorting UUIDs as source evidence', async () => {
    await withStore(STORE, tx => tx.insert(s.promotion).values({ storeId: STORE, code: null, type: 'fixed', value: 100,
      discountScope: 'order', priority: 0, stackOrder: null }));
    await expect(resolve()).rejects.toThrow(/stack order is unresolved/);
  });
});
