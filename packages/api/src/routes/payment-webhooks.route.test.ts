/**
 * TEST-1: DB integration tests for POST /v1/webhooks/stripe — the inbound
 * Stripe webhook that settles payments outside the client-driven /pay call.
 * Mirrors e2e-checkout-stripe.test.ts's signing technique
 * (`Stripe.webhooks.generateTestHeaderString` is pure crypto — no network
 * call, no real Stripe API key needed) but does NOT require real Stripe test
 * keys: stripeConfigured/stripeCreds/stripeModeFromConfig are MOCKED so the
 * suite runs unconditionally (unlike the skip-when-no-keys e2e test).
 *
 * Runs against sellright_test ONLY (these wipe data). vitest runs files
 * serially (fileParallelism: false).
 *
 * Covers:
 *   1. a validly-signed test-mode payment_intent.succeeded event settles the
 *      order idempotently — replaying the SAME event id is a no-op (no second
 *      payment row, ra: processed_event dedup)
 *   2. a webhook signed with the TEST secret cannot settle a LIVE-mode store
 *      (mode-bind guard) — order stays PendingPayment, no payment row
 *   3. an unknown/garbage signature is rejected with 400 and never reaches
 *      the DB (order untouched)
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';

const TEST_WEBHOOK_SECRET = 'whsec_test_dummy_secret_for_signing_only';
const LIVE_WEBHOOK_SECRET = 'whsec_live_dummy_secret_for_signing_only';

// Mock the Stripe surface so the route's stripeConfigured/stripeCreds/
// stripeModeFromConfig gates pass without real API keys. verifyStripeWebhook
// is left REAL (it's pure crypto — Stripe.webhooks.constructEvent) so the
// actual signature-verification code path runs exactly as in production.
vi.mock('../payments/stripe.js', async (orig) => {
  const actual = await orig<typeof import('../payments/stripe.js')>();
  return {
    ...actual,
    stripeConfigured: (mode: 'test' | 'live') => mode === 'test' || mode === 'live',
    stripeCreds: (mode: 'test' | 'live') => ({
      secretKey: mode === 'test' ? 'sk_test_dummy' : 'sk_live_dummy',
      webhookSecret: mode === 'test' ? TEST_WEBHOOK_SECRET : LIVE_WEBHOOK_SECRET,
      publishableKey: mode === 'test' ? 'pk_test_dummy' : 'pk_live_dummy',
    }),
  };
});

const { paymentWebhooks } = await import('./payment-webhooks.js');

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`payment-webhooks.route test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'aaaaaaaa-3333-3333-3333-333333333333';
const SLUG = 'webhook-route-test-store';

const { OpenAPIHono } = await import('@hono/zod-openapi');
const app = new OpenAPIHono();
app.route('/', paymentWebhooks);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

/** Seed a store in the given Stripe mode with one PendingPayment order. */
async function seed(mode: 'test' | 'live'): Promise<{ orderId: string; code: string }> {
  const code = 'SR' + Math.random().toString(16).slice(2, 12).toUpperCase();
  const orderId = await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', ${JSON.stringify({ payments: { stripe: true }, stripe: { mode } })}::jsonb) ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`);
    const [o] = await tx.insert(s.order).values({
      storeId: STORE, code, state: 'PendingPayment', currency: 'USD', grandTotal: 2500,
    }).returning({ id: s.order.id });
    return o!.id;
  });
  return { orderId, code };
}

/** Sign a payload with Stripe's own test helper — pure crypto, no API call,
 *  so it exercises the real constructEvent verification path. */
function sign(payload: string, secret: string): string {
  return new Stripe('sk_test_dummy_signing_only').webhooks.generateTestHeaderString({ payload, secret });
}

