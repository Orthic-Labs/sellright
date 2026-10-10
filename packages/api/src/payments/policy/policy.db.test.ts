/**
 * Payment policy veto and pre-mint attempt rows (PAYMENT-TIMING §3.6, §4.1, §4.2, decision X-9), DB.
 * Covers the NMI and Sezzle start path (startGatewayPayment) and the Stripe mint route (/payment-intent).
 * Providers and Stripe are mocked at the boundary; every row and call count is checked after each request.
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const nmiCalls: string[] = [];
vi.mock('../gateway-account.js', async (original) => {
  const account = (method: string) => ({
    storeId: 'e3000000-0000-0000-0000-0000000e3001', accountId: `${method}-acct`, method, mode: 'test',
    ...(method === 'nmi' ? { nmiEnvironment: 'sandbox', securityKey: 'fixture' } : { publicKey: 'pub', privateKey: 'priv' }),
  });
  return {
    ...await original<typeof import('../gateway-account.js')>(),
    resolveConfiguredGatewayAccount: async (_s: string, m: string) => account(m),
    resolveGatewayAccount: async (_s: string, m: string) => account(m),
  };
});
vi.mock('../../manifest/stock-hook.js', () => ({ onStockChanged: vi.fn() }));

const intents = new Map<string, Record<string, unknown>>();
const mintCalls: string[] = [];
let failNextMint = false;
vi.mock('../stripe.js', async (orig) => {
  const actual = await orig<typeof import('../stripe.js')>();
  return {
    ...actual,
    resolveStripeUsable: async () => true,
    stripeModeFromConfig: () => 'test' as const,
    createPaymentIntent: vi.fn(async (o: { orderCode: string; amount: number; currency: string; idempotencyKey?: string }) => {
      if (failNextMint) { failNextMint = false; throw new Error('stripe unreachable'); }
      const intentId = `pi_${o.idempotencyKey}`;
      if (!intents.has(intentId)) intents.set(intentId, { id: intentId, amount: o.amount, status: 'requires_payment_method' });
      mintCalls.push(intentId);
      return { clientSecret: `${intentId}_secret`, intentId };
    }),
  };
});
vi.mock('../provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../provider.js')>();
  const nmiMock = {
    method: 'nmi', requiresRedirect: false,
    async createPayment(input: { orderCode: string }) {
      nmiCalls.push(input.orderCode);
      return { state: 'Settled' as const, providerRef: `nmi_tx_${nmiCalls.length}`, metadata: {} };
    },
  };
  // Stripe /pay: the verified intent is taken as settled (the real verify call needs Stripe).
  const stripeMock = {
    method: 'stripe', requiresRedirect: false,
    async createPayment(input: { token?: unknown }) {
      return { state: 'Settled' as const, providerRef: String(input.token), metadata: {} };
    },
  };
  return {
    ...actual,
    isPaymentMethodEnabled: () => true,
    getProvider: (m: string) => (m === 'nmi' ? nmiMock : m === 'stripe' ? stripeMock : actual.getProvider(m)),
  };
});

import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../../db/client.js';
import { env } from '../../env.js';
import * as s from '../../db/schema.js';
import { sezzleProvider } from '../sezzle.js';
import { GatewayPaymentError, startGatewayPayment } from '../gateway-payment.js';
import { bindStripePreMint, openStripePreMint, trackStripeIntent } from '../stripe-reconcile.js';
import { pay } from '../../routes/pay.js';
import { _resetPaymentPoliciesForTests, registerPaymentPolicy } from './host.js';
import { installDefaultPaymentPolicy } from './default-policy.js';
import type { PaymentPolicy, PaymentProvider, PolicyVeto } from './types.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`payment policy test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'e3000000-0000-0000-0000-0000000e3001';
const SLUG = 'paypolicy-test';
const RT = 'rt_payment_policy_receipt_token_abcdefgh';
const CONFIG = { payments: { nmi: true, sezzle: true, stripe: true }, storefrontUrl: 'https://shop.example.test', stripe: { mode: 'test' } };
const app = new OpenAPIHono();
app.route('/', pay);

const sessions: unknown[] = [];
vi.spyOn(sezzleProvider, 'createSession').mockImplementation(async (input) => {
  sessions.push(input);
  return { providerRef: `sz-${sessions.length}`, checkoutUrl: `https://sandbox.checkout.sezzle.com/?id=${sessions.length}` };
});

/** Registers one veto policy for the given providers; everything else is allowed. */
function vetoFor(providers: PaymentProvider[], v: PolicyVeto): PaymentPolicy {
  return {
    id: 'test-veto',
    async beforePaymentAttempt(_tx, i) {
      return providers.includes(i.provider) ? { allow: false, veto: v } : { allow: true };
    },
  };
}
const VETO: PolicyVeto = { code: 'RIGHTS_TEST_VETO', message: 'Credit no longer valid', extra: { state: 'MobileCreditInvalid' } };

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }
beforeEach(async () => {
  nmiCalls.length = 0; sessions.length = 0; mintCalls.length = 0; intents.clear(); failNextMint = false;
  _resetPaymentPoliciesForTests();
  installDefaultPaymentPolicy();
  await wipe();
  await withStore(STORE, async (tx) => {
    await tx.insert(s.store).values({ id: STORE, slug: SLUG, name: 'Policy', currency: 'USD', config: CONFIG });
  });
});
afterAll(async () => { _resetPaymentPoliciesForTests(); await wipe(); await pool.end(); });

