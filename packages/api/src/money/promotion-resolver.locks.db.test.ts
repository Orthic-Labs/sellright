// P3a B1/C4: quotes take zero promotion row locks; payment-mode resolution locks only the candidate rows
// (automatic promotions + requested codes) and still serializes concurrent use of a limited coupon.
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore, type Tx } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { resolvePromotionStack, type ResolvePromotionStackInput } from './promotion-resolver.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'promotion-resolver.locks.db.test.ts');
const STORE = 'b0610000-0000-4000-8000-000000000001';
const ORDER = 'b0610000-0000-4000-8000-000000000003';
const SAVE = 'b0610000-0000-4000-8000-000000000010';
const UNRELATED = 'b0610000-0000-4000-8000-000000000011';
const AUTO = 'b0610000-0000-4000-8000-000000000012';
const CREDIT = 'b0610000-0000-4000-8000-000000000013';
const ACCOUNT = 'b0610000-0000-4000-8000-000000000014';

const input = (patch: Partial<ResolvePromotionStackInput> = {}): ResolvePromotionStackInput => ({
  storeId: STORE, currency: 'USD', couponCodes: ['SAVE'], phase: 'AddingItems',
  pricesIncludeTax: false, lines: [{ key: 'SKU', quantity: 1, placedQuantity: 1, unitListPrice: 1000, priceIncludesTax: false, taxRateBps: 0 }],
  shipping: 0, shippingTaxRateBps: 0, shippingIncludesTax: false, couponContext: { activeVerifications: [] }, ...patch,
});

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await withStore(STORE, async tx => {
    await tx.insert(s.store).values({ id: STORE, slug: 'stack-locks', name: 'stack-locks', currency: 'USD' });
    await tx.insert(s.order).values({ id: ORDER, storeId: STORE, code: 'LOCK-ORDER', currency: 'USD', state: 'PendingPayment' });
    await tx.insert(s.promotion).values([
      { id: SAVE, storeId: STORE, code: 'SAVE', type: 'fixed', value: 100, discountScope: 'order', priority: 0, stackOrder: 0 },
      { id: UNRELATED, storeId: STORE, code: 'UNRELATED', type: 'fixed', value: 300, discountScope: 'order', priority: 2, stackOrder: 2 },
      { id: AUTO, storeId: STORE, code: null, type: 'fixed', value: 50, discountScope: 'order', priority: 1, stackOrder: 1 },
      { id: CREDIT, storeId: STORE, code: 'CREDIT-X', type: 'account_credit', value: 0, discountScope: 'order', priority: 10, stackOrder: 10, conditions: [] },
    ]);
    await tx.insert(s.accountCredit).values({ id: ACCOUNT, storeId: STORE, promotionId: CREDIT, currency: 'USD',
      emailNormalized: 'other-customer@example.test', issuanceKey: 'credit-x', initialAmount: 400, balance: 400 });
  });
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); });

/** Holds FOR UPDATE on one promotion row in its own transaction until release() is called. */
async function holdPromotion(id: string) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let locked!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const done = withStore(STORE, async tx => {
    await tx.execute(sql`SELECT 1 FROM promotion WHERE id = ${id} FOR UPDATE`);
    locked();
    await gate;
  });
  await ready;
  return { release: async () => { release(); await done; } };
}