function piSucceededEvent(opts: { id: string; orderCode: string; storeId?: string; amount?: number; currency?: string }) {
  return {
    id: opts.id,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: `pi_${opts.orderCode}`,
        object: 'payment_intent',
        amount: opts.amount ?? 2500,
        currency: opts.currency ?? 'usd',
        status: 'succeeded',
        metadata: { orderCode: opts.orderCode, ...(opts.storeId ? { storeId: opts.storeId } : {}) },
      },
    },
  } as const;
}

const hdr = (sig: string) => ({ 'content-type': 'application/json', 'x-store-slug': SLUG, 'stripe-signature': sig });

beforeEach(async () => { await wipe(); });
afterAll(async () => { await wipe(); await pool.end(); });

describe('POST /v1/webhooks/stripe — settle + idempotency', () => {
  it('a validly-signed test-mode event settles the order; replaying the SAME event id is a no-op', async () => {
    const { code } = await seed('test');
    const payload = JSON.stringify(piSucceededEvent({ id: `evt_settle_${code}`, orderCode: code, storeId: STORE }));
    const sig = sign(payload, TEST_WEBHOOK_SECRET);

    const first = await app.request('/v1/webhooks/stripe', { method: 'POST', headers: hdr(sig), body: payload });
    expect(first.status).toBe(200);

    const order1 = await withStore(STORE, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      return o;
    });
    expect(order1!.state).toBe('Paid');

    const payments1 = await withStore(STORE, async (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, order1!.id)));
    expect(payments1).toHaveLength(1);

    // Replay the IDENTICAL event (same id + payload + signature) — the
    // processed_event dedup must make this a pure no-op: still 200, still
    // exactly one payment row, order still Paid.
    const second = await app.request('/v1/webhooks/stripe', { method: 'POST', headers: hdr(sig), body: payload });
    expect(second.status).toBe(200);

    const payments2 = await withStore(STORE, async (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, order1!.id)));
    expect(payments2).toHaveLength(1);

    const order2 = await withStore(STORE, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      return o;
    });
    expect(order2!.state).toBe('Paid');
  });
});

describe('POST /v1/webhooks/stripe — MONEY-3: verifies against amountDue, not raw grandTotal', () => {
  it('settles the order when the intent amount matches grandTotal minus a prior Settled gift-card tender', async () => {
    const { code, orderId } = await seed('test');
    // grandTotal is 2500 (seed()); a partial gift-card draw-down already
    // covered 1000 of it at checkout, same as checkout.ts's gift_card tender.
    await withStore(STORE, (tx) => tx.insert(s.payment).values({ storeId: STORE, orderId, amount: 1000, method: 'gift_card', state: 'Settled' }));

    // The gateway (Stripe) was only ever asked to capture the REMAINING 1500 —
    // that's what /payment-intent would have minted for. The webhook's
    // verification must accept THAT amount, not reject it for not matching the
    // raw 2500 grandTotal.
    const payload = JSON.stringify(piSucceededEvent({ id: `evt_partial_${code}`, orderCode: code, storeId: STORE, amount: 1500 }));
    const sig = sign(payload, TEST_WEBHOOK_SECRET);
    const res = await app.request('/v1/webhooks/stripe', { method: 'POST', headers: hdr(sig), body: payload });
    expect(res.status).toBe(200);

    const order = await withStore(STORE, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.id, orderId)).limit(1);
      return o;
    });
    expect(order!.state).toBe('Paid');

    const payments = await withStore(STORE, (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, orderId)));
    const stripeRow = payments.find((p) => p.method === 'stripe');
    // The bug this guards against: recording/expecting 2500 (grandTotal) here
    // instead of the 1500 actually captured.
    expect(stripeRow!.amount).toBe(1500);
    const settledTotal = payments.filter((p) => p.state === 'Settled').reduce((a, p) => a + p.amount, 0);
    expect(settledTotal).toBe(2500);
  });
});

