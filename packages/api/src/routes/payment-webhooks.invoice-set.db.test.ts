/**
 * invoice.paid for a subscription with a backing order runs under withLockedSet({order}, {mustCommit}) (X-45):
 * the first cycle settles the order Paid and writes its payment row; the webhook waits for a held order row
 * instead of failing at the 5s lock timeout of an ordinary set. Stripe is stubbed at the credential seam;
 * signatures are real. Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';

const TEST_WEBHOOK_SECRET = 'whsec_test_dummy_secret_for_invoice_set_only';

vi.mock('../payments/stripe.js', async (orig) => {
  const actual = await orig<typeof import('../payments/stripe.js')>();
  return {
    ...actual,
    stripeCreds: () => ({ secretKey: 'sk_test_dummy', webhookSecret: TEST_WEBHOOK_SECRET, publishableKey: 'pk_test_dummy' }),
  };
});
vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: vi.fn() }));
// Spy on the real set helper: the first-cycle write must be taken under withLockedSet({order}, {mustCommit}).
const setCalls = vi.hoisted(() => [] as Array<{ storeId: string; subject: unknown; opts: unknown }>);
vi.mock('../db/locks.js', async (orig) => {
  const actual = await orig<typeof import('../db/locks.js')>();
  return {
    ...actual,
    withLockedSet: ((storeId, subject, fn, opts) => {
      setCalls.push({ storeId, subject, opts });
      return actual.withLockedSet(storeId, subject, fn, opts);
    }) as typeof actual.withLockedSet,
  };
});

const { paymentWebhooks } = await import('./payment-webhooks.js');
const { OpenAPIHono } = await import('@hono/zod-openapi');

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`payment-webhooks invoice-set test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'aaaaaaaa-f5f5-f5f5-f5f5-f5f5f5f5f501';
const SLUG = 'f5-invoice-set-store';
const SUB = 'sub_f5_first_cycle';
const app = new OpenAPIHono();
app.route('/', paymentWebhooks);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

async function seed(withOrder: boolean): Promise<{ orderId: string; code: string }> {
  const code = 'F5INV' + Math.random().toString(16).slice(2, 10).toUpperCase();
  const orderId = await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', ${JSON.stringify({ payments: { stripe: true }, stripe: { mode: 'test' } })}::jsonb)`);
    const [o] = await tx.insert(s.order).values({ storeId: STORE, code, state: 'PendingPayment', currency: 'USD', grandTotal: 2500 }).returning({ id: s.order.id });
    await tx.insert(s.subscription).values({
      storeId: STORE, stripeSubscriptionId: SUB, orderId: withOrder ? o!.id : null, status: 'incomplete', stripeCustomerId: 'cus_f5',
    });
    return o!.id;
  });
  return { orderId, code };
}

function firstCycleEvent(id: string) {
  return {
    id, object: 'event', api_version: '2024-06-20', created: Math.floor(Date.now() / 1000), type: 'invoice.paid',
    data: { object: {
      id: 'in_f5_first', object: 'invoice', subscription: SUB, customer: 'cus_f5', payment_intent: 'pi_f5_first',
      amount_paid: 2500, currency: 'usd', billing_reason: 'subscription_create', status: 'paid',
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
      lines: { data: [{ period: { end: Math.floor(Date.now() / 1000) + 30 * 86400 } }] },
    } },
  } as const;
}

function post(eventId: string) {
  const payload = JSON.stringify(firstCycleEvent(eventId));
  const sig = new Stripe('sk_test_dummy_signing_only').webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET });
  return app.request('/v1/webhooks/stripe', {
    method: 'POST', body: payload,
    headers: { 'content-type': 'application/json', 'x-store-slug': SLUG, 'stripe-signature': sig },
  });
}

beforeEach(async () => { await wipe(); });
afterAll(async () => { await wipe(); await pool.end(); });

describe('invoice.paid under the order lock set', () => {
  it('first cycle with a backing order: waits for a held order row, then settles the order Paid with its payment', async () => {
    setCalls.length = 0;
    const { orderId } = await seed(true);
    let holderStarted: () => void = () => undefined;
    const started = new Promise<void>((r) => { holderStarted = r; });
    let holderDone = false;
    const holder = withStore(STORE, async (tx) => {
      await tx.select({ id: s.order.id }).from(s.order).where(eq(s.order.id, orderId)).for('update');
      holderStarted();
      await sleep(21_000);
    }).then(() => { holderDone = true; });
    await started;

    const res = await post('evt_f5_first_cycle');
    await holder;

    expect(holderDone).toBe(true);
    expect(res.status).toBe(200);
    expect(setCalls).toContainEqual({ storeId: STORE, subject: [{ kind: 'order', orderId }], opts: { mustCommit: true } });
    const [ord] = await withStore(STORE, (tx) => tx.select({ state: s.order.state }).from(s.order).where(eq(s.order.id, orderId)));
    expect(ord!.state).toBe('Paid');
    const pays = await withStore(STORE, (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, orderId)));
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ state: 'Settled', providerRef: 'pi_f5_first' });
    const [sub] = await withStore(STORE, (tx) => tx.select({ status: s.subscription.status }).from(s.subscription).where(eq(s.subscription.stripeSubscriptionId, SUB)));
    expect(sub!.status).toBe('active');
  }, 60_000);

  it('an orderless subscription keeps the plain path: the invoice is recorded without touching any order', async () => {
    setCalls.length = 0;
    const { orderId } = await seed(false);
    const res = await post('evt_f5_orderless');
    expect(res.status).toBe(200);
    expect(setCalls).toEqual([]);
    const [ord] = await withStore(STORE, (tx) => tx.select({ state: s.order.state }).from(s.order).where(eq(s.order.id, orderId)));
    expect(ord!.state).toBe('PendingPayment');
  });
});
