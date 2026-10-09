/**
 * Stripe balance payments (order editing, G13), DB integration.
 * A Paid / PartiallyRefunded order whose edit raised the total owes a balance.
 * The shopper pays it with the SAME Stripe path as checkout:
 *   POST /payment-intent  (amount = amountDue, keyed per settled tender)
 *   POST /pay             (verifies the PI against amountDue; order stays Paid)
 * and the webhook / refresh reconcile path must never double-settle it.
 * Stripe is mocked at the seam (mint / retrieve); everything else is real.
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const intents = new Map<string, Record<string, unknown>>();
const mintCalls: Array<{ amount: number; idempotencyKey?: string; intentId: string }> = [];
vi.mock('../payments/stripe.js', async (orig) => {
  const actual = await orig<typeof import('../payments/stripe.js')>();
  return {
    ...actual,
    resolveStripeUsable: async () => true,
    stripeModeFromConfig: () => 'test' as const,
    // Stripe replays the same PI for a repeated idempotency key.
    createPaymentIntent: vi.fn(async (o: { orderCode: string; amount: number; currency: string; idempotencyKey?: string }) => {
      const intentId = `pi_${o.idempotencyKey}`;
      if (!intents.has(intentId)) {
        intents.set(intentId, { id: intentId, amount: o.amount, currency: o.currency.toLowerCase(), status: 'requires_payment_method', metadata: { orderCode: o.orderCode }, latest_charge: null });
      }
      mintCalls.push({ amount: o.amount, idempotencyKey: o.idempotencyKey, intentId });
      return { clientSecret: `${intentId}_secret`, intentId };
    }),
    stripeProvider: {
      ...actual.stripeProvider,
      createPayment: vi.fn(async (input: Parameters<typeof actual.stripeProvider.createPayment>[0]) => {
        const id = typeof input.token === 'string' ? input.token : '';
        const pi = intents.get(id);
        if (!pi) return { state: 'Failed' as const, providerRef: id || null, errorMessage: 'No such payment_intent' };
        return actual.verifyIntent(pi as unknown as Parameters<typeof actual.verifyIntent>[0], input);
      }),
    },
  };
});
vi.mock('../payments/provider.js', async (orig) => {
  const actual = await orig<typeof import('../payments/provider.js')>();
  return { ...actual, isPaymentMethodEnabled: () => true };
});
vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: () => undefined }));

import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { applyStripeIntent } from '../payments/stripe-reconcile.js';
import { pay } from './pay.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`stripe balance-pay test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'e2000000-0000-0000-0000-0000000e2001';
const SLUG = 'stripebal-test';
const RT = 'rt_stripe_balance_receipt_token_abcdefghi';
const app = new OpenAPIHono();
app.route('/', pay);

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  intents.clear(); mintCalls.length = 0;
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', ${JSON.stringify({ payments: { stripe: true }, stripe: { mode: 'test' } })}::jsonb)`);
  });
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); await pool.end(); });

/** A Paid order edited up to `grandTotal` after `paid` was captured by Stripe. */
async function makeOrder(o: { code: string; state?: 'Paid' | 'PartiallyRefunded' | 'PendingPayment'; paid: number; grandTotal: number }) {
  return withStore(STORE, async (tx) => {
    const [ord] = await tx.insert(s.order).values({
      storeId: STORE, code: o.code, state: o.state ?? 'Paid', currency: 'USD', receiptToken: RT,
      subtotal: o.grandTotal, grandTotal: o.grandTotal,
    }).returning({ id: s.order.id });
    if (o.paid > 0) {
      await tx.insert(s.payment).values({ storeId: STORE, orderId: ord!.id, amount: o.paid, method: 'stripe', state: 'Settled', providerRef: `pi_orig_${o.code}`, gatewayMode: 'test', currency: 'USD' });
    }
    return ord!.id;
  });
}
const hdr = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-store-slug': SLUG, 'x-receipt-token': RT, ...extra });
const intent = (code: string) => app.request(`/v1/shop/orders/${code}/payment-intent`, { method: 'POST', headers: hdr() });
const payWith = (code: string, token: string, extra: Record<string, string> = {}) =>
  app.request(`/v1/shop/orders/${code}/pay`, { method: 'POST', headers: hdr(extra), body: JSON.stringify({ method: 'stripe', token }) });
const orderRow = (id: string) => withStore(STORE, async (tx) => (await tx.select().from(s.order).where(eq(s.order.id, id)))[0]!);
const payments = (id: string) => withStore(STORE, (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, id)));
const settle = (id: string) => { const pi = intents.get(id)!; intents.set(id, { ...pi, status: 'succeeded', latest_charge: 'ch_1' }); };
const raiseTotal = (id: string, grandTotal: number) => withStore(STORE, (tx) => tx.update(s.order).set({ grandTotal }).where(eq(s.order.id, id)));

