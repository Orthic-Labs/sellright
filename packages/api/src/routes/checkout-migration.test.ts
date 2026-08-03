/**
 * DB tests for the Stripe checkout-migration backend (plan 2026-06-20):
 *   - POST /v1/shop/orders/{code}/payment-intent returns a clientSecret AND is
 *     idempotent (same Stripe idempotencyKey, keyed on the order id, on retry).
 *     The Stripe client is MOCKED so no network call fires.
 *   - GET /v1/shop/orders/{code}?rt=<token> grants the receipt read on a token
 *     match, denies a wrong/absent token, and grants the authed owner.
 *
 * Runs against sellright_test ONLY (these wipe data). Mirrors
 * subscriptions.test.ts: _test-DB guard + TRUNCATE store CASCADE wipe + seeds
 * under withStore(). vitest runs files serially (fileParallelism: false).
 *
 * The real-card UI confirm (3DS in a browser) is the irreducible HUMAN gate and
 * is NOT covered here.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Stripe surface used by the payment-intent route. createPaymentIntent
// records its idempotencyKey so we can assert idempotent reuse; the route gates
// on stripeUsable + isPaymentMethodEnabled, both forced true here.
const piCalls: Array<{ orderCode: string; idempotencyKey?: string }> = [];
vi.mock('../payments/stripe.js', async (orig) => {
  const actual = await orig<typeof import('../payments/stripe.js')>();
  return {
    ...actual,
    stripeUsable: () => true,
    stripeModeFromConfig: () => 'test' as const,
    createPaymentIntent: vi.fn(async (opts: { orderCode: string; idempotencyKey?: string }) => {
      piCalls.push({ orderCode: opts.orderCode, idempotencyKey: opts.idempotencyKey });
      // Stripe returns the SAME client_secret for a repeated idempotencyKey.
      const secret = `pi_${opts.idempotencyKey ?? opts.orderCode}_secret_test`;
      return { clientSecret: secret, intentId: `pi_${opts.idempotencyKey ?? opts.orderCode}` };
    }),
  };
});
vi.mock('../payments/provider.js', async (orig) => {
  const actual = await orig<typeof import('../payments/provider.js')>();
  return { ...actual, isPaymentMethodEnabled: () => true };
});

import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { createSession } from '../auth/session.js';
import { pay } from './pay.js';
import { orders } from './orders.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`checkout-migration test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const SLUG = 'ckmig-test-store';
const CUSTOMER = 'eeeeeeee-eeee-eeee-eeee-00000000000c';
const OTHER_CUSTOMER = 'eeeeeeee-eeee-eeee-eeee-00000000000d';

const app = new OpenAPIHono();
app.route('/', pay);
app.route('/', orders);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

/** Seed store (+ stripe enabled config) and two customers. Returns sessions. */
async function seed(): Promise<{ token: string; otherToken: string }> {
  let token = '';
  let otherToken = '';
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', ${JSON.stringify({ payments: { stripe: true }, stripe: { mode: 'test' } })}::jsonb) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (${CUSTOMER}, ${STORE}, 'buyer@ckmig.test') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (${OTHER_CUSTOMER}, ${STORE}, 'other@ckmig.test') ON CONFLICT (id) DO NOTHING`);
    token = await createSession(tx, STORE, CUSTOMER);
    otherToken = await createSession(tx, STORE, OTHER_CUSTOMER);
  });
  return { token, otherToken };
}