describe('POST /v1/webhooks/stripe — MONEY-4: settlement after auto-cancel is recorded + audited, never dropped', () => {
  it('a payment_intent.succeeded event for a Cancelled order still records the payment row and an audit_log flag', async () => {
    const { code, orderId } = await seed('test');
    // Simulate jobs/release-stale-allocations.ts auto-cancelling the order
    // purely on age, WHILE a real Stripe capture was already in flight.
    await withStore(STORE, (tx) => tx.update(s.order).set({ state: 'Cancelled' }).where(eq(s.order.id, orderId)));

    const payload = JSON.stringify(piSucceededEvent({ id: `evt_after_cancel_${code}`, orderCode: code, storeId: STORE }));
    const sig = sign(payload, TEST_WEBHOOK_SECRET);
    const res = await app.request('/v1/webhooks/stripe', { method: 'POST', headers: hdr(sig), body: payload });
    expect(res.status).toBe(200); // ack — Stripe must not retry a valid, processed event

    const order = await withStore(STORE, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.id, orderId)).limit(1);
      return o;
    });
    // Never silently auto-un-cancel — that is a separate product decision.
    expect(order!.state).toBe('Cancelled');

    // The money must NEVER go invisible: the payment row is recorded even
    // though the order stayed Cancelled.
    const payments = await withStore(STORE, (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, orderId)));
    expect(payments).toHaveLength(1);
    expect(payments[0]!.state).toBe('Settled');
    expect(payments[0]!.amount).toBe(2500);

    const audits = await withStore(STORE, (tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.entityId, orderId)));
    const flag = audits.find((a) => a.action === 'payment_after_cancel');
    expect(flag).toBeDefined();
    expect((flag!.data as { needsReconciliation?: boolean })?.needsReconciliation).toBe(true);
  });
});

describe('POST /v1/webhooks/stripe — mode-bind guard', () => {
  it('a webhook signed with the TEST secret cannot settle a LIVE-mode store', async () => {
    const { code, orderId } = await seed('live');
    const payload = JSON.stringify(piSucceededEvent({ id: `evt_modebind_${code}`, orderCode: code, storeId: STORE }));
    // Signed with the TEST secret — verifies fine (constructEvent only checks
    // the signature matches SOME secret we tried), but the handler's mode-bind
    // check compares the verifying secret's mode ('test') against the store's
    // configured mode ('live') and must refuse to settle.
    const sig = sign(payload, TEST_WEBHOOK_SECRET);

    const res = await app.request('/v1/webhooks/stripe', { method: 'POST', headers: hdr(sig), body: payload });
    expect(res.status).toBe(200); // acked (Stripe must not retry a signature that verified)

    const order = await withStore(STORE, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.id, orderId)).limit(1);
      return o;
    });
    expect(order!.state).toBe('PendingPayment'); // NOT settled

    const payments = await withStore(STORE, async (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, orderId)));
    expect(payments).toHaveLength(0);
  });
});

describe('POST /v1/webhooks/stripe — signature rejection', () => {
  it('an unknown/garbage signature is rejected with 400 and never reaches the DB', async () => {
    const { code, orderId } = await seed('test');
    const payload = JSON.stringify(piSucceededEvent({ id: `evt_garbage_${code}`, orderCode: code, storeId: STORE }));

    const res = await app.request('/v1/webhooks/stripe', {
      method: 'POST',
      headers: hdr('t=1700000000,v1=not_a_real_signature_at_all'),
      body: payload,
    });
    expect(res.status).toBe(400);

    const order = await withStore(STORE, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.id, orderId)).limit(1);
      return o;
    });
    expect(order!.state).toBe('PendingPayment');

    const payments = await withStore(STORE, async (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, orderId)));
    expect(payments).toHaveLength(0);
  });

  it('a missing stripe-signature header is rejected with 400', async () => {
    const payload = JSON.stringify(piSucceededEvent({ id: 'evt_nosig', orderCode: 'SRNOPE', storeId: STORE }));
    const res = await app.request('/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-store-slug': SLUG },
      body: payload,
    });
    expect(res.status).toBe(400);
  });
});
