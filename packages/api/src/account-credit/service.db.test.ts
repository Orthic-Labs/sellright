/** Synthetic fixtures only. Root integration owns execution against a disposable *_test DB. */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { adjust, currentDiscount, disable, issue, previewAvailable, redeem, redeemAfterSettlement, release, reserve, restoreManual, restoreRefund, restoreRefundAfterSettlement } from './service.js';

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

describe('monetary account credit', () => {
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