async function makeOrder(code: string, state: 'PendingPayment' | 'Paid' = 'PendingPayment', paid = 0, grandTotal = 2500) {
  return withStore(STORE, async (tx) => {
    const [ord] = await tx.insert(s.order).values({
      storeId: STORE, code, state, currency: 'USD', receiptToken: RT,
      subtotal: grandTotal, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal,
      shippingAddress: { fullName: 'Ship Er', line1: '1 Main St', city: 'Austin', province: 'TX', postalCode: '78701', country: 'US' },
    }).returning({ id: s.order.id });
    if (paid > 0) {
      await tx.insert(s.payment).values({ storeId: STORE, orderId: ord!.id, amount: paid, method: 'stripe', state: 'Settled', providerRef: `pi_orig_${code}`, gatewayMode: 'test', currency: 'USD' });
    }
    return ord!.id;
  });
}
const attemptsFor = (orderId: string) => withStore(STORE, (tx) => tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.orderId, orderId)));
const start = (code: string, method: 'nmi' | 'sezzle', key: string, token?: string) => startGatewayPayment({
  storeId: STORE, code, method, config: CONFIG, idempotencyKey: key, receiptToken: RT, token,
});
const intentReq = (code: string) => app.request(`/v1/shop/orders/${code}/payment-intent`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-store-slug': SLUG, 'x-receipt-token': RT },
});