const resolveWithin = (patch: Partial<ResolvePromotionStackInput>, inspect?: (tx: Tx) => Promise<unknown>) => withStore(STORE, async tx => {
  await tx.execute(sql`SET LOCAL lock_timeout = '300ms'`);
  const result = await resolvePromotionStack(tx, input(patch));
  return { result, inspected: inspect ? await inspect(tx) : undefined };
});
const rowShareLocksOnPromotion = async (tx: Tx) => {
  const r = await tx.execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE pid = pg_backend_pid()
    AND relation = 'promotion'::regclass AND mode = 'RowShareLock'`);
  return Number((r.rows[0] as { n: number }).n);
};

describe('B1: quotes never take promotion row locks', () => {
  it('a checkout-intent quote (selectedCreditOnly) holds no promotion row lock', async () => {
    const { result, inspected } = await resolveWithin({ couponCodes: ['CREDIT-X'], selectedCreditOnly: true, orderId: ORDER }, rowShareLocksOnPromotion);
    expect(inspected).toBe(0);
    expect(result.selectedCredit).toMatchObject({ accountId: ACCOUNT, appliedAmount: 400 });
  });

  it('a checkout-intent quote is not blocked by a payment holding the requested promotion', async () => {
    const holder = await holdPromotion(CREDIT);
    try {
      const { result } = await resolveWithin({ couponCodes: ['CREDIT-X', 'SAVE'], selectedCreditOnly: true });
      expect(result.selectedCredit).toMatchObject({ accountId: ACCOUNT });
    } finally { await holder.release(); }
  });

  it('payment mode keeps commit authority: it waits for (and times out on) a locked requested promotion', async () => {
    const holder = await holdPromotion(SAVE);
    try {
      await expect(resolveWithin({ mode: 'payment', orderId: ORDER })).rejects.toThrow();
    } finally { await holder.release(); }
  });
});

describe('C4: candidate-only loading', () => {
  it('payment mode locks only automatic + requested promotions, never an unrelated coupon', async () => {
    const holder = await holdPromotion(UNRELATED);
    try {
      const { result } = await resolveWithin({ mode: 'payment', orderId: ORDER });
      // SAVE (100) + automatic (50); UNRELATED never considered.
      expect(result.discountTotal).toBe(150);
      expect(result.applied.map(entry => entry.promotionId).sort()).toEqual([SAVE, AUTO].sort());
    } finally { await holder.release(); }
  });

  it('payment mode still locks automatic promotions', async () => {
    const holder = await holdPromotion(AUTO);
    try {
      await expect(resolveWithin({ mode: 'payment', orderId: ORDER, couponCodes: [] })).rejects.toThrow();
    } finally { await holder.release(); }
  });

  it('never reads another bearer credit that was not requested', async () => {
    const { result } = await resolveWithin({ couponCodes: ['SAVE'] });
    expect(JSON.stringify(result)).not.toContain(ACCOUNT);
    expect(JSON.stringify(result)).not.toContain('other-customer');
  });

  it('matches non-ASCII codes case-insensitively exactly as before (JS casefold, superset load)', async () => {
    await withStore(STORE, tx => tx.insert(s.promotion).values({ storeId: STORE, code: 'CAFÉ', type: 'fixed', value: 70, discountScope: 'order', priority: 3, stackOrder: 3 }));
    const { result } = await resolveWithin({ couponCodes: ['café'] });
    expect(result.coupons[0]).toMatchObject({ code: 'café', applied: true, appliedAmount: 70 });
  });

  it('usage facts are read with a bounded number of promotion_usage statements (no per-promotion N+1)', async () => {
    const codes = Array.from({ length: 12 }, (_, i) => `L${i + 1}`);
    await withStore(STORE, tx => tx.insert(s.promotion).values(codes.map((code, i) => ({ storeId: STORE, code, type: 'fixed' as const, value: 1,
      discountScope: 'order' as const, priority: 20 + i, stackOrder: 20 + i, usageLimit: 5, usedCount: 1, perCustomerUsageLimit: 2 }))));
    const statements = await countStatements(() => resolveWithin({ couponCodes: codes, orderId: ORDER, customerEmail: 'guest@example.test' })
      .then(({ result }) => expect(result.coupons.every(status => status.applied)).toBe(true)));
    const usage = statements.filter(text => text.includes('"promotion_usage"'));
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.length).toBeLessThanOrEqual(3);
  });
});

/** Every SQL text any pg client sends while `fn` runs (the suite runs files serially). */
async function countStatements(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const query = Client.prototype.query;
  const spy = vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
    const first = args[0] as string | { text?: string };
    seen.push(typeof first === 'string' ? first : first?.text ?? '');
    return (query as (...a: unknown[]) => unknown).apply(this, args);
  } as never);
  try { await fn(); } finally { spy.mockRestore(); }
  return seen;
}

describe('coupon limit invariant under concurrency (payment mode + usage write, as checkout does)', () => {
  it('two concurrent payments for a 1-use coupon: exactly one applies it', async () => {
    await withStore(STORE, tx => tx.update(s.promotion).set({ usageLimit: 1 }).where(eq(s.promotion.id, SAVE)));
    const ORDER_2 = 'b0610000-0000-4000-8000-000000000004';
    await withStore(STORE, tx => tx.insert(s.order).values({ id: ORDER_2, storeId: STORE, code: 'LOCK-ORDER-2', currency: 'USD', state: 'PendingPayment' }));
    const pay = (orderId: string) => withStore(STORE, async tx => {
      const result = await resolvePromotionStack(tx, input({ mode: 'payment', orderId }));
      const applied = result.applied.some(entry => entry.promotionId === SAVE);
      if (applied) {
        await tx.insert(s.promotionUsage).values({ storeId: STORE, promotionId: SAVE, orderId });
        await tx.update(s.promotion).set({ usedCount: sql`${s.promotion.usedCount} + 1` }).where(eq(s.promotion.id, SAVE));
        await tx.execute(sql`SELECT pg_sleep(0.05)`);
      }
      return applied;
    });
    const outcomes = await Promise.all([pay(ORDER), pay(ORDER_2)]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const [row] = await withStore(STORE, tx => tx.select({ used: s.promotion.usedCount }).from(s.promotion).where(eq(s.promotion.id, SAVE)));
    expect(row!.used).toBe(1);
  });
});