/** Insert a PendingPayment order; returns {code, receiptToken}. */
async function makeOrder(opts: { customerId?: string | null; grandTotal?: number } = {}): Promise<{ code: string; receiptToken: string }> {
  const code = 'SR' + Math.random().toString(16).slice(2, 12).toUpperCase();
  const receiptToken = `rt_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  await withStore(STORE, async (tx) => {
    await tx.insert(s.order).values({
      storeId: STORE, code, customerId: opts.customerId ?? null, state: 'PendingPayment',
      currency: 'USD', grandTotal: opts.grandTotal ?? 2100, receiptToken,
    });
  });
  return { code, receiptToken };
}

let token = '';
let otherToken = '';
beforeEach(async () => { await wipe(); piCalls.length = 0; vi.clearAllMocks(); const r = await seed(); token = r.token; otherToken = r.otherToken; });
afterAll(async () => { await wipe(); });

const hdr = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-store-slug': SLUG, ...extra });

describe('POST /v1/shop/orders/{code}/payment-intent', () => {
  it('returns a clientSecret for a PendingPayment order', async () => {
    const { code } = await makeOrder();
    const res = await app.request(`/v1/shop/orders/${code}/payment-intent`, { method: 'POST', headers: hdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as { clientSecret: string; intentId: string };
    expect(body.clientSecret).toMatch(/_secret_test$/);
    expect(body.intentId).toMatch(/^pi_/);
  });

  // MONEY-3: the key is (order id, amountDue), not order id alone. Keying on the
  // order alone meant a retry after the amount changed — a gift card applied
  // between attempts — silently reused the PaymentIntent minted for the OLD
  // amount. Same order at the same amountDue still dedupes, which is what
  // idempotency has to guarantee.
  it('is idempotent — a retry at the same amountDue passes the SAME idempotencyKey → same client_secret', async () => {
    const { code } = await makeOrder();
    const orderId = await withStore(STORE, async (tx) => {
      const [o] = await tx.select({ id: s.order.id, grandTotal: s.order.grandTotal }).from(s.order).where(eq(s.order.code, code)).limit(1);
      return o!.id;
    });
    const first = await (await app.request(`/v1/shop/orders/${code}/payment-intent`, { method: 'POST', headers: hdr() })).json() as { clientSecret: string };
    const second = await (await app.request(`/v1/shop/orders/${code}/payment-intent`, { method: 'POST', headers: hdr() })).json() as { clientSecret: string };
    expect(second.clientSecret).toBe(first.clientSecret);
    expect(piCalls).toHaveLength(2);
    expect(piCalls[0]!.idempotencyKey).toBe(piCalls[1]!.idempotencyKey);
    expect(piCalls[0]!.idempotencyKey).toMatch(new RegExp(`^pi:${orderId}:\\d+$`));
  });

  it('404 for an unknown order code', async () => {
    const res = await app.request(`/v1/shop/orders/SRDOESNOTEX/payment-intent`, { method: 'POST', headers: hdr() });
    expect(res.status).toBe(404);
  });

  it('409 when the order is not PendingPayment', async () => {
    const { code } = await makeOrder();
    await withStore(STORE, async (tx) => { await tx.update(s.order).set({ state: 'Paid' }).where(eq(s.order.code, code)); });
    const res = await app.request(`/v1/shop/orders/${code}/payment-intent`, { method: 'POST', headers: hdr() });
    expect(res.status).toBe(409);
  });
});

describe('GET /v1/shop/orders/{code} — receipt-token / owner scoping (P1)', () => {
  it('grants the read with a matching receipt token', async () => {
    const { code, receiptToken } = await makeOrder();
    const res = await app.request(`/v1/shop/orders/${code}?rt=${encodeURIComponent(receiptToken)}`, { headers: hdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as { code: string };
    expect(body.code).toBe(code);
  });

  it('denies (404) a bare code with no token and no auth', async () => {
    const { code } = await makeOrder();
    const res = await app.request(`/v1/shop/orders/${code}`, { headers: hdr() });
    expect(res.status).toBe(404);
  });

  it('denies (404) a wrong token', async () => {
    const { code } = await makeOrder();
    const res = await app.request(`/v1/shop/orders/${code}?rt=wrong-token`, { headers: hdr() });
    expect(res.status).toBe(404);
  });

  it('grants the read to the authed owner without a token', async () => {
    const { code } = await makeOrder({ customerId: CUSTOMER });
    const res = await app.request(`/v1/shop/orders/${code}`, { headers: hdr({ authorization: `Bearer ${token}` }) });
    expect(res.status).toBe(200);
  });

  it('denies (404) a different authed customer (not the owner) with no token', async () => {
    const { code } = await makeOrder({ customerId: CUSTOMER });
    const res = await app.request(`/v1/shop/orders/${code}`, { headers: hdr({ authorization: `Bearer ${otherToken}` }) });
    expect(res.status).toBe(404);
  });
});