describe('NMI start path: beforePaymentAttempt', () => {
  it('veto ⇒ 409 with the policy code, no attempt row, no provider call', async () => {
    const id = await makeOrder('PP1');
    registerPaymentPolicy(vetoFor(['nmi'], VETO));
    const err = await start('PP1', 'nmi', 'k-veto', 'tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayPaymentError);
    expect(err).toMatchObject({ status: 409, code: 'RIGHTS_TEST_VETO', message: VETO.message, extra: { state: 'MobileCreditInvalid' } });
    expect(await attemptsFor(id)).toHaveLength(0);
    expect(nmiCalls).toHaveLength(0);
  });

  it('veto precedes replay: a stored attempt under the same key is refused once the policy turns invalid', async () => {
    const id = await makeOrder('PP2');
    const first = await start('PP2', 'nmi', 'k-replay', 'tok');
    expect(first).toMatchObject({ status: 'settled' });
    expect(nmiCalls).toHaveLength(1);
    _resetPaymentPoliciesForTests();
    registerPaymentPolicy(vetoFor(['nmi'], VETO));
    const err = await start('PP2', 'nmi', 'k-replay', 'tok').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'RIGHTS_TEST_VETO' });
    expect(await attemptsFor(id)).toHaveLength(1);
    expect(nmiCalls).toHaveLength(1);
  });

  it('a failing policy ⇒ 503 PAYMENT_POLICY_UNAVAILABLE, nothing persisted, no provider call', async () => {
    const id = await makeOrder('PP3');
    registerPaymentPolicy({
      id: 'broken',
      async beforePaymentAttempt(tx) {
        await tx.execute(sql`SELECT 1 / 0`);
        return { allow: true };
      },
    });
    const err = await start('PP3', 'nmi', 'k-broken', 'tok').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503, code: 'PAYMENT_POLICY_UNAVAILABLE' });
    expect(await attemptsFor(id)).toHaveLength(0);
    expect(nmiCalls).toHaveLength(0);
  });

  it('allow path is unchanged: the NMI sale settles and one attempt row is written', async () => {
    const id = await makeOrder('PP4');
    const res = await start('PP4', 'nmi', 'k-allow', 'tok');
    expect(res).toMatchObject({ status: 'settled' });
    expect(nmiCalls).toHaveLength(1);
    expect(await attemptsFor(id)).toHaveLength(1);
  });
});

describe('Sezzle start path: beforePaymentAttempt', () => {
  it('veto ⇒ 409, no attempt row, no Sezzle session created', async () => {
    const id = await makeOrder('PP5');
    registerPaymentPolicy(vetoFor(['sezzle'], VETO));
    const err = await start('PP5', 'sezzle', 'k-sz-veto').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'RIGHTS_TEST_VETO' });
    expect(await attemptsFor(id)).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });
});

describe('Stripe mint route: beforePaymentAttempt and pre-mint rows (X-9)', () => {
  it('veto ⇒ 409, no PaymentIntent minted, no attempt row (pre-mint or otherwise)', async () => {
    const id = await makeOrder('PP6');
    registerPaymentPolicy(vetoFor(['stripe'], VETO));
    const res = await intentReq('PP6');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'RIGHTS_TEST_VETO' }, state: 'MobileCreditInvalid' });
    expect(mintCalls).toHaveLength(0);
    expect(await attemptsFor(id)).toHaveLength(0);
  });

  it('allow ⇒ one intent row bound to the PaymentIntent; a replay collapses onto it', async () => {
    const id = await makeOrder('PP7');
    const a = await (await intentReq('PP7')).json() as { intentId: string };
    const b = await (await intentReq('PP7')).json() as { intentId: string };
    expect(b.intentId).toBe(a.intentId);
    const rows = await attemptsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: 'intent', method: 'stripe', providerRef: a.intentId });
    expect(mintCalls).toHaveLength(2);
  });

  it('crash between the pre-mint row and the mint: an open row with no provider ref remains, and the retry binds that same row', async () => {
    const id = await makeOrder('PP8');
    failNextMint = true;
    const crashed = await intentReq('PP8');
    expect(crashed.status).toBe(500);
    const pending = await attemptsFor(id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: 'open', providerRef: null });

    const ok = await (await intentReq('PP8')).json() as { intentId: string };
    const rows = await attemptsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(pending[0]!.id);
    expect(rows[0]!.providerRef).toBe(ok.intentId);
  });
});

