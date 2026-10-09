/**
 * Order editing (G13) — NMI + Sezzle balance payments, DB integration.
 * A Paid / PartiallyRefunded order whose edit raised the total owes a balance;
 * the gateway start path charges exactly amountDue under a per-attempt key,
 * settling never changes the order state, and nothing-due stays a 409.
 * Providers are mocked at the boundary (never a real NMI/Sezzle call).
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';

const nmiCalls: Array<{ amount: number; orderCode: string }> = [];
vi.mock('./provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider.js')>();
  const nmiMock = {
    method: 'nmi', requiresRedirect: false,
    async createPayment(input: { orderCode: string; amount: number }) {
      nmiCalls.push({ amount: input.amount, orderCode: input.orderCode });
      return { state: 'Settled' as const, providerRef: `nmi_tx_${nmiCalls.length}`, metadata: {} };
    },
  };
  return { ...actual, getProvider: (m: string) => (m === 'nmi' ? nmiMock : actual.getProvider(m)) };
});
vi.mock('./gateway-account.js', async (original) => {
  const account = (method: string) => ({
    storeId: 'e1000000-0000-0000-0000-0000000e1001', accountId: `${method}-acct`, method, mode: 'test',
    ...(method === 'nmi' ? { nmiEnvironment: 'sandbox', securityKey: 'fixture' } : { publicKey: 'pub', privateKey: 'priv' }),
  });
  return {
    ...await original<typeof import('./gateway-account.js')>(),
    resolveConfiguredGatewayAccount: async (_s: string, m: string) => account(m),
    resolveGatewayAccount: async (_s: string, m: string) => account(m),
  };
});
vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: vi.fn() }));

import { sezzleProvider } from './sezzle.js';
import { startGatewayPayment, verifyGatewayAttempt } from './gateway-payment.js';
import { orders } from '../routes/orders.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`balance-pay test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'e1000000-0000-0000-0000-0000000e1001';
const RT = 'rt_balance_pay_receipt_token_abcdefghijkl';
const CONFIG = { payments: { nmi: true, sezzle: true }, storefrontUrl: 'https://shop.example.test' };

const sessions: Array<Record<string, unknown>> = [];
let sezzleSeq = 0;
vi.spyOn(sezzleProvider, 'createSession').mockImplementation(async (input) => {
  sessions.push(input as unknown as Record<string, unknown>);
  sezzleSeq++;
  return { providerRef: `sz-order-${sezzleSeq}`, checkoutUrl: `https://sandbox.checkout.sezzle.com/?id=${sezzleSeq}` };
});
vi.spyOn(sezzleProvider, 'createPayment').mockImplementation(async (input) => ({
  state: 'Settled', providerRef: String(input.token), metadata: {},
}));

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }
beforeEach(async () => {
  nmiCalls.length = 0; sessions.length = 0; sezzleSeq = 0;
  await wipe();
  await withStore(STORE, async (tx) => {
    await tx.insert(s.store).values({ id: STORE, slug: 'balpay', name: 'Bal Pay', currency: 'USD', config: CONFIG });
  });
});
afterAll(async () => { await wipe(); await pool.end(); });

/** Order edited up to `grandTotal` after `paid` was captured. */
async function makeOrder(o: { code: string; state: 'PendingPayment' | 'Paid' | 'PartiallyRefunded'; paid: number }) {
  return withStore(STORE, async (tx) => {
    const [ord] = await tx.insert(s.order).values({
      storeId: STORE, code: o.code, state: o.state, currency: 'USD', receiptToken: RT,
      subtotal: 2500, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 2500,
      shippingAddress: { fullName: 'Ship Er', line1: '1 Main St', city: 'Austin', province: 'TX', postalCode: '78701', country: 'US' },
      metadata: { contact: { email: 'cust@example.test' } },
    }).returning({ id: s.order.id });
    await tx.insert(s.orderLine).values({
      storeId: STORE, orderId: ord!.id, variantSku: 'A', variantName: 'Widget A', quantity: 1,
      unitPrice: 2500, lineSubtotal: 2500, lineTotal: 2500,
    });
    if (o.paid > 0) {
      await tx.insert(s.payment).values({ storeId: STORE, orderId: ord!.id, amount: o.paid, method: 'stripe', state: 'Settled', providerRef: `pi_${o.code}`, gatewayMode: 'test', currency: 'USD' });
    }
    return ord!.id;
  });
}
const orderRow = (code: string) => withStore(STORE, async (tx) => (await tx.select().from(s.order).where(eq(s.order.code, code)))[0]!);
const payments = (orderId: string) => withStore(STORE, (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, orderId)));
const attempts = (orderId: string) => withStore(STORE, (tx) => tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.orderId, orderId)));
const start = (code: string, method: 'nmi' | 'sezzle', idempotencyKey: string) => startGatewayPayment({
  storeId: STORE, code, method, config: CONFIG, idempotencyKey, receiptToken: RT, token: method === 'nmi' ? 'tok_1' : undefined,
});