describe('Stripe balance payment-intent', () => {
  it('mints a PaymentIntent for exactly the amount due on a Paid order', async () => {
    const id = await makeOrder({ code: 'SB1', paid: 1500, grandTotal: 2500 });
    const res = await intent('SB1');
    expect(res.status).toBe(200);
    expect(mintCalls).toHaveLength(1);
    expect(mintCalls[0]!.amount).toBe(1000);
    expect(mintCalls[0]!.idempotencyKey).toBe(`pi:${id}:1000:bal1`);
  });

  it('works on a PartiallyRefunded order', async () => {
    await makeOrder({ code: 'SB2', state: 'PartiallyRefunded', paid: 2000, grandTotal: 2500 });
    expect((await intent('SB2')).status).toBe(200);
    expect(mintCalls[0]!.amount).toBe(500);
  });

  it('a retry at the same amount reuses the open PaymentIntent (same client secret)', async () => {
    await makeOrder({ code: 'SB3', paid: 1500, grandTotal: 2500 });
    const a = await (await intent('SB3')).json() as { clientSecret: string };
    const b = await (await intent('SB3')).json() as { clientSecret: string };
    expect(b.clientSecret).toBe(a.clientSecret);
  });

  it('is not payable when nothing is due (409) or for an unrelated state', async () => {
    await makeOrder({ code: 'SB4', paid: 2500, grandTotal: 2500 });
    expect((await intent('SB4')).status).toBe(409);
    expect(mintCalls).toHaveLength(0);
  });

  it('requires the receipt token (404 otherwise)', async () => {
    await makeOrder({ code: 'SB5', paid: 1500, grandTotal: 2500 });
    const res = await app.request('/v1/shop/orders/SB5/payment-intent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-store-slug': SLUG } });
    expect(res.status).toBe(404);
  });
});

describe('Stripe balance /pay', () => {
  it('settles the balance, records one Stripe payment for the amount due and keeps the order Paid', async () => {
    const id = await makeOrder({ code: 'SB10', paid: 1500, grandTotal: 2500 });
    const { intentId } = await (await intent('SB10')).json() as { intentId: string };
    settle(intentId);
    const res = await payWith('SB10', intentId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'Paid', payment: 'Settled' });
    const row = await orderRow(id);
    expect(row.state).toBe('Paid');
    const stripe = (await payments(id)).filter((p) => p.method === 'stripe' && p.providerRef === intentId);
    expect(stripe.map((p) => p.amount)).toEqual([1000]);
    const audit = await withStore(STORE, (tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.action, 'balance_payment')));
    expect(audit).toHaveLength(1);
  });

  it('replaying /pay for the same PaymentIntent never double-settles', async () => {
    const id = await makeOrder({ code: 'SB11', paid: 1500, grandTotal: 2500 });
    const { intentId } = await (await intent('SB11')).json() as { intentId: string };
    settle(intentId);
    await payWith('SB11', intentId);
    const again = await payWith('SB11', intentId);
    // Nothing is due any more: the replay is refused, not charged or recorded.
    expect([400, 409]).toContain(again.status);
    expect((await payments(id)).filter((p) => p.providerRef === intentId)).toHaveLength(1);
  });

  it('rejects a PaymentIntent whose amount is not the amount due', async () => {
    const id = await makeOrder({ code: 'SB12', paid: 1500, grandTotal: 2500 });
    const { intentId } = await (await intent('SB12')).json() as { intentId: string };
    settle(intentId);
    intents.set(intentId, { ...intents.get(intentId)!, amount: 400 });
    const res = await payWith('SB12', intentId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ payment: 'Failed' });
    expect((await payments(id)).filter((p) => p.providerRef === intentId && p.state === 'Settled')).toHaveLength(0);
    expect(((await orderRow(id)).state)).toBe('Paid');
  });

  it('a second balance of the SAME amount after another edit mints a fresh PaymentIntent and settles even with a reused client key', async () => {
    const id = await makeOrder({ code: 'SB13', paid: 1500, grandTotal: 2500 });
    const first = await (await intent('SB13')).json() as { intentId: string };
    settle(first.intentId);
    expect((await payWith('SB13', first.intentId, { 'idempotency-key': 'order-page-key' })).status).toBe(200);
    // A second edit raises the total by the same 1000 again.
    await raiseTotal(id, 3500);
    const second = await (await intent('SB13')).json() as { intentId: string };
    expect(second.intentId).not.toBe(first.intentId);
    expect(mintCalls.map((c) => c.idempotencyKey)).toEqual([`pi:${id}:1000:bal1`, `pi:${id}:1000:bal2`]);
    settle(second.intentId);
    const res = await payWith('SB13', second.intentId, { 'idempotency-key': 'order-page-key' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'Paid', payment: 'Settled' });
    const settled = (await payments(id)).filter((p) => p.state === 'Settled');
    expect(settled.reduce((n, p) => n + p.amount, 0)).toBe(3500);
    expect((await orderRow(id)).state).toBe('Paid');
  });
});

describe('Stripe balance webhook reconcile', () => {
  const apply = (id: string) => withStore(STORE, (tx) => applyStripeIntent(tx, STORE, intents.get(id) as unknown as Parameters<typeof applyStripeIntent>[2], 'test'));

  it('webhook after /pay is already_settled (no second payment row)', async () => {
    const id = await makeOrder({ code: 'SB20', paid: 1500, grandTotal: 2500 });
    const { intentId } = await (await intent('SB20')).json() as { intentId: string };
    settle(intentId);
    await payWith('SB20', intentId);
    expect((await apply(intentId)).outcome).toBe('already_settled');
    expect((await payments(id)).filter((p) => p.providerRef === intentId)).toHaveLength(1);
  });

  it('webhook first settles the balance exactly once; a later /pay does not add a payment', async () => {
    const id = await makeOrder({ code: 'SB21', paid: 1500, grandTotal: 2500 });
    const { intentId } = await (await intent('SB21')).json() as { intentId: string };
    settle(intentId);
    expect((await apply(intentId)).outcome).toBe('settled');
    expect((await orderRow(id)).state).toBe('Paid');
    expect((await apply(intentId)).outcome).toBe('already_settled');
    const late = await payWith('SB21', intentId);
    expect([200, 400, 409]).toContain(late.status);
    expect((await payments(id)).filter((p) => p.providerRef === intentId)).toHaveLength(1);
    expect((await payments(id)).filter((p) => p.state === 'Settled').reduce((n, p) => n + p.amount, 0)).toBe(2500);
  });
});