describe('pre-mint helpers', () => {
  it('an iteration key collapses onto one row while unbound', async () => {
    const id = await makeOrder('PP9');
    const mode = 'test' as const;
    const first = await withStore(STORE, (tx) => openStripePreMint(tx, STORE, { orderId: id, iterationKey: 'pi:x', amount: 100, currency: 'USD', mode }));
    const again = await withStore(STORE, (tx) => openStripePreMint(tx, STORE, { orderId: id, iterationKey: 'pi:x', amount: 100, currency: 'USD', mode }));
    expect(again.id).toBe(first.id);
    expect(await attemptsFor(id)).toHaveLength(1);
  });

  it('a second pending row for a PI already tracked is superseded, and the existing attempt is returned', async () => {
    const id = await makeOrder('PP10');
    const mode = 'test' as const;
    const k1 = await withStore(STORE, (tx) => openStripePreMint(tx, STORE, { orderId: id, iterationKey: 'pi:a', amount: 100, currency: 'USD', mode }));
    const bound = await withStore(STORE, (tx) => bindStripePreMint(tx, STORE, { pendingAttemptId: k1.id, orderId: id, intentId: 'pi_a', amount: 100, currency: 'USD', mode }));
    expect(bound).toMatchObject({ id: k1.id, providerRef: 'pi_a' });

    const k2 = await withStore(STORE, (tx) => openStripePreMint(tx, STORE, { orderId: id, iterationKey: 'pi:b', amount: 100, currency: 'USD', mode }));
    const existing = await withStore(STORE, (tx) => bindStripePreMint(tx, STORE, { pendingAttemptId: k2.id, orderId: id, intentId: 'pi_a', amount: 100, currency: 'USD', mode }));
    expect(existing.id).toBe(k1.id);
    const superseded = (await attemptsFor(id)).find((r) => r.id === k2.id);
    expect(superseded).toMatchObject({ status: 'cancelled', providerRef: null, result: { superseded_by: k1.id } });
    // The tracking path finds the bound row and never inserts a duplicate for the same PI.
    const tracked = await withStore(STORE, (tx) => trackStripeIntent(tx, STORE, { orderId: id, intentId: 'pi_a', amount: 100, currency: 'USD', mode: 'test' }));
    expect(tracked.id).toBe(k1.id);
    expect(await attemptsFor(id)).toHaveLength(2);
  });
});

describe('POST /pay: shapeSettlementResponse (PAYMENT-TIMING §4.2, T-V4)', () => {
  const payReq = (code: string, token: string) => app.request(`/v1/shop/orders/${code}/pay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-store-slug': SLUG, 'x-receipt-token': RT },
    body: JSON.stringify({ method: 'stripe', token }),
  });
  const orderRow = (id: string) => withStore(STORE, (tx) => tx.select().from(s.order).where(eq(s.order.id, id)).limit(1)).then((r) => r[0]!);
  const settledPayments = (id: string) => withStore(STORE, (tx) => tx.select().from(s.payment)
    .where(sql`${s.payment.orderId} = ${id} AND ${s.payment.state} = 'Settled'`));

  it('money is recorded first; the policy shapes the response to a 409 with the wire code', async () => {
    const id = await makeOrder('PP9');
    registerPaymentPolicy({
      id: 'shaper',
      async beforePaymentAttempt() { return { allow: true }; },
      async shapeSettlementResponse(_tx, i) {
        expect(i.route).toBe('pay');
        expect(i.recordedPaymentId).not.toBeNull();
        return { status: 409, code: 'ORDER_NOT_PAYABLE', extra: { state: 'MobileCreditInvalid' } };
      },
    });
    const res = await payReq('PP9', 'pi_shape_1');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'ORDER_NOT_PAYABLE' }, state: 'MobileCreditInvalid' });
    expect((await orderRow(id)).state).toBe('Paid');
    expect(await settledPayments(id)).toHaveLength(1);
  });

  it('without an override the success body is unchanged', async () => {
    await makeOrder('PP10');
    const res = await payReq('PP10', 'pi_shape_2');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ code: 'PP10', state: 'Paid', payment: 'Settled' });
  });

  it('a failing shaping hook never rolls the recorded money back: the default success body is returned', async () => {
    const id = await makeOrder('PP11');
    registerPaymentPolicy({
      id: 'broken-shaper',
      async beforePaymentAttempt() { return { allow: true }; },
      async shapeSettlementResponse() { throw new Error('shaping failed'); },
    });
    const res = await payReq('PP11', 'pi_shape_3');
    expect(res.status).toBe(200);
    expect((await orderRow(id)).state).toBe('Paid');
    expect(await settledPayments(id)).toHaveLength(1);
  });
});

