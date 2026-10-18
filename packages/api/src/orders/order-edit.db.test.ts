/**
 * Order editing (spec G13 / G5) — DB integration. Every operation, every
 * settlement path, address edits (guest + customer, same + different country),
 * stale-preview rejection, idempotent commit, locked fulfilled quantity, stock
 * deltas, refund-difference, and the pay-link balance charge through /pay.
 *
 * Runs against a *_test DB only (TRUNCATEs store CASCADE). The Stripe provider
 * is mocked at the provider boundary: createPayment echoes the charged amount
 * (so the balance-only charge is observable) and refundPayment records calls.
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { calculateOrderTotals } from '../money/totals.js';
import { clearLoginAttempts } from '../auth/rate-limit.js';
import { derivePaymentStatus } from './status.js';
import { retainedDetachedHistoryFixture } from '../import/retained-history-fixture.js';

const refundCalls: Array<{ providerRef: string | null; amount: number; idempotencyKey?: string }> = [];
const chargeCalls: Array<{ orderCode: string; amount: number }> = [];
vi.mock('../payments/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../payments/provider.js')>();
  const stripeTest = {
    method: 'stripe', requiresRedirect: false,
    async createPayment(input: { orderCode: string; amount: number }) {
      chargeCalls.push({ orderCode: input.orderCode, amount: input.amount });
      return { state: 'Settled' as const, providerRef: `pi_bal_${input.orderCode}_${input.amount}_${chargeCalls.length}`, metadata: { test: true } };
    },
    async refundPayment(input: { providerRef: string | null; amount: number; idempotencyKey?: string }) {
      refundCalls.push({ providerRef: input.providerRef, amount: input.amount, idempotencyKey: input.idempotencyKey });
      if (nextRefundPending) { nextRefundPending = false; return { state: 'Pending' as const, providerRef: `re_pend_${refundCalls.length}` }; }
      if (failNextRefund) { failNextRefund = false; return { state: 'Failed' as const, providerRef: null }; }
      return { state: 'Settled' as const, providerRef: `re_${refundCalls.length}` };
    },
  };
  return { ...actual, getProvider: (m: string) => (m === 'stripe' ? stripeTest : actual.getProvider(m)) };
});
let failNextRefund = false;
let nextRefundPending = false;
const intentSpy = vi.hoisted(() => ({ calls: [] as string[], cancel: true }));
vi.mock('../payments/stripe-reconcile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../payments/stripe-reconcile.js')>();
  const { withStore: ws } = await import('../db/client.js');
  return { ...actual, cancelOrderStripeIntents: async (storeId: string, orderId: string) => {
    intentSpy.calls.push(orderId);
    if (intentSpy.cancel) await ws(storeId, (tx) => tx.execute(sql`update payment_attempt set status = 'cancelled' where order_id = ${orderId} and operation = 'intent'`));
  } };
});
const stockHook = vi.hoisted(() => ({ onStockChanged: vi.fn() }));
vi.mock('../manifest/stock-hook.js', () => stockHook);

import { pay } from '../routes/pay.js';
import { commitOrderEdit, previewOrderEdit, saveOrderAddress, loadEditContext, OrderEditError, type CommitInput } from './order-edit-service.js';
import type { EditOpT, SettlementT } from './order-edit.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'order-edit.db.test.ts');

const STORE = 'e0000000-0000-0000-0000-0000000e0001';
const SLUG = 'orderedit-test';
const RT = 'rt_order_edit_receipt_token_abcdefghijkl';
const app = new OpenAPIHono();
app.route('/', pay);

let V: Record<string, { id: string; sku: string }> = {};

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

async function seed() {
  await withStore(STORE, async (tx) => {
    await tx.insert(s.store).values({ id: STORE, slug: SLUG, name: 'Edit Test', currency: 'USD', config: { payments: { stripe: true }, storefrontUrl: 'https://shop.example.test' } });
    const [p] = await tx.insert(s.product).values({ storeId: STORE, slug: 'p', name: 'Widget', status: 'active' }).returning({ id: s.product.id });
    const mk = async (sku: string, price: number, onHand: number, extra: Partial<typeof s.productVariant.$inferInsert> = {}) => {
      const [v] = await tx.insert(s.productVariant).values({ storeId: STORE, productId: p!.id, sku, name: `Widget ${sku}`, price, ...extra }).returning({ id: s.productVariant.id });
      await tx.insert(s.stock).values({ variantId: v!.id, storeId: STORE, onHand, allocated: 0 });
      V[sku] = { id: v!.id, sku };
    };
    await mk('A', 1000, 20); await mk('B', 2000, 20); await mk('C', 500, 1);
    await mk('L', 1000, 0, { fulfillmentType: 'license', appKey: 'testapp' }); await mk('M', 1000, 0, { fulfillmentType: 'license', appKey: 'testapp' });
    await tx.insert(s.shippingMethod).values([
      { storeId: STORE, code: 'std', name: 'Standard', calculator: { flat: 500 } },
      { storeId: STORE, code: 'exp', name: 'Express', calculator: { flat: 1500 } },
    ]);
    await tx.insert(s.promotion).values({ storeId: STORE, code: 'TEN', type: 'percentage', value: 10 });
  });
}

interface SeedLine { sku: string; qty: number; fulfilled?: number; refunded?: number; cancelled?: number }
interface SeedPay { amount: number; method?: string; ref?: string }
async function makeOrder(o: {
  code?: string; state?: 'PendingPayment' | 'Paid' | 'PartiallyRefunded' | 'Refunded' | 'Cancelled'; lines?: SeedLine[]; shipping?: number;
  payments?: SeedPay[] | 'full'; customer?: boolean; ship?: Record<string, unknown>; email?: string | null; promotion?: boolean; taxRate?: number;
}): Promise<{ id: string; code: string; grandTotal: number; customerId: string | null }> {
  const code = o.code ?? 'SR' + Math.random().toString(16).slice(2, 12).toUpperCase();
  const state = o.state ?? 'Paid';
  const lines = o.lines ?? [{ sku: 'A', qty: 2 }];
  const price = (sku: string) => (sku === 'A' || sku === 'L' || sku === 'M' ? 1000 : sku === 'B' ? 2000 : 500);
  const promo = o.promotion ? { type: 'percentage' as const, value: 10 } : null;
  const t = calculateOrderTotals({ lines: lines.map((l) => ({ unitPrice: price(l.sku), quantity: l.qty })), shipping: o.shipping ?? 500, taxRate: o.taxRate ?? 0, promotion: promo });
  return withStore(STORE, async (tx) => {
    let customerId: string | null = null;
    if (o.customer) {
      const [c] = await tx.insert(s.customer).values({ storeId: STORE, email: 'cust@example.test', firstName: 'Cu', lastName: 'Stomer' }).returning({ id: s.customer.id });
      customerId = c!.id;
    }
    const [promoRow] = promo ? await tx.select().from(s.promotion).where(eq(s.promotion.code, 'TEN')) : [];
    const [ord] = await tx.insert(s.order).values({
      storeId: STORE, code, state, currency: 'USD', customerId, receiptToken: RT, promotionId: promoRow?.id ?? null,
      subtotal: t.subtotal, discountTotal: t.discountTotal, shippingTotal: t.shippingTotal, taxTotal: t.taxTotal, grandTotal: t.grandTotal,
      shippingMethodCode: o.shipping == null ? 'std' : null, shippingMethodName: o.shipping == null ? 'Standard' : null,
      shippingOverride: o.shipping != null,
      shippingAddress: o.ship ?? { fullName: 'Ship Er', line1: '1 Main St', city: 'Austin', province: 'TX', postalCode: '78701', country: 'US', phone: '555' },
      billingAddress: { fullName: 'Bill Er', line1: '2 Bill St', city: 'Austin', province: 'TX', postalCode: '78701', country: 'US' },
      metadata: o.email === null ? {} : { contact: { email: o.email ?? 'cust@example.test' } },
    }).returning({ id: s.order.id });
    for (const [i, l] of lines.entries()) {
      const lt = t.lines[i]!;
      await tx.insert(s.orderLine).values({
        storeId: STORE, orderId: ord!.id, variantId: V[l.sku]!.id, variantSku: l.sku, variantName: `Widget ${l.sku}`, quantity: l.qty, unitPrice: price(l.sku),
        lineSubtotal: lt.lineSubtotal, lineDiscount: lt.lineDiscount, lineTotal: lt.lineTotal, fulfilledQty: l.fulfilled ?? 0, refundedQty: l.refunded ?? 0, cancelledQty: l.cancelled ?? 0,
      });
      // The order holds an allocation for its open (unfulfilled) units.
      await tx.update(s.stock).set({ allocated: sql`${s.stock.allocated} + ${l.qty - (l.fulfilled ?? 0) - (l.cancelled ?? 0)}` }).where(eq(s.stock.variantId, V[l.sku]!.id));
    }
    const pays = o.payments === 'full' || (o.payments === undefined && state !== 'PendingPayment') ? [{ amount: t.grandTotal }] : o.payments ?? [];
    for (const [i, p] of pays.entries()) {
      await tx.insert(s.payment).values({ storeId: STORE, orderId: ord!.id, amount: p.amount, method: p.method ?? 'stripe', state: 'Settled', providerRef: p.ref ?? `pi_seed_${code}_${i}`, gatewayMode: 'test', currency: 'USD' });
    }
    return { id: ord!.id, code, grandTotal: t.grandTotal, customerId };
  });
}

const stock = async (sku: string) => withStore(STORE, async (tx) => { const [r] = await tx.select().from(s.stock).where(eq(s.stock.variantId, V[sku]!.id)); return r!; });
const orderRow = async (code: string) => withStore(STORE, async (tx) => { const [r] = await tx.select().from(s.order).where(eq(s.order.code, code)); return r!; });
const linesOf = async (code: string) => withStore(STORE, async (tx) => { const o = await orderRow(code); return tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id)); });
const outbox = async (kind?: string) => withStore(STORE, (tx) => tx.select().from(s.emailOutbox).where(kind ? eq(s.emailOutbox.kind, kind) : undefined));
const audits = async (action: string) => withStore(STORE, (tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.action, action)));

let key = 0;
async function acceptedCommit(code: string, ops: EditOpT[], over: Partial<CommitInput> = {}, settlement?: SettlementT): Promise<CommitInput> {
  const prev = await previewOrderEdit(STORE, code, ops, over);
  return {
    storeId: STORE, storeSlug: SLUG, code, actor: 'owner@example.test', principalKind: 'human', ops, expectedGrandTotal: prev.after.grandTotal,
    previewAcceptanceHash: prev.previewAcceptanceHash,
    idempotencyKey: `k-${++key}`, notifyCustomer: true, settlement, ...over,
  };
}
async function commit(code: string, ops: EditOpT[], over: Partial<CommitInput> = {}, settlement?: SettlementT) {
  return commitOrderEdit(await acceptedCommit(code, ops, over, settlement));
}
async function expectErr(p: Promise<unknown>, code: string) {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  expect(err, `expected ${code}`).toBeInstanceOf(OrderEditError);
  expect((err as OrderEditError).code).toBe(code);
}

beforeEach(async () => {
  clearLoginAttempts('unknown', 'pay:unknown');
  refundCalls.length = 0; chargeCalls.length = 0; failNextRefund = false; nextRefundPending = false; intentSpy.calls.length = 0; intentSpy.cancel = true; stockHook.onStockChanged.mockClear();
  V = {};
  await wipe(); await seed();
});
afterAll(async () => { await wipe(); });

describe('preview (stateless)', () => {
  it('keeps retained detached import history address-only & denies economic preview/commit without effects', async () => {
    const o = await makeOrder({}), line = (await linesOf(o.code))[0]!;
    const original = await orderRow(o.code);
    const metadata = retainedDetachedHistoryFixture({ storeId: STORE, orderId: o.id, orderLineId: line.id, metadata: original.metadata });
    await withStore(STORE, tx => tx.update(s.order).set({ metadata }).where(eq(s.order.id, o.id)));
    const snapshot = () => withStore(STORE, async tx => ({
      orders: await tx.select().from(s.order), lines: await tx.select().from(s.orderLine),
      stock: await tx.select().from(s.stock), payments: await tx.select().from(s.payment),
      edits: await tx.select().from(s.orderEdit), credit: await tx.select().from(s.accountCreditTransaction),
      outbox: await tx.select().from(s.emailOutbox), audits: await tx.select().from(s.auditLog),
    }));
    const before = await snapshot(), ops: EditOpT[] = [{ op: 'add_item', sku: 'A', quantity: 1 }];
    expect((await loadEditContext(STORE, o.code)).editable).toMatchObject({ items: false, address: true, addressOnly: true });
    await expectErr(previewOrderEdit(STORE, o.code, ops), 'ORDER_PRICING_EDIT_UNSUPPORTED');
    await expectErr(commitOrderEdit({ storeId: STORE, storeSlug: SLUG, code: o.code, actor: 'owner@example.test',
      principalKind: 'human', ops, expectedGrandTotal: o.grandTotal, idempotencyKey: 'detached-denied',
      notifyCustomer: true, settlement: { type: 'leave_due' } }), 'ORDER_PRICING_EDIT_UNSUPPORTED');
    expect(await snapshot()).toEqual(before);
    expect(refundCalls).toEqual([]); expect(chargeCalls).toEqual([]); expect(intentSpy.calls).toEqual([]);
    expect(stockHook.onStockChanged).not.toHaveBeenCalled();
    const address = { fullName: 'New Name', line1: '9 New St', line2: null, city: 'Dallas', province: 'TX', postalCode: '75001', country: 'US', phone: null };
    expect((await saveOrderAddress({ storeId: STORE, code: o.code, actor: 'owner@example.test', kind: 'shipping', address })).changed).toBe(true);
    const saved = await orderRow(o.code);
    expect(saved.grandTotal).toBe(o.grandTotal);
    expect(saved.metadata).toEqual(before.orders[0]!.metadata);
    expect(saved.pricingSnapshot).toBeNull();
  });

  it('shows new totals, per-line diff, stock check and balance — and writes nothing', async () => {
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }] }); // 2000+2000+500 = 4500
    const line = (await linesOf(o.code)).find((l) => l.variantSku === 'B')!;
    const p = await previewOrderEdit(STORE, o.code, [{ op: 'remove_line', lineId: line.id }]);
    expect(o.grandTotal).toBe(4500);
    expect(p.after.grandTotal).toBe(2500);
    expect(p.balance).toMatchObject({ settled: 4500, amountDue: -2000, newGrandTotal: 2500 });
    expect(p.lines.find((l) => l.sku === 'B')).toMatchObject({ change: 'removed', beforeQty: 1, afterQty: 0 });
    expect(p.settlementOptions).toEqual(['refund_now', 'leave_credit']);
    expect(p.refund?.feasible).toBe(true);
    expect((await orderRow(o.code)).grandTotal).toBe(4500);
    expect((await stock('B')).allocated).toBe(1);
    expect(await withStore(STORE, (tx) => tx.select().from(s.orderEdit))).toHaveLength(0);
  });

  it('flags insufficient stock for an added quantity without failing the preview', async () => {
    const o = await makeOrder({});
    const p = await previewOrderEdit(STORE, o.code, [{ op: 'add_item', sku: 'C', quantity: 3 }]);
    expect(p.stockOk).toBe(false);
    expect(p.stock.find((x) => x.sku === 'C')).toMatchObject({ delta: 3, available: 1, ok: false });
  });
});

describe('line operations', () => {
  it('remove item: row preserved at 0, unfulfilled stock released, totals recomputed, onStockChanged fires', async () => {
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }] });
    const before = await linesOf(o.code);
    const b = before.find((l) => l.variantSku === 'B')!;
    const r = await commit(o.code, [{ op: 'remove_line', lineId: b.id }], {}, { type: 'leave_credit' });
    expect(r.grandTotal).toBe(2500);
    const after = await linesOf(o.code);
    expect(after).toHaveLength(2);
    expect(after.find((l) => l.id === b.id)).toMatchObject({ quantity: 0, lineTotal: 0 });
    expect((await stock('B')).allocated).toBe(0);
    expect((await stock('A')).allocated).toBe(2);
    expect(stockHook.onStockChanged).toHaveBeenCalledWith(SLUG);
    const [edit] = await withStore(STORE, (tx) => tx.select().from(s.orderEdit));
    expect(edit).toMatchObject({ actor: 'owner@example.test', balance: -2000 });
    expect((edit!.before as { totals: { grandTotal: number } }).totals.grandTotal).toBe(4500);
    expect((edit!.after as { totals: { grandTotal: number } }).totals.grandTotal).toBe(2500);
    expect(await audits('edit')).toHaveLength(1);
  });

  it('change quantity up reserves ONLY the delta live; out of stock rolls everything back', async () => {
    const o = await makeOrder({ lines: [{ sku: 'C', qty: 1 }] }); // C has on_hand 1, allocated 1
    const l = (await linesOf(o.code))[0]!;
    await expectErr(commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 2 }], {}, { type: 'send_pay_link' }), 'OUT_OF_STOCK');
    expect((await orderRow(o.code)).grandTotal).toBe(o.grandTotal);
    expect((await stock('C')).allocated).toBe(1);
    expect(await withStore(STORE, (tx) => tx.select().from(s.orderEdit))).toHaveLength(0);
    expect(stockHook.onStockChanged).not.toHaveBeenCalled();

    const a = await makeOrder({ lines: [{ sku: 'A', qty: 1 }] });
    const la = (await linesOf(a.code))[0]!;
    const base = (await stock('A')).allocated;
    await commit(a.code, [{ op: 'set_quantity', lineId: la.id, quantity: 4 }], {}, { type: 'leave_due' });
    expect((await stock('A')).allocated).toBe(base + 3);
  });

  it('fulfilled and refunded quantity is locked; only the unfulfilled units move stock', async () => {
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 4, fulfilled: 1, refunded: 1, cancelled: 1 }] });
    const l = (await linesOf(o.code))[0]!;
    const alloc = (await stock('A')).allocated; // 3 open
    await expectErr(previewOrderEdit(STORE, o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 1 }]), 'LINE_LOCKED');
    const r = await commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 2 }], {}, { type: 'leave_credit' });
    expect(r.grandTotal).toBe(2000 + 500);
    expect((await stock('A')).allocated).toBe(alloc - 2);
    const row = (await linesOf(o.code))[0]!;
    expect(row).toMatchObject({ quantity: 2, fulfilledQty: 1, refundedQty: 1, id: l.id });
    // remove_line on a partly-shipped line removes only what is still open
    await commit(o.code, [{ op: 'remove_line', lineId: l.id }], {}, { type: 'leave_credit' });
    expect((await linesOf(o.code))[0]!.quantity).toBe(2);
  });

  it('add item creates a new row, reserves stock, raises the balance', async () => {
    const o = await makeOrder({});
    const base = (await stock('B')).allocated;
    const r = await commit(o.code, [{ op: 'add_item', sku: 'B', quantity: 2 }], {}, { type: 'leave_due' });
    expect(r.balance).toBe(4000);
    expect(r.amountDue).toBe(4000);
    expect(await linesOf(o.code)).toHaveLength(2);
    expect((await stock('B')).allocated).toBe(base + 2);
    const detail = derivePaymentStatus('Paid', [{ state: 'Settled' }], r.amountDue);
    expect(detail).toBe('balance_due');
  });

  it('swap variant re-points the row when nothing shipped, otherwise splits the open units', async () => {
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 2 }] });
    const l = (await linesOf(o.code))[0]!;
    await commit(o.code, [{ op: 'swap_variant', lineId: l.id, sku: 'B' }], {}, { type: 'send_pay_link' });
    const after = await linesOf(o.code);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: l.id, variantSku: 'B', quantity: 2, unitPrice: 2000 });
    expect((await stock('A')).allocated).toBe(0);
    expect((await stock('B')).allocated).toBe(2);

    const p = await makeOrder({ lines: [{ sku: 'A', qty: 3, fulfilled: 1 }] });
    const lp = (await linesOf(p.code))[0]!;
    await commit(p.code, [{ op: 'swap_variant', lineId: lp.id, sku: 'B', quantity: 1 }], {}, { type: 'send_pay_link' });
    const rows = await linesOf(p.code);
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.id === lp.id)).toMatchObject({ variantSku: 'A', quantity: 2, fulfilledQty: 1 });
    expect(rows.find((x) => x.id !== lp.id)).toMatchObject({ variantSku: 'B', quantity: 1 });
  });

  it('apply and remove a coupon (usage ledger follows)', async () => {
    const o = await makeOrder({ lines: [{ sku: 'B', qty: 1 }] }); // 2000 + 500
    const r1 = await commit(o.code, [{ op: 'apply_coupon', code: 'TEN' }], {}, { type: 'leave_credit' });
    expect(r1.grandTotal).toBe(1800 + 500);
    const promo = await withStore(STORE, async (tx) => (await tx.select().from(s.promotion).where(eq(s.promotion.code, 'TEN')))[0]!);
    expect(promo.usedCount).toBe(1);
    expect((await orderRow(o.code)).promotionId).toBe(promo.id);
    const r2 = await commit(o.code, [{ op: 'remove_coupon' }], {}, { type: 'leave_due' });
    expect(r2.grandTotal).toBe(2500);
    expect((await withStore(STORE, async (tx) => (await tx.select().from(s.promotion).where(eq(s.promotion.code, 'TEN')))[0]!)).usedCount).toBe(0);
    await expectErr(previewOrderEdit(STORE, o.code, [{ op: 'apply_coupon', code: 'NOPE' }]), 'COUPON_NOT_FOUND');
  });

  it('an existing discount stays applied while lines change', async () => {
    const o = await makeOrder({ lines: [{ sku: 'B', qty: 1 }], promotion: true }); // 1800 + 500
    expect(o.grandTotal).toBe(2300);
    const r = await commit(o.code, [{ op: 'add_item', sku: 'A', quantity: 1 }], {}, { type: 'leave_due' });
    expect(r.grandTotal).toBe(2700 + 500); // (2000+1000)*0.9 + 500
  });
});

describe('shipping and adjustments', () => {
  it('change shipping method, custom amount, remove shipping', async () => {
    const o = await makeOrder({});
    const r1 = await commit(o.code, [{ op: 'set_shipping_method', code: 'exp' }], {}, { type: 'leave_due' });
    expect(r1.grandTotal).toBe(2000 + 1500);
    expect((await orderRow(o.code)).shippingOverride).toBe(false);
    const r2 = await commit(o.code, [{ op: 'set_shipping_amount', amount: 123 }], {}, { type: 'leave_credit' });
    expect(r2.grandTotal).toBe(2000 + 123);
    expect((await orderRow(o.code)).shippingOverride).toBe(true);
    const r3 = await commit(o.code, [{ op: 'remove_shipping' }], {}, { type: 'leave_credit' });
    expect(r3.grandTotal).toBe(2000);
    // a later line edit keeps the removed shipping removed
    const l = (await linesOf(o.code))[0]!;
    const r4 = await commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 3 }], {}, { type: 'leave_due' });
    expect(r4.grandTotal).toBe(3000);
    await expectErr(previewOrderEdit(STORE, o.code, [{ op: 'set_shipping_method', code: 'ghost' }]), 'SHIPPING_METHOD_NOT_FOUND');
  });

  it('adds and removes a labelled +/- adjustment (untaxed), history stored', async () => {
    await withStore(STORE, (tx) => tx.update(s.store).set({ taxRate: 1000 }).where(eq(s.store.id, STORE)));
    const o = await makeOrder({ taxRate: 1000 }); // 2000 + 500 ship, 10% tax on items = 200 -> 2700
    expect(o.grandTotal).toBe(2700);
    const r1 = await commit(o.code, [{ op: 'add_adjustment', label: 'Goodwill', amount: -300 }, { op: 'add_adjustment', label: 'Rush fee', amount: 150 }], {}, { type: 'leave_credit' });
    expect(r1.grandTotal).toBe(2700 - 150);
    const adj = await withStore(STORE, (tx) => tx.select().from(s.orderAdjustment));
    expect(adj.map((a) => [a.label, a.amount, a.actor]).sort()).toEqual([['Goodwill', -300, 'owner@example.test'], ['Rush fee', 150, 'owner@example.test']]);
    const goodwill = adj.find((a) => a.label === 'Goodwill')!;
    const r2 = await commit(o.code, [{ op: 'remove_adjustment', adjustmentId: goodwill.id }], {}, { type: 'leave_due' });
    expect(r2.grandTotal).toBe(2700 + 150);
    expect(await withStore(STORE, (tx) => tx.select().from(s.orderAdjustment))).toHaveLength(1);
    expect((await orderRow(o.code)).taxTotal).toBe(200); // adjustments never taxed
  });
});

describe('settlement paths', () => {
  it('refund_now refunds exactly the difference via the refund engine; order stays Paid; no balance remains', async () => {
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }] });
    const l = (await linesOf(o.code)).find((x) => x.variantSku === 'B')!;
    const r = await commit(o.code, [{ op: 'remove_line', lineId: l.id }], {}, { type: 'refund_now' });
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0]!.amount).toBe(2000);
    expect(r.settlement).toMatchObject({ type: 'refund_now', status: 'settled', amount: 2000 });
    expect(r.state).toBe('Paid');
    expect(r.amountDue).toBe(0);
    const refunds = await withStore(STORE, (tx) => tx.select().from(s.refund));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.reason).toMatch(/^\[order-edit\]/);
    expect((await orderRow(o.code)).state).toBe('Paid');
    const [edit] = await withStore(STORE, (tx) => tx.select().from(s.orderEdit));
    expect((edit!.settlement as { refundId?: string }).refundId).toBe(refunds[0]!.id);
    // a second edit sees a zero starting balance (the edit refund is not "owed again")
    const next = await previewOrderEdit(STORE, o.code, [{ op: 'add_adjustment', label: 'x', amount: 100 }]);
    expect(next.balance).toMatchObject({ amountDue: 100, editRefunded: 2000 });
  });

  it('refund_now refuses a refund equal to the whole payment, and requires a payment when several exist', async () => {
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 1 }], shipping: 0 }); // single 1000 payment
    const l = (await linesOf(o.code))[0]!;
    // remove everything: refund == whole payment
    await expectErr(commit(o.code, [{ op: 'remove_line', lineId: l.id }], {}, { type: 'refund_now' }), 'REFUND_NOT_POSSIBLE');
    expect(refundCalls).toHaveLength(0);
    expect((await linesOf(o.code))[0]!.quantity).toBe(1); // nothing applied

    const m = await makeOrder({ lines: [{ sku: 'B', qty: 2 }], shipping: 0, payments: [{ amount: 3000, ref: 'pi_m1' }, { amount: 1000, ref: 'pi_m2' }] });
    const lm = (await linesOf(m.code))[0]!;
    await expectErr(commit(m.code, [{ op: 'set_quantity', lineId: lm.id, quantity: 1 }], {}, { type: 'refund_now' }), 'REFUND_NOT_POSSIBLE');
    const pays = await withStore(STORE, (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, m.id)));
    const big = pays.find((p) => p.amount === 3000)!;
    const r = await commit(m.code, [{ op: 'set_quantity', lineId: lm.id, quantity: 1 }], {}, { type: 'refund_now', paymentId: big.id });
    expect(r.settlement.status).toBe('settled');
    expect(refundCalls[0]).toMatchObject({ amount: 2000, providerRef: 'pi_m1' });
  });

  it('send_pay_link queues ONE email carrying the diff and a pay link scoped by the receipt token', async () => {
    const o = await makeOrder({});
    const r = await commit(o.code, [{ op: 'add_item', sku: 'A', quantity: 1 }], { reason: 'Customer asked for one more' }, { type: 'send_pay_link' });
    expect(r.settlement.status).toBe('sent');
    const mails = await outbox();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.kind).toBe('order_updated');
    const html = (mails[0]!.payload as { html: string }).html;
    expect(html).toContain(`https://shop.example.test/orders/${o.code}?rt=${RT}`);
    expect(html).toContain('Added 1 ×');
    expect(html).toContain('Customer asked for one more');
    // notify off: the pay link still goes out, as the stand-alone balance email
    const o2 = await makeOrder({});
    await commit(o2.code, [{ op: 'add_item', sku: 'A', quantity: 1 }], { notifyCustomer: false }, { type: 'send_pay_link' });
    expect((await outbox('order_balance_due'))).toHaveLength(1);
    // no pay link and notify off => no email at all
    const o3 = await makeOrder({});
    await commit(o3.code, [{ op: 'add_item', sku: 'A', quantity: 1 }], { notifyCustomer: false }, { type: 'leave_due' });
    expect(await outbox()).toHaveLength(2);
  });

  it('send_pay_link without a customer email is refused and applies nothing', async () => {
    const o = await makeOrder({ email: null });
    await expectErr(commit(o.code, [{ op: 'add_item', sku: 'A', quantity: 1 }], {}, { type: 'send_pay_link' }), 'NO_RECIPIENT');
    expect(await linesOf(o.code)).toHaveLength(1);
  });

  it('record_payment inserts a Settled manual payment with reference + audit and clears the balance', async () => {
    const o = await makeOrder({});
    const r = await commit(o.code, [{ op: 'add_item', sku: 'A', quantity: 1 }], {}, { type: 'record_payment', method: 'zelle', reference: 'ZEL-123' });
    expect(r.amountDue).toBe(0);
    expect(r.settlement).toMatchObject({ status: 'recorded', amount: 1000, paymentMethod: 'zelle', reference: 'ZEL-123' });
    const pays = await withStore(STORE, (tx) => tx.select().from(s.payment).where(and(eq(s.payment.orderId, o.id), eq(s.payment.method, 'manual'))));
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ state: 'Settled', amount: 1000 });
    expect((pays[0]!.metadata as { manual: { reference: string; method: string } }).manual).toMatchObject({ reference: 'ZEL-123', method: 'zelle' });
    expect((await audits('record_payment'))[0]!.actor).toBe('owner@example.test');
    expect((await orderRow(o.code)).state).toBe('Paid');
    expect(await audits('payment_after_cancel')).toHaveLength(0);
  });

  it('record_payment can be partial; the rest stays due', async () => {
    const o = await makeOrder({});
    const r = await commit(o.code, [{ op: 'add_item', sku: 'A', quantity: 2 }], {}, { type: 'record_payment', method: 'cash', amount: 500 });
    expect(r.amountDue).toBe(1500);
    await expectErr(commit(o.code, [{ op: 'add_item', sku: 'A', quantity: 1 }], {}, { type: 'record_payment', method: 'cash', amount: 5000 }), 'SETTLEMENT_INVALID');
    expect((await orderRow(o.code)).grandTotal).toBe(4500);
    expect(await linesOf(o.code)).toHaveLength(2);
  });

  it('record_payment fully covering an unpaid (PendingPayment) order takes it to Paid', async () => {
    const o = await makeOrder({ state: 'PendingPayment', lines: [{ sku: 'A', qty: 1 }] }); // 1000 + 500
    const l = (await linesOf(o.code))[0]!;
    const r = await commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 2 }], {}, { type: 'record_payment', method: 'check', reference: '#4411' });
    expect(r.grandTotal).toBe(2500);
    expect(r.state).toBe('Paid');
    expect(r.amountDue).toBe(0);
  });

  it('settlement must match the balance sign; balance 0 needs none', async () => {
    const o = await makeOrder({});
    await expectErr(commit(o.code, [{ op: 'add_item', sku: 'A', quantity: 1 }]), 'SETTLEMENT_REQUIRED');
    await expectErr(commit(o.code, [{ op: 'add_item', sku: 'A', quantity: 1 }], {}, { type: 'refund_now' }), 'SETTLEMENT_INVALID');
    const r = await commit(o.code, [{ op: 'add_adjustment', label: 'a', amount: 1 }, { op: 'add_adjustment', label: 'b', amount: -1 }]);
    expect(r.balance).toBe(0);
    expect(r.settlement.type).toBe('none');
  });

  it('leave_credit leaves the overpayment on the order (no refund)', async () => {
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 2 }] });
    const l = (await linesOf(o.code))[0]!;
    const r = await commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 1 }], {}, { type: 'leave_credit' });
    expect(r.amountDue).toBe(-1000);
    expect(refundCalls).toHaveLength(0);
  });
});

describe('guards: stale preview, idempotency, state', () => {
  it('rejects a stale preview and applies nothing', async () => {
    const o = await makeOrder({});
    const ops: EditOpT[] = [{ op: 'add_item', sku: 'A', quantity: 1 }];
    const input = await acceptedCommit(o.code, ops, { expectedGrandTotal: 12345 }, { type: 'leave_due' });
    await expectErr(commitOrderEdit(input), 'PREVIEW_STALE');
    expect(await linesOf(o.code)).toHaveLength(1);
    expect((await orderRow(o.code)).grandTotal).toBe(o.grandTotal);
  });

  it('requires the accepted preview hash even when the total matches', async () => {
    const o = await makeOrder({});
    const ops: EditOpT[] = [{ op: 'add_item', sku: 'A', quantity: 1 }];
    const input = await acceptedCommit(o.code, ops, {}, { type: 'leave_due' });
    await expectErr(commitOrderEdit({ ...input, previewAcceptanceHash: undefined }), 'PREVIEW_STALE');
    expect(await linesOf(o.code)).toHaveLength(1);
    expect((await orderRow(o.code)).grandTotal).toBe(o.grandTotal);
    expect(await withStore(STORE, (tx) => tx.select().from(s.orderEdit))).toHaveLength(0);
  });

  it('commit is idempotent per key: a replay returns the stored result and does not double-apply', async () => {
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }] });
    const l = (await linesOf(o.code)).find((x) => x.variantSku === 'B')!;
    const ops: EditOpT[] = [{ op: 'remove_line', lineId: l.id }];
    const input = await acceptedCommit(o.code, ops, { actor: 'a', idempotencyKey: 'same-key' }, { type: 'refund_now' });
    const r1 = await commitOrderEdit(input);
    const r2 = await commitOrderEdit(input);
    expect(r1.replay).toBe(false);
    expect(r2).toMatchObject({ replay: true, editId: r1.editId, grandTotal: 2500 });
    expect(await withStore(STORE, (tx) => tx.select().from(s.orderEdit))).toHaveLength(1);
    expect(refundCalls).toHaveLength(1);
    expect(await outbox('order_updated')).toHaveLength(1);
    await expectErr(commitOrderEdit({ ...input, ops: [{ op: 'add_adjustment', label: 'x', amount: 5 }], expectedGrandTotal: 2505 }), 'IDEMPOTENCY_KEY_REUSED');
  });

  it('Refunded and Cancelled orders cannot be edited (address only on Refunded)', async () => {
    const r = await makeOrder({ state: 'Refunded' });
    const c = await makeOrder({ state: 'Cancelled', payments: [] });
    await expectErr(previewOrderEdit(STORE, r.code, [{ op: 'add_item', sku: 'A', quantity: 1 }]), 'ORDER_NOT_EDITABLE');
    await expectErr(previewOrderEdit(STORE, c.code, [{ op: 'add_item', sku: 'A', quantity: 1 }]), 'ORDER_NOT_EDITABLE');
    const addr = { fullName: 'N', line1: '9 New St', city: 'Dallas', province: 'TX', postalCode: '75001', country: 'US', phone: null, line2: null };
    expect((await saveOrderAddress({ storeId: STORE, code: r.code, actor: 'a', kind: 'shipping', address: addr })).changed).toBe(true);
    await expectErr(saveOrderAddress({ storeId: STORE, code: c.code, actor: 'a', kind: 'shipping', address: addr }), 'ORDER_NOT_EDITABLE');
    const ctx = await loadEditContext(STORE, r.code);
    expect(ctx.editable).toMatchObject({ items: false, addressOnly: true });
  });

  it('an unresolved payment blocks item edits', async () => {
    const o = await makeOrder({});
    await withStore(STORE, (tx) => tx.insert(s.payment).values({ storeId: STORE, orderId: o.id, amount: 100, method: 'stripe', state: 'Pending' }));
    await expectErr(previewOrderEdit(STORE, o.code, [{ op: 'add_item', sku: 'A', quantity: 1 }]), 'PAYMENT_UNRESOLVED');
  });

  it('a regular item refund is not mistaken for money owed (balance = new total - settled)', async () => {
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 2 }], state: 'PartiallyRefunded' }); // paid 2500
    const pay0 = await withStore(STORE, async (tx) => (await tx.select().from(s.payment).where(eq(s.payment.orderId, o.id)))[0]!);
    await withStore(STORE, (tx) => tx.insert(s.refund).values({ storeId: STORE, paymentId: pay0.id, orderId: o.id, amount: 1000, state: 'Settled', reason: 'damaged', itemsAmount: 1000 }));
    const p = await previewOrderEdit(STORE, o.code, [{ op: 'add_adjustment', label: 'fee', amount: 200 }]);
    expect(p.balance).toMatchObject({ settled: 2500, refunded: 1000, amountDue: 200 });
  });
});

describe('address editing (G5)', () => {
  const addr = { fullName: 'New Name', line1: '99 Elm St', line2: null, city: 'Dallas', province: 'TX', postalCode: '75001', country: 'US', phone: '555-0100' };

  it('guest order, same country: simple save + audit + timeline; no address-book requirement', async () => {
    const o = await makeOrder({ email: 'guest@example.test' });
    const r = await saveOrderAddress({ storeId: STORE, code: o.code, actor: 'owner@example.test', kind: 'shipping', address: addr, reason: 'customer moved' });
    expect(r).toMatchObject({ changed: true, savedToAddressBook: false });
    expect((await orderRow(o.code)).shippingAddress).toMatchObject({ line1: '99 Elm St', city: 'Dallas' });
    const a = await audits('edit_address');
    expect(a).toHaveLength(1);
    expect(a[0]!.data).toMatchObject({ kind: 'shipping', reason: 'customer moved' });
    expect(await withStore(STORE, (tx) => tx.select().from(s.address))).toHaveLength(0);
    expect(await withStore(STORE, (tx) => tx.select().from(s.orderEdit))).toHaveLength(1);
    // totals untouched
    expect((await orderRow(o.code)).grandTotal).toBe(o.grandTotal);
  });

  it('works on a fulfilled order; billing address too', async () => {
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 2, fulfilled: 2 }] });
    await saveOrderAddress({ storeId: STORE, code: o.code, actor: 'a', kind: 'billing', address: { ...addr, country: 'CA' } });
    expect((await orderRow(o.code)).billingAddress).toMatchObject({ country: 'CA' });
    await saveOrderAddress({ storeId: STORE, code: o.code, actor: 'a', kind: 'shipping', address: addr });
    expect((await orderRow(o.code)).shippingAddress).toMatchObject({ line1: '99 Elm St' });
  });

  it('customer order: also-save-to-address-book is opt-in (default off) and de-duplicated', async () => {
    const o = await makeOrder({ customer: true });
    await saveOrderAddress({ storeId: STORE, code: o.code, actor: 'a', kind: 'shipping', address: addr });
    expect(await withStore(STORE, (tx) => tx.select().from(s.address))).toHaveLength(0);
    const r = await saveOrderAddress({ storeId: STORE, code: o.code, actor: 'a', kind: 'shipping', address: { ...addr, line1: '100 Oak' }, saveToAddressBook: true });
    expect(r.savedToAddressBook).toBe(true);
    await saveOrderAddress({ storeId: STORE, code: o.code, actor: 'a', kind: 'shipping', address: { ...addr, line1: '100 Oak' }, saveToAddressBook: true });
    const book = await withStore(STORE, (tx) => tx.select().from(s.address));
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ customerId: o.customerId, line1: '100 Oak', country: 'US' });
  });

  it('a shipping COUNTRY change is refused by the direct save and routed through preview/commit with the resulting balance', async () => {
    const o = await makeOrder({});
    await withStore(STORE, (tx) => tx.insert(s.taxZone).values({ storeId: STORE, name: 'CA', countries: ['CA'], rate: 500 }));
    const toCanada = { ...addr, city: 'Toronto', province: 'ON', postalCode: 'M5V', country: 'CA' };
    await expectErr(saveOrderAddress({ storeId: STORE, code: o.code, actor: 'a', kind: 'shipping', address: toCanada }), 'COUNTRY_CHANGE_REQUIRES_EDIT');
    expect((await orderRow(o.code)).shippingAddress).toMatchObject({ country: 'US' });
    await withStore(STORE, (tx) => tx.update(s.productVariant).set({ price: 1500 }).where(eq(s.productVariant.id, V['A']!.id)));
    const facts = () => withStore(STORE, async tx => ({
      orders: await tx.select().from(s.order), lines: await tx.select().from(s.orderLine), stock: await tx.select().from(s.stock),
      payments: await tx.select().from(s.payment), edits: await tx.select().from(s.orderEdit), audits: await tx.select().from(s.auditLog),
    }));
    const beforePreview = await facts();
    const op: EditOpT = { op: 'set_address', kind: 'shipping', address: toCanada };
    const p = await previewOrderEdit(STORE, o.code, [op]);
    expect(p.address.shipping).toEqual({ changed: true, countryChanged: true });
    expect(p.before).toMatchObject({ subtotal: 2000, taxTotal: 0, grandTotal: 2500 });
    expect(p.after.subtotal).toBe(2000); // address repricing preserves the proven merchandise list price
    expect(p.after.taxTotal).toBe(100); // 5% of 2000 items
    expect(p.balance.amountDue).toBe(100);
    expect(await facts()).toEqual(beforePreview);
    const r = await commit(o.code, [op], {}, { type: 'record_payment', method: 'cash', reference: 'tax diff' });
    expect(r.amountDue).toBe(0);
    expect((await orderRow(o.code)).shippingAddress).toMatchObject({ country: 'CA' });
    expect((await orderRow(o.code)).taxTotal).toBe(100);
    expect((await linesOf(o.code))[0]).toMatchObject({ unitPrice: 1000, quantity: 2, lineTax: 100 });
    const back: EditOpT = { op: 'set_address', kind: 'shipping', address: addr };
    const returning = await previewOrderEdit(STORE, o.code, [back]);
    expect(returning.before).toMatchObject({ subtotal: 2000, taxTotal: 100, grandTotal: 2600 });
    expect(returning.after).toMatchObject({ subtotal: 2000, taxTotal: 0, grandTotal: 2500 });
    expect(returning.balance.amountDue).toBe(-100);
    await commit(o.code, [back], {}, { type: 'leave_credit' });
    expect((await linesOf(o.code))[0]).toMatchObject({ unitPrice: 1000, quantity: 2, lineTax: 0 });
    const manualPayments = await withStore(STORE, tx => tx.select().from(s.payment).where(and(eq(s.payment.orderId, o.id), eq(s.payment.method, 'manual'))));
    expect(manualPayments).toHaveLength(1);
    expect(manualPayments[0]!.amount).toBe(100);
    expect(await audits('record_payment')).toHaveLength(1);
  });

  it('country repricing preserves an admitted inclusive list price after the live price changes', async () => {
    await withStore(STORE, tx => tx.update(s.store).set({ taxInclusive: true }).where(eq(s.store.id, STORE)));
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 1 }], shipping: 0 });
    await withStore(STORE, async tx => {
      await tx.update(s.order).set({ subtotal: 1050, grandTotal: 1050 }).where(eq(s.order.id, o.id));
      await tx.update(s.orderLine).set({ unitPrice: 1050, lineSubtotal: 1050, lineTotal: 1050 }).where(eq(s.orderLine.orderId, o.id));
      await tx.update(s.payment).set({ amount: 1050 }).where(eq(s.payment.orderId, o.id));
      await tx.insert(s.taxZone).values({ storeId: STORE, name: 'CA', countries: ['CA'], rate: 500 });
    });
    // Admit the original zero-tax basis before changing destination or the live variant price.
    await commit(o.code, [{ op: 'set_address', kind: 'billing', address: addr }], { notifyCustomer: false });
    await withStore(STORE, tx => tx.update(s.productVariant).set({ price: 1500 }).where(eq(s.productVariant.id, V['A']!.id)));
    const op: EditOpT = { op: 'set_address', kind: 'shipping', address: { ...addr, country: 'CA' } };
    const preview = await previewOrderEdit(STORE, o.code, [op]);
    expect(preview.before).toMatchObject({ subtotal: 1050, taxTotal: 0, grandTotal: 1050 });
    expect(preview.after).toMatchObject({ subtotal: 1050, taxTotal: 50, grandTotal: 1050 });
    expect(preview.balance.amountDue).toBe(0);
    await commit(o.code, [op], { notifyCustomer: false });
    expect((await linesOf(o.code))[0]).toMatchObject({ unitPrice: 1000, quantity: 1, lineSubtotal: 1000, lineTax: 50, lineTotal: 1050 });
  });
});

describe('pay link: /pay charges ONLY the balance on a Paid order', () => {
  const hdr = { 'content-type': 'application/json', 'x-store-slug': SLUG, 'x-receipt-token': RT };

  it('charges the balance, records a second payment, no duplicate/after-cancel alert, order stays Paid', async () => {
    const o = await makeOrder({});
    await commit(o.code, [{ op: 'add_item', sku: 'B', quantity: 1 }], {}, { type: 'send_pay_link' }); // +2000
    const res = await app.request(`/v1/shop/orders/${o.code}/pay`, { method: 'POST', headers: hdr, body: JSON.stringify({ method: 'stripe' }) });
    expect(res.status).toBe(200);
    expect(chargeCalls).toEqual([{ orderCode: o.code, amount: 2000 }]);
    expect(await res.json()).toMatchObject({ state: 'Paid', payment: 'Settled' });
    const pays = await withStore(STORE, (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, o.id)));
    expect(pays).toHaveLength(2);
    expect(pays.reduce((n, p) => n + p.amount, 0)).toBe(2500 + 2000);
    expect(await audits('payment_after_cancel')).toHaveLength(0);
    expect((await audits('balance_payment'))).toHaveLength(1);
    // nothing left to pay now
    const again = await app.request(`/v1/shop/orders/${o.code}/pay`, { method: 'POST', headers: hdr, body: JSON.stringify({ method: 'stripe' }) });
    expect(again.status).toBe(409);
    expect(chargeCalls).toHaveLength(1);
  });

  it('a Paid order with nothing due is still not payable', async () => {
    const o = await makeOrder({});
    const res = await app.request(`/v1/shop/orders/${o.code}/pay`, { method: 'POST', headers: hdr, body: JSON.stringify({ method: 'stripe' }) });
    expect(res.status).toBe(409);
    expect(chargeCalls).toHaveLength(0);
  });

  it('two successive edits each get their own balance payment (claim keyed per payment count)', async () => {
    const o = await makeOrder({});
    const ops: EditOpT[] = [{ op: 'add_item', sku: 'A', quantity: 1 }];
    await commit(o.code, ops, {}, { type: 'send_pay_link' });
    expect((await app.request(`/v1/shop/orders/${o.code}/pay`, { method: 'POST', headers: hdr, body: JSON.stringify({ method: 'stripe' }) })).status).toBe(200);
    const accepted = await acceptedCommit(o.code, ops, {}, { type: 'send_pay_link' });
    expect((await previewOrderEdit(STORE, o.code, ops)).previewAcceptanceHash).toBe(accepted.previewAcceptanceHash);
    await commitOrderEdit(accepted);
    const r2 = await app.request(`/v1/shop/orders/${o.code}/pay`, { method: 'POST', headers: hdr, body: JSON.stringify({ method: 'stripe' }) });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ payment: 'Settled' });
    expect((await commitOrderEdit(accepted)).replay).toBe(true);
    expect(chargeCalls.map((c) => c.amount)).toEqual([1000, 1000]);
    const lines = await linesOf(o.code);
    const snapshot = (await orderRow(o.code)).pricingSnapshot as { lines: Array<{ key: string; orderLineId: string }> };
    expect(lines).toHaveLength(3);
    expect(new Set(snapshot.lines.map(line => line.key)).size).toBe(3);
    expect(new Set(snapshot.lines.map(line => line.orderLineId))).toEqual(new Set(lines.map(line => line.id)));
  });
});

describe('webhooks and timeline', () => {
  it('emits order.updated to subscribed endpoints and writes the edit timeline entry', async () => {
    await withStore(STORE, (tx) => tx.insert(s.webhookEndpoint).values({ storeId: STORE, url: 'https://hooks.example.test/x', topics: ['order.updated'], secret: 'sec' }));
    const o = await makeOrder({});
    await commit(o.code, [{ op: 'add_item', sku: 'A', quantity: 1 }], { reason: 'upsell' }, { type: 'leave_due' });
    const deliveries = await withStore(STORE, (tx) => tx.select().from(s.webhookDelivery));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ topic: 'order.updated' });
    expect(deliveries[0]!.payload).toMatchObject({ code: o.code, previousGrandTotal: 2500, grandTotal: 3500, balance: 1000, reason: 'upsell' });
    expect((await audits('edit'))[0]!.data).toMatchObject({ reason: 'upsell', settlement: 'leave_due' });
  });
});

describe('persisted shipping method (migration 0086)', () => {
  const setMethod = (id: string, code: string | null, name: string | null) =>
    withStore(STORE, (tx) => tx.update(s.order).set({ shippingMethodCode: code, shippingMethodName: name }).where(eq(s.order.id, id)));

  it('uses the stored code instead of inferring from the total (and does not warn)', async () => {
    // Express is stored but the total (500) equals Standard's flat rate: inference would pick Standard.
    const o = await makeOrder({});
    await setMethod(o.id, 'exp', 'Express');
    const p = await previewOrderEdit(STORE, o.code, []);
    expect(p.shipping).toMatchObject({ methodCode: 'exp', methodName: 'Express' });
    expect(p.warnings).not.toContain('SHIPPING_METHOD_INFERRED');
  });

  it('legacy NULL code requires a mapped calculator or explicit amount before economic edits', async () => {
    const o = await makeOrder({});
    await setMethod(o.id, null, null);
    await expectErr(previewOrderEdit(STORE, o.code, []), 'ORDER_PRICING_EDIT_UNSUPPORTED');
    const p = await previewOrderEdit(STORE, o.code, [{ op: 'set_shipping_amount', amount: 500 }]);
    expect(p.shipping).toMatchObject({ amount: 500, override: true, methodCode: null });
    expect((await orderRow(o.code)).grandTotal).toBe(o.grandTotal);
  });

  it('an edit that sets the method persists code + name; a custom amount clears them; a plain edit leaves them', async () => {
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 2 }] });
    await commit(o.code, [{ op: 'set_shipping_method', code: 'exp' }], {}, { type: 'send_pay_link' });
    expect(await orderRow(o.code)).toMatchObject({ shippingMethodCode: 'exp', shippingMethodName: 'Express' });
    const l = (await linesOf(o.code))[0]!;
    await commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 3 }], {}, { type: 'leave_due' });
    expect(await orderRow(o.code)).toMatchObject({ shippingMethodCode: 'exp', shippingMethodName: 'Express' });
    await commit(o.code, [{ op: 'set_shipping_amount', amount: 123 }], {}, { type: 'leave_due' });
    expect(await orderRow(o.code)).toMatchObject({ shippingMethodCode: null, shippingMethodName: null });
  });
});

describe('loyalty earn follows an edit of a Paid order', () => {
  const SNAP = { redeemPoints: 0, pointsDiscount: 0, earnPoints: 20, expiryDays: null, earnRatePerDollar: 1 };
  async function earnedOrder(snap: Record<string, unknown> = SNAP, earn = 20) {
    const o = await makeOrder({ customer: true, lines: [{ sku: 'A', qty: 2 }] }); // 2000 merchandise
    await withStore(STORE, async (tx) => {
      await tx.update(s.order).set({ metadata: { contact: { email: 'cust@example.test' }, loyalty: snap } }).where(eq(s.order.id, o.id));
      if (earn) await tx.insert(s.loyaltyLedger).values({ storeId: STORE, customerId: o.customerId!, orderId: o.id, kind: 'earn', points: earn, sourceRef: `earn:${o.id}`, actor: 'system:order-paid', reason: 'order_paid' });
    });
    return o;
  }
  const ledger = (customerId: string) => withStore(STORE, (tx) => tx.select().from(s.loyaltyLedger).where(eq(s.loyaltyLedger.customerId, customerId)));
  const balance = async (customerId: string) => (await ledger(customerId)).reduce((n, r) => n + r.points, 0);

  it('posts the delta on the order\'s own rate, once per edit id (replay is a no-op)', async () => {
    const o = await earnedOrder();
    const l = (await linesOf(o.code))[0]!;
    const pay = { type: 'record_payment', method: 'cash' } as const;
    const input = await acceptedCommit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 4 }], { idempotencyKey: 'loy-up' }, pay);
    const r = await commitOrderEdit(input); // 4000 -> 40 pts, paid in full
    expect(r.replay).toBe(false);
    const adj = (await ledger(o.customerId!)).filter((x) => x.kind === 'adjust');
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ points: 20, reason: 'order_edit_earn', orderId: o.id });
    expect(adj[0]!.sourceRef).toBe(`order_edit:${r.editId}:earn`);
    const again = await commitOrderEdit(input);
    expect(again.replay).toBe(true);
    expect((await ledger(o.customerId!)).filter((x) => x.kind === 'adjust')).toHaveLength(1);
    expect(await balance(o.customerId!)).toBe(40);
  });

  it('reduces the earn when merchandise drops, never below what was earned', async () => {
    const o = await earnedOrder();
    const l = (await linesOf(o.code))[0]!;
    await commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 1 }], {}, { type: 'leave_credit' }); // 1000 -> 10 pts: -10
    expect(await balance(o.customerId!)).toBe(10);
    await commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 4 }], {}, { type: 'record_payment', method: 'cash' }); // back up: +30
    expect(await balance(o.customerId!)).toBe(40);
  });

  it('points already spent: posts only what is available and records the shortfall', async () => {
    const o = await earnedOrder();
    await withStore(STORE, (tx) => tx.insert(s.loyaltyLedger).values({ storeId: STORE, customerId: o.customerId!, kind: 'redeem', points: -15, sourceRef: 'redeem:other', actor: 'x', reason: 'spent' }));
    const l = (await linesOf(o.code))[0]!;
    await commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 1 }], {}, { type: 'leave_credit' }); // want -10, only 5 available
    const adj = (await ledger(o.customerId!)).filter((x) => x.kind === 'adjust');
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ points: -5, shortfall: 5 });
    expect(await balance(o.customerId!)).toBe(0);
  });

  it('does nothing for an order that never earned or whose snapshot has no rate', async () => {
    const never = await earnedOrder(SNAP, 0);
    const l1 = (await linesOf(never.code))[0]!;
    await commit(never.code, [{ op: 'set_quantity', lineId: l1.id, quantity: 4 }], {}, { type: 'leave_due' });
    expect(await ledger(never.customerId!)).toHaveLength(0);
  });

  it('edit difference refund does not claw points twice; a later full refund reverses what the EDITED order earned', async () => {
    const o = await earnedOrder(); // 2x A = 2000 merch + 500 ship, paid 2500, earned 20
    const l = (await linesOf(o.code))[0]!;
    const r = await commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 1 }], {}, { type: 'refund_now' }); // -1000 refunded
    expect(r.settlement).toMatchObject({ type: 'refund_now', status: 'settled', amount: 1000 });
    const afterEdit = await ledger(o.customerId!);
    expect(afterEdit.filter((x) => x.kind === 'reverse')).toHaveLength(0); // the edit refund itself reverses nothing
    expect(afterEdit.filter((x) => x.kind === 'adjust')).toMatchObject([{ points: -10, reason: 'order_edit_earn' }]);
    expect(await balance(o.customerId!)).toBe(10);
    const [edit] = await withStore(STORE, (tx) => tx.select().from(s.refund));
    expect((edit!.metadata as { source?: string }).source).toBe('order_edit');
    expect((await orderRow(o.code)).state).toBe('Paid');
    // full refund of what the edited order cost (1500): reverses the remaining 10, order -> Refunded
    const { requestRefund } = await import('../payments/refunds.js');
    await requestRefund({ storeId: STORE, orderId: o.id, actor: 'owner@example.test', idempotencyKey: 'full-after-edit', amount: 1500 });
    expect(await balance(o.customerId!)).toBe(0);
    expect((await ledger(o.customerId!)).filter((x) => x.kind === 'reverse')).toMatchObject([{ points: -10, reason: 'earn_reversal' }]);
    expect((await orderRow(o.code)).state).toBe('Refunded');
  });

  it('a typed refund reason starting with [order-edit] is an ordinary refund (tag is server-set metadata only)', async () => {
    const o = await earnedOrder();
    const { requestRefund } = await import('../payments/refunds.js');
    await requestRefund({ storeId: STORE, orderId: o.id, actor: 'owner@example.test', idempotencyKey: 'spoof', amount: 1000, reason: '[order-edit] spoof' });
    expect((await orderRow(o.code)).state).toBe('PartiallyRefunded');
    expect(await balance(o.customerId!)).toBe(12); // 20 earned, 1000/2500 reversed = 8
    const p = await previewOrderEdit(STORE, o.code, [{ op: 'add_adjustment', label: 'x', amount: 100 }]);
    expect(p.balance).toMatchObject({ editRefunded: 0 });
  });

  it('no rate in the snapshot (older order): skipped, not guessed', async () => {
    const o = await earnedOrder({ redeemPoints: 0, pointsDiscount: 0, earnPoints: 20, expiryDays: null });
    const l = (await linesOf(o.code))[0]!;
    await commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 4 }], {}, { type: 'leave_due' });
    expect((await ledger(o.customerId!)).filter((x) => x.kind === 'adjust')).toHaveLength(0);
  });
});

describe('review fixes: refunded/fulfilled overlap, loyalty deferral, failed edit refund', () => {
  const SNAP = { redeemPoints: 0, pointsDiscount: 0, earnPoints: 20, expiryDays: null, earnRatePerDollar: 1 };
  const ledger = (customerId: string) => withStore(STORE, (tx) => tx.select().from(s.loyaltyLedger).where(eq(s.loyaltyLedger.customerId, customerId)));
  const balance = async (customerId: string) => (await ledger(customerId)).reduce((n, r) => n + r.points, 0);
  const setLoyalty = (id: string, snap: Record<string, unknown>) => withStore(STORE, (tx) => tx.update(s.order).set({ metadata: { contact: { email: 'cust@example.test' }, loyalty: snap } }).where(eq(s.order.id, id)));

  it('fulfil -> return-refund -> edit: removing the refunded line never increases quantity or reserves stock', async () => {
    const { requestRefund } = await import('../payments/refunds.js');
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 1 }] });
    const la = (await linesOf(o.code)).find((x) => x.variantSku === 'A')!;
    await withStore(STORE, async (tx) => {
      await tx.update(s.orderLine).set({ fulfilledQty: 1 }).where(eq(s.orderLine.id, la.id));
      await tx.update(s.stock).set({ allocated: sql`${s.stock.allocated} - 1` }).where(eq(s.stock.variantId, V.A!.id));
    });
    await requestRefund({ storeId: STORE, orderId: o.id, actor: 'owner@example.test', idempotencyKey: 'ret-A', amount: 1000, lines: [{ orderLineId: la.id, quantity: 1, restock: false }] });
    const refunded = (await linesOf(o.code)).find((x) => x.id === la.id)!;
    expect(refunded).toMatchObject({ quantity: 1, fulfilledQty: 1, refundedQty: 1, cancelledQty: 0 });
    const allocBefore = (await stock('A')).allocated;
    const prev = await previewOrderEdit(STORE, o.code, [{ op: 'remove_line', lineId: la.id }]);
    expect(prev.lines.find((l) => l.lineId === la.id)).toMatchObject({ beforeQty: 1, afterQty: 1 });
    await commit(o.code, [{ op: 'remove_line', lineId: la.id }], {}, undefined);
    const after = (await linesOf(o.code)).find((x) => x.id === la.id)!;
    expect(after.quantity).toBe(1);
    expect((await stock('A')).allocated).toBe(allocBefore);
  });

  it('unpaid edit -> later payment earns on the edited merchandise', async () => {
    const o = await makeOrder({ state: 'PendingPayment', customer: true, lines: [{ sku: 'A', qty: 2 }] });
    await setLoyalty(o.id, SNAP);
    const l = (await linesOf(o.code))[0]!;
    await commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 4 }], {}, { type: 'leave_due' }); // 4000 -> 40
    expect((await orderRow(o.code)).metadata).toMatchObject({ loyalty: { earnPoints: 40 } });
    expect(await ledger(o.customerId!)).toHaveLength(0);
    const { postEarnForPaidOrder } = await import('../loyalty/ledger.js');
    expect(await withStore(STORE, (tx) => postEarnForPaidOrder(tx, STORE, o.id))).toBe(40);
  });

  it('leave_due addition: points not spendable until settled, then available', async () => {
    const o = await makeOrder({ customer: true, lines: [{ sku: 'A', qty: 2 }] });
    await setLoyalty(o.id, SNAP);
    await withStore(STORE, (tx) => tx.insert(s.loyaltyLedger).values({ storeId: STORE, customerId: o.customerId!, orderId: o.id, kind: 'earn', points: 20, sourceRef: `earn:${o.id}`, actor: 'system:order-paid', reason: 'order_paid' }));
    const l = (await linesOf(o.code))[0]!;
    await commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 4 }], {}, { type: 'leave_due' });
    expect(await balance(o.customerId!)).toBe(20); // +20 held back
    const { lockedAvailable } = await import('../loyalty/ledger.js');
    expect(await withStore(STORE, (tx) => lockedAvailable(tx, STORE, o.customerId!))).toBe(20);
    // balance payment lands (what settle.ts records for a paid-order balance)
    await withStore(STORE, (tx) => tx.insert(s.payment).values({ storeId: STORE, orderId: o.id, amount: 2000, method: 'stripe', state: 'Settled', providerRef: 'pi_bal_x', gatewayMode: 'test', currency: 'USD' }));
    expect(await withStore(STORE, (tx) => lockedAvailable(tx, STORE, o.customerId!))).toBe(40);
    expect(await withStore(STORE, (tx) => lockedAvailable(tx, STORE, o.customerId!))).toBe(40); // idempotent
    expect((await ledger(o.customerId!)).filter((x) => x.kind === 'adjust')).toHaveLength(1);
  });

  it('failed edit refund -> retry succeeds with order_edit provenance; amountDue and loyalty right', async () => {
    const { retryOrderEditRefund } = await import('./order-edit-service.js');
    const o = await makeOrder({ customer: true, lines: [{ sku: 'A', qty: 2 }] });
    await setLoyalty(o.id, SNAP);
    await withStore(STORE, (tx) => tx.insert(s.loyaltyLedger).values({ storeId: STORE, customerId: o.customerId!, orderId: o.id, kind: 'earn', points: 20, sourceRef: `earn:${o.id}`, actor: 'system:order-paid', reason: 'order_paid' }));
    const l = (await linesOf(o.code))[0]!;
    failNextRefund = true;
    const r = await commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 1 }], {}, { type: 'refund_now' });
    expect(r.settlement).toMatchObject({ status: 'failed', refundState: 'Failed' });
    expect(r.amountDue).toBe(-1000);
    const out = await retryOrderEditRefund({ storeId: STORE, code: o.code, editId: r.editId, actor: 'owner@example.test', action: 'retry' });
    expect(out.settlement).toMatchObject({ type: 'refund_now', status: 'settled', amount: 1000 });
    expect(out.amountDue).toBe(0);
    expect(out.state).toBe('Paid');
    const refunds = await withStore(STORE, (tx) => tx.select().from(s.refund));
    expect(refunds.filter((x) => x.state === 'Settled')).toHaveLength(1);
    expect((refunds.find((x) => x.state === 'Settled')!.metadata as { source?: string }).source).toBe('order_edit');
    expect(await balance(o.customerId!)).toBe(10); // edit earn reduction only, no extra clawback
    await expectErr(retryOrderEditRefund({ storeId: STORE, code: o.code, editId: r.editId, actor: 'x', action: 'retry' }), 'REFUND_NOT_RETRYABLE');
  });

  it('failed edit refund can be turned into credit', async () => {
    const { retryOrderEditRefund } = await import('./order-edit-service.js');
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 2 }] });
    const l = (await linesOf(o.code))[0]!;
    failNextRefund = true;
    const r = await commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 1 }], {}, { type: 'refund_now' });
    const out = await retryOrderEditRefund({ storeId: STORE, code: o.code, editId: r.editId, actor: 'x', action: 'credit' });
    expect(out.settlement).toMatchObject({ type: 'leave_credit', status: 'credit' });
    expect(out.amountDue).toBe(-1000);
  });
});

describe('round-2 review fixes: intents, license issuance, async refunds', () => {
  const addIntent = (orderId: string, status: string, n = 1) => withStore(STORE, (tx) => tx.insert(s.paymentAttempt).values({
    storeId: STORE, orderId, operation: 'intent', method: 'stripe', accountId: 'acct', mode: 'test', amount: 2500, currency: 'USD',
    idempotencyKey: `intent-${orderId}-${status}-${n}`, fingerprint: 'fp', status, providerRef: `pi_${n}_${status}`,
  }));
  const intentStatuses = (orderId: string) => withStore(STORE, async (tx) => (await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.orderId, orderId))).map((a) => a.status));
  const toCanada = { fullName: 'N', line1: '9 New St', city: 'Toronto', province: 'ON', postalCode: 'M5V', country: 'CA', phone: null, line2: null };
  const sameCountry = { fullName: 'N', line1: '9 New St', city: 'Dallas', province: 'TX', postalCode: '75001', country: 'US', phone: null, line2: null };
  const taxCA = () => withStore(STORE, (tx) => tx.insert(s.taxZone).values({ storeId: STORE, name: 'CA', countries: ['CA'], rate: 500 }));

  it('country-change (tax repricing) retires an open intent before committing', async () => {
    const o = await makeOrder({}); await taxCA(); await addIntent(o.id, 'open');
    const r = await commit(o.code, [{ op: 'set_address', kind: 'shipping', address: toCanada }], {}, { type: 'leave_due' });
    expect(r.replay).toBe(false);
    expect(intentSpy.calls).toEqual([o.id]);
    expect(await intentStatuses(o.id)).toEqual(['cancelled']);
  });

  it('country-change is held by a processing payment and by an intent that survives retirement', async () => {
    const o = await makeOrder({}); await taxCA(); await addIntent(o.id, 'processing');
    const op: EditOpT = { op: 'set_address', kind: 'shipping', address: toCanada };
    await expectErr(previewOrderEdit(STORE, o.code, [op]), 'PAYMENT_UNRESOLVED');
    const o2 = await makeOrder({}); await addIntent(o2.id, 'open', 2);
    intentSpy.cancel = false; // gateway could not cancel it
    const prev = await previewOrderEdit(STORE, o2.code, [op]);
    await expectErr(commitOrderEdit({ storeId: STORE, storeSlug: SLUG, code: o2.code, actor: 'a', principalKind: 'human', ops: [op], expectedGrandTotal: prev.after.grandTotal, previewAcceptanceHash: prev.previewAcceptanceHash, idempotencyKey: 'surv', notifyCustomer: false, settlement: { type: 'leave_due' } }), 'PAYMENT_UNRESOLVED');
    expect((await orderRow(o2.code)).shippingAddress).toMatchObject({ country: 'US' });
  });

  it('a monetarily inert address edit neither retires nor is blocked by an open intent', async () => {
    const o = await makeOrder({}); await addIntent(o.id, 'open');
    const r = await commit(o.code, [{ op: 'set_address', kind: 'shipping', address: sameCountry }]);
    expect(r.replay).toBe(false);
    expect(intentSpy.calls).toEqual([]);
    expect(await intentStatuses(o.id)).toEqual(['open']);
  });

  it('an idempotent replay or stale preview never cancels a newer intent', async () => {
    const o = await makeOrder({}); const l = (await linesOf(o.code))[0]!;
    const ops: EditOpT[] = [{ op: 'set_quantity', lineId: l.id, quantity: 3 }];
    const input = await acceptedCommit(o.code, ops, { idempotencyKey: 'same-key' }, { type: 'leave_due' });
    const r1 = await commitOrderEdit(input);
    expect(r1.replay).toBe(false);
    await addIntent(o.id, 'open'); intentSpy.calls.length = 0;
    const r2 = await commitOrderEdit(input);
    expect(r2.replay).toBe(true);
    expect(intentSpy.calls).toEqual([]);
    expect(await intentStatuses(o.id)).toEqual(['open']);
    await expectErr(commitOrderEdit({ storeId: STORE, storeSlug: SLUG, code: o.code, actor: 'a', principalKind: 'human', ops: [{ op: 'set_quantity', lineId: l.id, quantity: 4 }], expectedGrandTotal: 1, idempotencyKey: 'stale-1', notifyCustomer: false, settlement: { type: 'leave_due' } }), 'PREVIEW_STALE');
    expect(intentSpy.calls).toEqual([]);
  });

  it('swapping a $100 physical line for a $100 licensed line issues exactly one license (zero balance)', async () => {
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 1 }] });
    const l = (await linesOf(o.code))[0]!;
    const op: EditOpT = { op: 'swap_variant', lineId: l.id, sku: 'L' } as EditOpT;
    const r = await commit(o.code, [op]);
    expect(r.amountDue).toBe(0);
    const lic = () => withStore(STORE, (tx) => tx.select().from(s.license).where(eq(s.license.orderId, o.id)));
    expect(await lic()).toHaveLength(1);
    // a later zero-balance edit never double-issues
    await commit(o.code, [{ op: 'set_shipping_method', code: 'std' }]);
    expect(await lic()).toHaveLength(1);
  });

  it('an agent principal cannot commit entitlement-changing ops, even called directly (service refuses; nothing written)', async () => {
    // B is physical, L is a licensed (entitlement-bearing) variant. Each op below adds, resizes, swaps or removes a licensed line.
    const o = await makeOrder({ lines: [{ sku: 'B', qty: 1 }, { sku: 'L', qty: 1 }] });
    const [lb, ll] = [(await linesOf(o.code)).find((l) => l.variantSku === 'B')!, (await linesOf(o.code)).find((l) => l.variantSku === 'L')!];
    const lic = () => withStore(STORE, (tx) => tx.select().from(s.license).where(eq(s.license.orderId, o.id)));
    for (const op of [
      { op: 'add_item', sku: 'L', quantity: 1, unitPrice: 0 }, { op: 'add_item', sku: 'M', quantity: 1 },
      { op: 'set_quantity', lineId: ll.id, quantity: 2 }, { op: 'set_quantity', lineId: ll.id, quantity: 0 },
      { op: 'swap_variant', lineId: lb.id, sku: 'L' }, { op: 'swap_variant', lineId: ll.id, sku: 'M' }, { op: 'swap_variant', lineId: ll.id, sku: 'A' },
      { op: 'remove_line', lineId: ll.id },
    ] as EditOpT[]) {
      await expectErr(commitOrderEdit({ storeId: STORE, storeSlug: SLUG, code: o.code, actor: 'bot@example.test', principalKind: 'agent', ops: [op], expectedGrandTotal: 3500, idempotencyKey: `agent-${op.op}-${JSON.stringify(op).length}`, notifyCustomer: false, settlement: { type: 'leave_due' } }), 'AGENT_FORBIDDEN');
    }
    expect(await lic()).toHaveLength(0);
    expect(await linesOf(o.code)).toHaveLength(2);
    expect(await audits('edit')).toHaveLength(0);
  });

  it('an agent principal may commit physical-only edits (quantity, add, swap, remove of physical lines; shipping, coupon, adjustment); the human path is unchanged', async () => {
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }] });
    const ls = await linesOf(o.code);
    const la = ls.find((l) => l.variantSku === 'A')!, lb = ls.find((l) => l.variantSku === 'B')!;
    const agent = { principalKind: 'agent' as const, actor: 'bot@example.test' };
    const steps: EditOpT[][] = [
      [{ op: 'set_quantity', lineId: la.id, quantity: 3 }],
      [{ op: 'add_item', sku: 'C', quantity: 1 }],
      [{ op: 'swap_variant', lineId: lb.id, sku: 'A' }],
      [{ op: 'set_shipping_method', code: 'exp' }],
      [{ op: 'apply_coupon', code: 'TEN' }],
      [{ op: 'remove_line', lineId: la.id }],
    ];
    for (const ops of steps) {
      // the balance can be due or a credit after each step: take whichever settlement the preview allows
      const r = await commit(o.code, ops, agent, { type: 'leave_due' }).catch(async (e) => {
        if (!(e instanceof OrderEditError) || e.code !== 'SETTLEMENT_INVALID') throw e;
        return commit(o.code, ops, agent, { type: 'leave_credit' });
      });
      expect(r.replay).toBe(false);
    }
    expect((await audits('edit')).length).toBe(steps.length);
    expect(await withStore(STORE, (tx) => tx.select().from(s.license).where(eq(s.license.orderId, o.id)))).toHaveLength(0);
  });

  it('an agent physical edit on an order that also holds a licensed line does not touch it, and issues nothing (reconciliation still refuses)', async () => {
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 1 }, { sku: 'L', qty: 1 }] }); // licensed line has no licence row yet
    const la = (await linesOf(o.code)).find((l) => l.variantSku === 'A')!;
    await commit(o.code, [{ op: 'set_quantity', lineId: la.id, quantity: 2 }], { principalKind: 'agent', actor: 'bot@example.test' }, { type: 'leave_due' });
    expect(await withStore(STORE, (tx) => tx.select().from(s.license).where(eq(s.license.orderId, o.id)))).toHaveLength(0);
  });

  it('reconciliation refuses to issue when the edit was committed by an agent (a benign edit cannot top up a missing licence); a human edit still does', async () => {
    const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] }); // Paid, fully funded, licensed line with no licence row yet
    const lic = () => withStore(STORE, (tx) => tx.select().from(s.license).where(eq(s.license.orderId, o.id)));
    await commit(o.code, [{ op: 'set_shipping_method', code: 'std' }], { principalKind: 'agent', actor: 'bot@example.test' }, { type: 'leave_due' });
    expect(await lic()).toHaveLength(0);
    expect(await audits('agent_issuance_refused')).toHaveLength(1);
    await commit(o.code, [{ op: 'set_shipping_method', code: 'std' }], {}, { type: 'leave_due' }); // human: today's behaviour, tops up
    expect(await lic()).toHaveLength(1);
  });

  it('a licensed addition covered by credit issues; an unpaid balance does not', async () => {
    const o = await makeOrder({ lines: [{ sku: 'B', qty: 1 }] }); // paid 2500
    const rm = (await linesOf(o.code))[0]!;
    const r = await commit(o.code, [{ op: 'add_item', sku: 'L', quantity: 1 }, { op: 'set_quantity', lineId: rm.id, quantity: 0 }], {}, { type: 'leave_credit' });
    expect(r.amountDue).toBeLessThanOrEqual(0);
    expect(await withStore(STORE, (tx) => tx.select().from(s.license).where(eq(s.license.orderId, o.id)))).toHaveLength(1);
    const o2 = await makeOrder({ lines: [{ sku: 'A', qty: 1 }] });
    await commit(o2.code, [{ op: 'add_item', sku: 'M', quantity: 1 }], {}, { type: 'leave_due' });
    expect(await withStore(STORE, (tx) => tx.select().from(s.license).where(eq(s.license.orderId, o2.id)))).toHaveLength(0);
  });

  it('a line that ever carried a (revoked) license cannot be repointed to another variant', async () => {
    const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const l = (await linesOf(o.code))[0]!;
    await withStore(STORE, (tx) => tx.insert(s.license).values({ storeId: STORE, orderId: o.id, orderLineId: l.id, appKey: 'testapp', licenseKey: 'SR-TESTAPP-REVOKED', status: 'revoked' }));
    await expectErr(previewOrderEdit(STORE, o.code, [{ op: 'swap_variant', lineId: l.id, sku: 'M' } as EditOpT]), 'LINE_LICENSED');
    // quantity changes on a fully revoked line are not blocked
    await previewOrderEdit(STORE, o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 2 }]);
  });

  async function pendingEditRefund() {
    const o = await makeOrder({ lines: [{ sku: 'A', qty: 2 }] });
    const l = (await linesOf(o.code))[0]!;
    nextRefundPending = true;
    const r = await commit(o.code, [{ op: 'set_quantity', lineId: l.id, quantity: 1 }], {}, { type: 'refund_now' });
    expect(r.settlement).toMatchObject({ status: 'pending', refundState: 'Pending' });
    const refund = await withStore(STORE, async (tx) => (await tx.select().from(s.refund).where(eq(s.refund.orderId, o.id)))[0]!);
    return { o, r, refund };
  }
  const finalize = async (attemptId: string, state: 'Settled' | 'Failed') => {
    const { finalizeRefund } = await import('../payments/refunds.js');
    await withStore(STORE, (tx) => finalizeRefund(tx, STORE, attemptId, { state, providerRef: null } as never));
  };
  const historySettlement = async (code: string, editId: string) => (await loadEditContext(STORE, code)).history.find((h) => h.id === editId)!.settlement as { status: string; refundState?: string };

  it('Pending -> Failed edit refund shows failed in history and is retryable', async () => {
    const { retryOrderEditRefund } = await import('./order-edit-service.js');
    const { o, r, refund } = await pendingEditRefund();
    expect(await historySettlement(o.code, r.editId)).toMatchObject({ status: 'pending' });
    await expectErr(retryOrderEditRefund({ storeId: STORE, code: o.code, editId: r.editId, actor: 'x', action: 'retry' }), 'REFUND_NOT_RETRYABLE');
    await finalize(refund.attemptId!, 'Failed');
    expect(await historySettlement(o.code, r.editId)).toMatchObject({ status: 'failed', refundState: 'Failed' });
    const out = await retryOrderEditRefund({ storeId: STORE, code: o.code, editId: r.editId, actor: 'x', action: 'retry' });
    expect(out.settlement).toMatchObject({ type: 'refund_now', status: 'settled', amount: 1000 });
    expect(out.amountDue).toBe(0);
  });

  it('Pending -> Settled edit refund shows settled and is not retryable', async () => {
    const { retryOrderEditRefund } = await import('./order-edit-service.js');
    const { o, r, refund } = await pendingEditRefund();
    await finalize(refund.attemptId!, 'Settled');
    expect(await historySettlement(o.code, r.editId)).toMatchObject({ status: 'settled', refundState: 'Settled' });
    await expectErr(retryOrderEditRefund({ storeId: STORE, code: o.code, editId: r.editId, actor: 'x', action: 'retry' }), 'REFUND_NOT_RETRYABLE');
  });
});

describe('legacy edit_reconcile effects (queued before actorKind existed)', () => {
  const emails: string[] = [];
  const adminOf = async (kind: string) => {
    const email = `legacy-${kind}-${Math.random().toString(16).slice(2, 10)}@example.test`;
    emails.push(email);
    await pool.query('INSERT INTO admin_user (email, kind) VALUES ($1, $2)', [email, kind]);
    return email;
  };
  afterAll(async () => { if (emails.length) await pool.query('DELETE FROM admin_user WHERE email = ANY($1)', [emails]); });

  /** An effect exactly as a pre-release order edit left it: no actorKind in the payload, queued under the edit's operation. */
  async function legacyEffect(o: { id: string }, opts: { actor: string | null; kind?: string; paymentId?: string; editRow?: boolean }) {
    const editId = crypto.randomUUID();
    const kind = opts.kind ?? 'order_edit_balance_settled';
    return withStore(STORE, async (tx) => {
      if (opts.editRow !== false) {
        await tx.insert(s.orderEdit).values({ id: editId, storeId: STORE, orderId: o.id, before: {}, after: {}, actor: opts.actor });
      }
      await tx.insert(s.settlementOperation).values({ storeId: STORE, operationKind: kind, operationId: editId, orderId: o.id, paymentId: opts.paymentId ?? null });
      const [eff] = await tx.insert(s.orderPendingEffect).values({
        storeId: STORE, operationKind: kind, operationId: editId, effectKind: 'edit_reconcile',
        payload: { orderId: o.id, customerId: null, paidAt: new Date().toISOString() },
      }).returning({ id: s.orderPendingEffect.id });
      return { editId, effectId: eff!.id };
    });
  }
  const effectRow = (id: string) => withStore(STORE, async (tx) => (await tx.select().from(s.orderPendingEffect).where(eq(s.orderPendingEffect.id, id)))[0]!);
  const licensesOf = (orderId: string) => withStore(STORE, (tx) => tx.select().from(s.license).where(eq(s.license.orderId, orderId)));
  const run = async () => { const { runEffectsPass } = await import('../payments/settlement/effects.js'); return runEffectsPass({ rounds: 2 }); };

  it('an edit by an agent admin, queued with no principal, is refused terminal with an audit row and issues nothing', async () => {
    const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const e = await legacyEffect(o, { actor: await adminOf('agent') });
    await run();
    expect((await effectRow(e.effectId)).status).toBe('terminal');
    expect(await licensesOf(o.id)).toHaveLength(0);
    expect(await audits('agent_issuance_refused')).toHaveLength(1);
  });

  it('an edit whose actor cannot be resolved (no admin row, no actor, no edit row) is held terminal, never issued', async () => {
    for (const [i, opts] of ([{ actor: 'ghost@example.test' }, { actor: null }, { actor: null, editRow: false }] as const).entries()) {
      const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
      const e = await legacyEffect(o, opts);
      await run();
      expect((await effectRow(e.effectId)).status, `case ${i}`).toBe('terminal');
      expect(await licensesOf(o.id), `case ${i}`).toHaveLength(0);
    }
    expect(await audits('edit_issuance_held_unresolved_principal')).toHaveLength(3);
  });

  it('an edit by a human admin still issues (behaviour for human admins is unchanged)', async () => {
    const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const e = await legacyEffect(o, { actor: await adminOf('human') });
    await run();
    expect((await effectRow(e.effectId)).status).toBe('done');
    expect(await licensesOf(o.id)).toHaveLength(1);
  });

  it('the decision is identical on every retry: a recorded agent refusal survives the admin row changing and a requeue', async () => {
    const { requeueTerminalEffect } = await import('../payments/settlement/effects.js');
    const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const actor = await adminOf('agent');
    const e = await legacyEffect(o, { actor });
    await run();
    expect((await effectRow(e.effectId)).status).toBe('terminal');
    await pool.query("UPDATE admin_user SET kind = 'human' WHERE email = $1", [actor]);
    await withStore(STORE, (tx) => requeueTerminalEffect(tx, e.effectId));
    await run();
    expect((await effectRow(e.effectId)).status).toBe('terminal');
    expect(await licensesOf(o.id)).toHaveLength(0);
    expect(await audits('edit_principal_resolved')).toHaveLength(1);
  });

  it('customer-payment effects are unchanged: a balance paid by the customer (operation recorded a payment) or any other operation kind issues without an actor lookup', async () => {
    const o1 = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const e1 = await legacyEffect(o1, { actor: await adminOf('agent'), paymentId: crypto.randomUUID() });
    const o2 = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const e2 = await legacyEffect(o2, { actor: null, kind: 'payment_settled', editRow: false });
    await run();
    expect((await effectRow(e1.effectId)).status).toBe('done');
    expect((await effectRow(e2.effectId)).status).toBe('done');
    expect(await licensesOf(o1.id)).toHaveLength(1);
    expect(await licensesOf(o2.id)).toHaveLength(1);
  });

  it('an effect that carries actorKind keeps using it (no lookup): agent refused, human issues', async () => {
    const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const e = await legacyEffect(o, { actor: await adminOf('human') });
    // order_pending_effect is under RLS: update it inside the store scope (a bare pool query changes no rows).
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE order_pending_effect SET payload = payload || '{"actorKind":"agent"}'::jsonb WHERE id = ${e.effectId}`));
    await run();
    expect((await effectRow(e.effectId)).status).toBe('terminal');
    expect(await licensesOf(o.id)).toHaveLength(0);
  });
});


// Issue #192: a human's explicit approval of a held edit_reconcile effect (POST .../effects/:id/approve-issuance).
describe('approve a held edit issuance', () => {
  const emails: string[] = [];
  const adminIds: string[] = [];
  const mkAdmin = async (kind: string, role?: string) => {
    const email = `appr-${kind}-${Math.random().toString(16).slice(2, 10)}@example.test`;
    emails.push(email);
    const r = await pool.query('INSERT INTO admin_user (email, kind, password_hash) VALUES ($1, $2, $3) RETURNING id', [email, kind, 'x']);
    const id = r.rows[0].id as string;
    adminIds.push(id);
    if (role) await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${id}, ${STORE}, ${role})`));
    return { id, email };
  };
  afterAll(async () => {
    if (!emails.length) return;
    // Children first: store grants and sessions reference admin_user.
    await pool.query('DELETE FROM admin_user_store WHERE admin_user_id IN (SELECT id FROM admin_user WHERE email = ANY($1))', [emails]);
    await pool.query('DELETE FROM session WHERE admin_user_id IN (SELECT id FROM admin_user WHERE email = ANY($1))', [emails]);
    await pool.query('DELETE FROM admin_user WHERE email = ANY($1)', [emails]);
  });

  let http: OpenAPIHono;
  let ownerToken = '';
  let owner = { id: '', email: '' };
  const call = (token: string, path: string, method = 'POST') => http.request(path, { method, headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG } });
  const approve = (token: string, effectId: string) => call(token, `/v1/admin/payment-reconciliation/effects/${effectId}/approve-issuance`);
  const errCode = async (r: Response) => ((await r.json()) as { error?: { code?: string } }).error?.code;

  beforeEach(async () => {
    const { buildHttpApp } = await import('../app.js');
    const { createAdminSession } = await import('../auth/admin-session.js');
    http = buildHttpApp() as unknown as OpenAPIHono;
    owner = await mkAdmin('human', 'owner');
    ownerToken = await createAdminSession(owner.id);
  });

  /** A held effect: a legacy edit whose actor cannot be resolved (or an agent-made edit), run once to its terminal hold. */
  async function heldEffect(o: { id: string }, via: 'unresolved' | 'agent' = 'unresolved') {
    const editId = crypto.randomUUID();
    const eff = await withStore(STORE, async (tx) => {
      await tx.insert(s.orderEdit).values({ id: editId, storeId: STORE, orderId: o.id, before: {}, after: {}, actor: via === 'unresolved' ? 'ghost@example.test' : 'x@example.test' });
      await tx.insert(s.settlementOperation).values({ storeId: STORE, operationKind: 'order_edit_balance_settled', operationId: editId, orderId: o.id, paymentId: null });
      const [row] = await tx.insert(s.orderPendingEffect).values({
        storeId: STORE, operationKind: 'order_edit_balance_settled', operationId: editId, effectKind: 'edit_reconcile',
        payload: { orderId: o.id, customerId: null, paidAt: new Date().toISOString(), ...(via === 'agent' ? { actorKind: 'agent' } : {}) },
      }).returning({ id: s.orderPendingEffect.id });
      return row!;
    });
    await run();
    const e = await effectRow(eff.id);
    expect(e.status).toBe('terminal');
    return { effectId: eff.id, editId };
  }
  const run = async () => { const { runEffectsPass } = await import('../payments/settlement/effects.js'); return runEffectsPass({ rounds: 2 }); };
  const effectRow = (id: string) => withStore(STORE, async (tx) => (await tx.select().from(s.orderPendingEffect).where(eq(s.orderPendingEffect.id, id)))[0]!);
  const licensesOf = (orderId: string) => withStore(STORE, (tx) => tx.select().from(s.license).where(eq(s.license.orderId, orderId)));
  const reviewOf = (editId: string) => withStore(STORE, async (tx) => (await tx.select().from(s.orderPendingEffect).where(and(eq(s.orderPendingEffect.operationId, editId), eq(s.orderPendingEffect.effectKind, 'admin_review'))))[0]!);
  const approvalAudits = (effectId: string) => withStore(STORE, (tx) => tx.select().from(s.auditLog).where(and(eq(s.auditLog.action, 'edit_issuance_approved'), eq(s.auditLog.entityId, effectId))));

  it('a human approves a held effect: issues once, audit row, effect done, review task resolved, original decision untouched', async () => {
    const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const { effectId, editId } = await heldEffect(o);
    expect((await reviewOf(editId)).resolution).toBeNull();
    const { listEffectsNeedingAttention } = await import('../payments/settlement/effects.js');
    expect((await withStore(STORE, (tx) => listEffectsNeedingAttention(tx))).map((r) => r.id)).toContain((await reviewOf(editId)).id);

    const r = await approve(ownerToken, effectId);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ effectId, orderId: o.id, approved: true, alreadyApproved: false, status: 'done' });

    const e = await effectRow(effectId);
    expect(e.status).toBe('done');
    expect((e.payload as { issuanceApprovedBy: Record<string, unknown> }).issuanceApprovedBy).toMatchObject({ adminUserId: owner.id, email: owner.email, effectId, orderId: o.id });
    expect(await licensesOf(o.id)).toHaveLength(1);
    const [audit] = await approvalAudits(effectId);
    expect(audit!.actor).toBe(owner.email);
    expect(audit!.data).toMatchObject({ adminUserId: owner.id, effectId, orderId: o.id, heldReason: 'EDIT_PRINCIPAL_UNRESOLVED' });
    // the review task is closed and the effect leaves the attention list
    expect((await reviewOf(editId)).resolution).toMatchObject({ action: 'approved_issuance', adminUserId: owner.id, effectId });
    const open = (await withStore(STORE, (tx) => listEffectsNeedingAttention(tx))).map((x) => x.operationId);
    expect(open).not.toContain(editId);
    // provenance is not rewritten: the recorded decision is still "unresolved"
    const decided = await audits('edit_principal_resolved');
    expect(decided).toHaveLength(1);
    expect(decided[0]!.data).toMatchObject({ kind: 'unresolved' });
  });

  it('an agent-refused hold (actorKind agent) is approvable too', async () => {
    const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const { effectId } = await heldEffect(o, 'agent');
    expect((await effectRow(effectId)).lastError).toBe('AGENT_ISSUANCE_REFUSED');
    expect((await approve(ownerToken, effectId)).status).toBe(200);
    expect((await effectRow(effectId)).status).toBe('done');
    expect(await licensesOf(o.id)).toHaveLength(1);
  });

  it('approving twice is idempotent: one licence, one approval audit row', async () => {
    const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const { effectId } = await heldEffect(o);
    expect((await approve(ownerToken, effectId)).status).toBe(200);
    const again = await approve(ownerToken, effectId);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ alreadyApproved: true, status: 'done' });
    expect(await licensesOf(o.id)).toHaveLength(1);
    expect(await approvalAudits(effectId)).toHaveLength(1);
  });

  it('an agent bearer token and an agent browser session are refused (403); nothing changes', async () => {
    const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const { effectId } = await heldEffect(o);
    const created = await http.request('/v1/admin/agents', { method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'x-store-slug': SLUG, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ops bot' }) });
    expect(created.status).toBe(200);
    const agent = (await created.json()) as { token: string; adminUserId: string };
    // with every permission granted, the deny set still wins
    expect((await http.request(`/v1/admin/staff/${agent.adminUserId}/permissions`, { method: 'PUT', headers: { authorization: `Bearer ${ownerToken}`, 'x-store-slug': SLUG, 'content-type': 'application/json' }, body: JSON.stringify({ permissions: { refunds: true } }) })).status).toBe(200);
    expect((await approve(agent.token, effectId)).status).toBe(403);
    const bs = await call(agent.token, '/v1/admin/agents/browser-session');
    const sr = /sr_admin=([^;]+)/.exec(bs.headers.get('set-cookie') ?? '')?.[1];
    const csrf = /sr_csrf=([^;]+)/.exec(bs.headers.get('set-cookie') ?? '')?.[1];
    const viaCookie = await http.request(`/v1/admin/payment-reconciliation/effects/${effectId}/approve-issuance`, {
      method: 'POST', headers: { cookie: `sr_admin=${sr}; sr_csrf=${csrf}`, 'x-csrf-token': csrf!, 'x-store-slug': SLUG },
    });
    expect(viaCookie.status).toBe(403);
    const e = await effectRow(effectId);
    expect(e.status).toBe('terminal');
    expect((e.payload as Record<string, unknown>).issuanceApprovedBy).toBeUndefined();
    expect(await licensesOf(o.id)).toHaveLength(0);
    expect(await approvalAudits(effectId)).toHaveLength(0);
  });

  it('a human without the refunds permission, or with a read-only role, is refused', async () => {
    const { createAdminSession } = await import('../auth/admin-session.js');
    const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const { effectId } = await heldEffect(o);
    const staff = await mkAdmin('human', 'staff');
    const viewer = await mkAdmin('human', 'read_only');
    expect((await approve(await createAdminSession(staff.id), effectId)).status).toBe(403);
    expect((await approve(await createAdminSession(viewer.id), effectId)).status).toBe(403);
    expect((await effectRow(effectId)).status).toBe('terminal');
  });

  it('refuses effects that are not held: done, still pending, another kind, unknown id', async () => {
    // done: a human-paid edit effect that issued normally
    const o1 = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const doneEditId = crypto.randomUUID();
    const done = await withStore(STORE, async (tx) => {
      await tx.insert(s.settlementOperation).values({ storeId: STORE, operationKind: 'payment_settled', operationId: doneEditId, orderId: o1.id });
      const [row] = await tx.insert(s.orderPendingEffect).values({ storeId: STORE, operationKind: 'payment_settled', operationId: doneEditId, effectKind: 'edit_reconcile', payload: { orderId: o1.id, customerId: null, paidAt: new Date().toISOString() } }).returning({ id: s.orderPendingEffect.id });
      return row!;
    });
    await run();
    expect((await effectRow(done.id)).status).toBe('done');
    const r1 = await approve(ownerToken, done.id);
    expect([r1.status, await errCode(r1)]).toEqual([409, 'EFFECT_NOT_HELD']);
    expect(await licensesOf(o1.id)).toHaveLength(1);
    // pending: queued, not yet run
    const o2 = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const pendingEditId = crypto.randomUUID();
    const pending = await withStore(STORE, async (tx) => {
      await tx.insert(s.settlementOperation).values({ storeId: STORE, operationKind: 'payment_settled', operationId: pendingEditId, orderId: o2.id });
      const [row] = await tx.insert(s.orderPendingEffect).values({ storeId: STORE, operationKind: 'payment_settled', operationId: pendingEditId, effectKind: 'edit_reconcile', payload: { orderId: o2.id, customerId: null, paidAt: new Date().toISOString() } }).returning({ id: s.orderPendingEffect.id });
      return row!;
    });
    const r2 = await approve(ownerToken, pending.id);
    expect([r2.status, await errCode(r2)]).toEqual([409, 'EFFECT_NOT_HELD']);
    expect((await effectRow(pending.id)).status).toBe('pending');
    // another kind: the admin_review task row itself
    const held = await heldEffect(await makeOrder({ lines: [{ sku: 'L', qty: 1 }] }));
    const r3 = await approve(ownerToken, (await reviewOf(held.editId)).id);
    expect([r3.status, await errCode(r3)]).toEqual([409, 'EFFECT_NOT_HELD']);
    expect((await approve(ownerToken, crypto.randomUUID())).status).toBe(404);
  });

  it('an ordinary retry without approval still reaches the same hold', async () => {
    const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const { effectId, editId } = await heldEffect(o);
    expect((await call(ownerToken, `/v1/admin/payment-reconciliation/effects/${effectId}/retry`)).status).toBe(200);
    await run();
    const e = await effectRow(effectId);
    expect(e.status).toBe('terminal');
    expect(e.lastError).toBe('EDIT_PRINCIPAL_UNRESOLVED');
    expect(await licensesOf(o.id)).toHaveLength(0);
    expect((await reviewOf(editId)).resolution).toBeNull();
  });

  it('an approval on effect A releases neither effect B nor an order other than its own (a copied approval is ignored)', async () => {
    const oa = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const ob = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const a = await heldEffect(oa);
    const b = await heldEffect(ob);
    expect((await approve(ownerToken, a.effectId)).status).toBe(200);
    expect((await effectRow(b.effectId)).status).toBe('terminal');
    expect(await licensesOf(ob.id)).toHaveLength(0);
    // copy A's approval object into B's payload and requeue B: bound to A's effect id and order, with no audit row for B
    const approvalA = ((await effectRow(a.effectId)).payload as { issuanceApprovedBy: unknown }).issuanceApprovedBy;
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`UPDATE order_pending_effect SET payload = payload || ${JSON.stringify({ issuanceApprovedBy: approvalA })}::jsonb WHERE id = ${b.effectId}`);
      const { requeueTerminalEffect } = await import('../payments/settlement/effects.js');
      await requeueTerminalEffect(tx, b.effectId);
    });
    await run();
    expect((await effectRow(b.effectId)).status).toBe('terminal');
    expect(await licensesOf(ob.id)).toHaveLength(0);
    expect((await reviewOf(b.editId)).resolution).toBeNull();
  });
  it('an approval never issues for a line the order has not paid for: a later leave_due licensed addition holds the effect, the review stays open, and the balance settles it', async () => {
    const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] }); // Paid, fully funded
    const { effectId, editId } = await heldEffect(o);
    // A human then adds another licensed line and leaves it due: the order stays Paid with a positive balance.
    const r = await commit(o.code, [{ op: 'add_item', sku: 'M', quantity: 1 }], {}, { type: 'leave_due' });
    expect(r.state).toBe('Paid');
    expect(r.amountDue).toBe(1000);

    const res = await approve(ownerToken, effectId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ effectId, approved: true, status: 'pending' });
    expect(await licensesOf(o.id)).toHaveLength(0); // nothing for the unpaid addition, nor for the funded line
    const e = await effectRow(effectId);
    expect([e.status, e.lastError]).toEqual(['pending', 'EDIT_BALANCE_DUE']);
    // the approval is not consumed by the refusal: it stays on the payload, and the review task stays unresolved
    expect((e.payload as { issuanceApprovedBy: Record<string, unknown> }).issuanceApprovedBy).toMatchObject({ adminUserId: owner.id, effectId, orderId: o.id });
    expect((await reviewOf(editId)).resolution).toBeNull();
    expect(await approvalAudits(effectId)).toHaveLength(1);

    // A worker retry while the balance is still due refuses the same way (every execution is checked).
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE order_pending_effect SET next_attempt_at = now() WHERE id = ${effectId}`));
    await run();
    expect(await licensesOf(o.id)).toHaveLength(0);
    expect((await effectRow(effectId)).lastError).toBe('EDIT_BALANCE_DUE');
    expect((await reviewOf(editId)).resolution).toBeNull();

    // The balance is settled: the retry now takes the normal path, issues once per line, and closes the review.
    await withStore(STORE, (tx) => tx.insert(s.payment).values({ storeId: STORE, orderId: o.id, amount: 1000, method: 'stripe', state: 'Settled', providerRef: `pi_bal_${o.code}`, gatewayMode: 'test', currency: 'USD' }));
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE order_pending_effect SET next_attempt_at = now() WHERE id = ${effectId}`));
    await run();
    const done = await effectRow(effectId);
    expect(done.status).toBe('done');
    expect(await licensesOf(o.id)).toHaveLength(2);
    expect((await reviewOf(editId)).resolution).toMatchObject({ action: 'approved_issuance', adminUserId: owner.id, effectId });
    await run();
    expect(await licensesOf(o.id)).toHaveLength(2);
  });

  // Lock order (issuance-approval.ts): the worker holds the effect row first and then waits for the order set; the approval
  // holds the order set. It must not wait for the effect row (deadlock), it must back off and restart.
  const holdEffectRow = async (effectId: string) => {
    const w = await pool.connect();
    await w.query('BEGIN');
    await w.query(`SELECT set_config('app.current_store', $1, true)`, [STORE]);
    await w.query(`SELECT 1 FROM order_pending_effect WHERE id = $1 FOR UPDATE`, [effectId]);
    return w;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('approve versus a worker holding the effect row: no deadlock, the worker gets the order set while the approval backs off, then one issuance', async () => {
    const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const { effectId } = await heldEffect(o);
    const w = await holdEffectRow(effectId); // worker step 1: the effect row
    let approvalSettled = false;
    const approval = Promise.resolve(approve(ownerToken, effectId)).then((r) => { approvalSettled = true; return r; });
    try {
      await sleep(250); // the approval has taken the order set, been refused the effect row (NOWAIT) and rolled back
      expect(approvalSettled).toBe(false);
      // worker step 2: the order set. With a wait-while-holding approval this is the deadlock cycle (40P01 on one side).
      await w.query(`SET LOCAL lock_timeout = '3s'`);
      await expect(w.query(`SELECT 1 FROM "order" WHERE id = $1 FOR UPDATE`, [o.id])).resolves.toBeDefined();
      expect(approvalSettled).toBe(false); // still cannot take the effect row
      await w.query('COMMIT');
    } finally {
      await w.query('ROLLBACK').catch(() => undefined);
      w.release();
    }
    const res = await approval;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ effectId, approved: true, alreadyApproved: false, status: 'done' });
    expect(await licensesOf(o.id)).toHaveLength(1);
    expect(await approvalAudits(effectId)).toHaveLength(1);
    await run(); // a later worker pass finds nothing to do
    expect(await licensesOf(o.id)).toHaveLength(1);
  });

  it('approve while the effect row stays held: a bounded 409 EFFECT_BUSY, nothing recorded, and a later approval succeeds', async () => {
    const o = await makeOrder({ lines: [{ sku: 'L', qty: 1 }] });
    const { effectId } = await heldEffect(o);
    const w = await holdEffectRow(effectId);
    try {
      const busy = await approve(ownerToken, effectId);
      expect([busy.status, await errCode(busy)]).toEqual([409, 'EFFECT_BUSY']);
    } finally {
      await w.query('ROLLBACK').catch(() => undefined);
      w.release();
    }
    const e = await effectRow(effectId);
    expect(e.status).toBe('terminal');
    expect((e.payload as Record<string, unknown>).issuanceApprovedBy).toBeUndefined();
    expect(await approvalAudits(effectId)).toHaveLength(0);
    expect(await licensesOf(o.id)).toHaveLength(0);
    expect((await approve(ownerToken, effectId)).status).toBe(200);
    expect(await licensesOf(o.id)).toHaveLength(1);
  }, 20000);
});