describe('NMI balance payment', () => {
  it('charges exactly the amount due on a Paid order and keeps it Paid', async () => {
    const id = await makeOrder({ code: 'BAL1', state: 'Paid', paid: 1500 });
    const res = await start('BAL1', 'nmi', 'k1');
    expect(res.status).toBe('settled');
    expect(nmiCalls).toEqual([{ amount: 1000, orderCode: 'BAL1' }]);
    expect((await orderRow('BAL1')).state).toBe('Paid');
    const pays = await payments(id);
    expect(pays.filter((p) => p.method === 'nmi').map((p) => p.amount)).toEqual([1000]);
    expect(pays.filter((p) => p.state === 'Settled').reduce((n, p) => n + p.amount, 0)).toBe(2500);
  });

  it('works on a PartiallyRefunded order and keeps that state', async () => {
    await makeOrder({ code: 'BAL2', state: 'PartiallyRefunded', paid: 2000 });
    expect((await start('BAL2', 'nmi', 'k1')).status).toBe('settled');
    expect(nmiCalls[0]!.amount).toBe(500);
    expect((await orderRow('BAL2')).state).toBe('PartiallyRefunded');
  });

  it('a second balance after another edit gets a new attempt key and its own charge', async () => {
    const id = await makeOrder({ code: 'BAL3', state: 'Paid', paid: 1500 });
    await start('BAL3', 'nmi', 'same-client-key');
    // Fully covered now: nothing due.
    await expect(start('BAL3', 'nmi', 'same-client-key-2')).rejects.toMatchObject({ status: 409 });
    // Another edit raises the total by 700.
    await withStore(STORE, (tx) => tx.update(s.order).set({ grandTotal: 3200 }).where(eq(s.order.id, id)));
    const second = await start('BAL3', 'nmi', 'same-client-key');
    expect(second.status).toBe('settled');
    expect(nmiCalls.map((c) => c.amount)).toEqual([1000, 700]);
    const keys = (await attempts(id)).map((a) => a.idempotencyKey).sort();
    expect(keys).toEqual(['same-client-key:balance:1', 'same-client-key:balance:2']);
    expect((await orderRow('BAL3')).state).toBe('Paid');
  });

  it('replaying the same balance key while nothing changed does not charge twice', async () => {
    await makeOrder({ code: 'BAL4', state: 'Paid', paid: 1500 });
    expect((await start('BAL4', 'nmi', 'dup')).status).toBe('settled');
    // After settling, the balance is zero: a replay is a 409, never a second charge.
    await expect(start('BAL4', 'nmi', 'dup')).rejects.toMatchObject({ status: 409 });
    expect(nmiCalls).toHaveLength(1);
  });

  it('nothing due on a Paid order is 409 and charges nothing', async () => {
    await makeOrder({ code: 'BAL5', state: 'Paid', paid: 2500 });
    await expect(start('BAL5', 'nmi', 'k1')).rejects.toMatchObject({ status: 409, message: 'Order is already paid' });
    expect(nmiCalls).toHaveLength(0);
  });

  it('an unrelated state (Cancelled) stays not payable', async () => {
    await makeOrder({ code: 'BAL6', state: 'Paid', paid: 1500 });
    await withStore(STORE, (tx) => tx.update(s.order).set({ state: 'Cancelled' }).where(eq(s.order.code, 'BAL6')));
    await expect(start('BAL6', 'nmi', 'k1')).rejects.toMatchObject({ status: 409, message: 'Order is not payable' });
  });

  it('PendingPayment behaviour is unchanged: raw key, full amount, flips to Paid', async () => {
    const id = await makeOrder({ code: 'PEND1', state: 'PendingPayment', paid: 0 });
    const res = await start('PEND1', 'nmi', 'raw-key');
    expect(res.status).toBe('settled');
    expect(nmiCalls).toEqual([{ amount: 2500, orderCode: 'PEND1' }]);
    expect((await attempts(id))[0]!.idempotencyKey).toBe('raw-key');
    expect((await orderRow('PEND1')).state).toBe('Paid');
    // A retry of the checkout request still replays the original attempt.
    const replay = await start('PEND1', 'nmi', 'raw-key');
    expect(replay.attemptId).toBe(res.attemptId);
    expect(nmiCalls).toHaveLength(1);
  });

  it('a wrong receipt token reads as not found', async () => {
    await makeOrder({ code: 'BAL7', state: 'Paid', paid: 1500 });
    await expect(startGatewayPayment({ storeId: STORE, code: 'BAL7', method: 'nmi', config: CONFIG, idempotencyKey: 'k', receiptToken: 'nope', token: 't' }))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('Sezzle balance payment', () => {
  it('creates a session for the balance amount with a balance description and return URL', async () => {
    const id = await makeOrder({ code: 'SZ1', state: 'Paid', paid: 1500 });
    const res = await start('SZ1', 'sezzle', 'sk1');
    expect(res.status).toBe('pending');
    expect(res.checkoutUrl).toContain('sezzle.com');
    const input = sessions[0] as { amount: number; description: string; completeUrl: string; cancelUrl: string; discount: number; items: unknown[] };
    expect(input.amount).toBe(1000);
    expect(input.description).toBe('Order SZ1 balance');
    const complete = new URL(input.completeUrl);
    expect(complete.pathname).toBe('/orders/SZ1');
    expect(complete.searchParams.get('pay')).toBe('balance');
    expect(complete.searchParams.get('rt')).toBe(RT);
    expect(complete.searchParams.get('paymentAttempt')).toBe(res.attemptId);
    expect(new URL(input.cancelUrl).pathname).toBe('/orders/SZ1');
    expect(input.discount).toBe(1500);
    expect((await attempts(id))[0]!.amount).toBe(1000);
  });

  it('verify (return/webhook/recovery path) settles the balance and keeps the order Paid', async () => {
    const id = await makeOrder({ code: 'SZ2', state: 'Paid', paid: 1500 });
    const res = await start('SZ2', 'sezzle', 'sk1');
    const done = await verifyGatewayAttempt(STORE, res.attemptId);
    expect(done.status).toBe('settled');
    expect((await orderRow('SZ2')).state).toBe('Paid');
    const sz = (await payments(id)).filter((p) => p.method === 'sezzle');
    expect(sz.map((p) => [p.amount, p.state])).toEqual([[1000, 'Settled']]);
    // A second verify (webhook after return) is idempotent.
    expect((await verifyGatewayAttempt(STORE, res.attemptId)).status).toBe('settled');
    expect((await payments(id)).filter((p) => p.method === 'sezzle')).toHaveLength(1);
  });

  it('a second balance after another edit opens a new session under a new key', async () => {
    const id = await makeOrder({ code: 'SZ3', state: 'Paid', paid: 1500 });
    const first = await start('SZ3', 'sezzle', 'sk');
    await verifyGatewayAttempt(STORE, first.attemptId);
    await withStore(STORE, (tx) => tx.update(s.order).set({ grandTotal: 3200 }).where(eq(s.order.id, id)));
    // Subtotal must still reconcile for the Sezzle session snapshot.
    await withStore(STORE, async (tx) => {
      await tx.update(s.order).set({ subtotal: 3200 }).where(eq(s.order.id, id));
      await tx.update(s.orderLine).set({ unitPrice: 3200, lineSubtotal: 3200, lineTotal: 3200 }).where(eq(s.orderLine.orderId, id));
    });
    const second = await start('SZ3', 'sezzle', 'sk');
    expect(second.attemptId).not.toBe(first.attemptId);
    expect((sessions[1] as { amount: number }).amount).toBe(700);
    expect((await attempts(id)).map((a) => a.idempotencyKey).sort()).toEqual(['sk:balance:1', 'sk:balance:2']);
  });

  it('nothing due is 409 and creates no session', async () => {
    await makeOrder({ code: 'SZ4', state: 'Paid', paid: 2500 });
    await expect(start('SZ4', 'sezzle', 'sk')).rejects.toMatchObject({ status: 409 });
    expect(sessions).toHaveLength(0);
  });

  it('PendingPayment keeps the checkout confirmation return URL', async () => {
    await makeOrder({ code: 'SZP', state: 'PendingPayment', paid: 0 });
    await start('SZP', 'sezzle', 'raw');
    const input = sessions[0] as { amount: number; description: string; completeUrl: string; cancelUrl: string };
    expect(input.amount).toBe(2500);
    expect(input.description).toBeUndefined(); // provider default: `Order <code>`
    expect(new URL(input.completeUrl).pathname).toBe('/checkout/confirmation/SZP');
    expect(new URL(input.cancelUrl).pathname).toBe('/checkout');
  });
});

describe('GET /v1/shop/orders/{code} balance fields', () => {
  const read = (code: string, rt?: string) => orders.request(`/v1/shop/orders/${code}${rt ? `?rt=${rt}` : ''}`, { headers: { 'x-store-slug': 'balpay' } });

  it('exposes amountDue and the latest edit summary only to the receipt holder', async () => {
    const id = await makeOrder({ code: 'RD1', state: 'Paid', paid: 1500 });
    await withStore(STORE, (tx) => tx.insert(s.orderEdit).values({
      storeId: STORE, orderId: id, balance: 1000, reason: 'internal note',
      before: { totals: { grandTotal: 1500 }, lines: [{ sku: 'A', name: 'Widget A', quantity: 1 }] },
      after: { totals: { grandTotal: 2500 }, lines: [{ sku: 'A', name: 'Widget A', quantity: 2 }] },
    }));
    const ok = await read('RD1', RT);
    expect(ok.status).toBe(200);
    const body = await ok.json() as { amountDue: number; balanceChange: { previousGrandTotal: number; changes: string[] } | null };
    expect(body.amountDue).toBe(1000);
    expect(body.balanceChange).toMatchObject({ previousGrandTotal: 1500, changes: ['Widget A: quantity 1 → 2'] });
    expect(JSON.stringify(body)).not.toContain('internal note');
    expect((await read('RD1')).status).toBe(404);
    expect((await read('RD1', 'wrong')).status).toBe(404);
  });

  it('is 0 / null when nothing is due or the order is unpaid', async () => {
    await makeOrder({ code: 'RD2', state: 'Paid', paid: 2500 });
    await makeOrder({ code: 'RD3', state: 'PendingPayment', paid: 0 });
    for (const code of ['RD2', 'RD3']) {
      const body = await (await read(code, RT)).json() as { amountDue: number; balanceChange: unknown };
      expect(body.amountDue).toBe(0);
      expect(body.balanceChange).toBeNull();
    }
  });
});
