/**
 * DB tests for subscriptions (vs sellright_test ONLY — these wipe data).
 *
 * Two layers:
 *  - the /v1/shop/subscribe ROUTE (drives the real Hono handler through
 *    app.request with a seeded customer session) — the Stripe client is MOCKED
 *    so no network call fires; we assert the backing order + checkout metadata.
 *  - the LIFECYCLE module (onCheckoutCompleted / onInvoicePaid / onInvoiceFailed)
 *    driven directly under withStore with synthesized Stripe event objects — this
 *    is the issue-then-extend heart and needs no signature crypto.
 *
 * Covers (plan Task 9):
 *   1. subscribe → PendingPayment order + checkout args with metadata
 *   2. checkout.session.completed → subscription row incomplete
 *   3. invoice.paid (subscription_create) → order Paid + license issued +
 *      subscription.licenseId set + active
 *   4. SECOND invoice.paid (subscription_cycle) → SAME license, dates advanced
 *   5. invoice.paid with NO prior subscription row → create-or-find creates + issues
 *   6. invoice.payment_failed → past_due
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Stripe client surface used by the /subscribe route. The lifecycle
// module does NOT call Stripe, so it is unmocked.
vi.mock('../payments/stripe.js', async (orig) => {
  const actual = await orig<typeof import('../payments/stripe.js')>();
  return {
    ...actual,
    stripeUsable: () => true,
    stripeModeFromConfig: () => 'test' as const,
    createSubscriptionCheckout: vi.fn(async (_mode: unknown, args: { metadata: Record<string, string> }) => ({
      url: `https://checkout.stripe.test/c/${args.metadata.orderCode}`,
      sessionId: 'cs_test_123',
    })),
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
import { subscriptions } from './subscriptions.js';
import { createSubscriptionCheckout } from '../payments/stripe.js';
import {
  onCheckoutCompleted, onInvoicePaid, onInvoiceFailed,
  type CheckoutSessionLike, type InvoiceLike,
} from '../payments/subscriptions.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`subscriptions test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SLUG = 'subs-test-store';
const CUSTOMER = 'dddddddd-dddd-dddd-dddd-00000000000c';
const VARIANT = 'dddddddd-dddd-dddd-dddd-00000000000b';
const PRICE = 4900; // cents — the recurring plan price
const STRIPE_PRICE_ID = 'price_test_monthly';
const STRIPE_SUB_ID = 'sub_test_abc';

const app = new OpenAPIHono();
app.route('/', subscriptions);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

async function seed(): Promise<string> {
  let token = '';
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', ${JSON.stringify({ payments: { stripe: true }, stripe: { mode: 'test' } })}::jsonb) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (${CUSTOMER}, ${STORE}, 'subscriber@subs.test') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'plan', 'Plan', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    // a recurring variant: stripe_price_id set + 30-day license/updates durations
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type, app_key, license_duration_days, updates_duration_days, stripe_price_id, billing_interval)
      VALUES (${VARIANT}, ${STORE}, ${pid}, 'PLAN-M', 'Monthly Plan', ${PRICE}, 'license', 'testapp', 30, 30, ${STRIPE_PRICE_ID}, 'month')
      ON CONFLICT (id) DO NOTHING`);
    token = await createSession(tx, STORE, CUSTOMER);
  });
  return token;
}

// Synthesize the Stripe event objects the lifecycle functions read.
const checkoutSession = (orderCode: string): CheckoutSessionLike => ({
  subscription: STRIPE_SUB_ID,
  customer: 'cus_test_1',
  metadata: { storeId: STORE, orderCode, customerId: CUSTOMER },
});
const invoice = (opts: { reason: string; orderCode?: string; periodEndSec: number; amount?: number }): InvoiceLike => ({
  id: `in_${opts.reason}_${opts.periodEndSec}`,
  subscription: STRIPE_SUB_ID,
  customer: 'cus_test_1',
  payment_intent: `pi_${opts.periodEndSec}`,
  billing_reason: opts.reason,
  amount_paid: opts.amount ?? PRICE,
  subscription_details: { metadata: { storeId: STORE, orderCode: opts.orderCode, customerId: CUSTOMER } },
  lines: { data: [{ price: { id: STRIPE_PRICE_ID }, period: { end: opts.periodEndSec } }] },
});

const subRow = () => withStore(STORE, async (tx) => {
  const [r] = await tx.select().from(s.subscription).where(eq(s.subscription.stripeSubscriptionId, STRIPE_SUB_ID)).limit(1);
  return r ?? null;
});
const orderByCode = (code: string) => withStore(STORE, async (tx) => {
  const [r] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
  return r ?? null;
});
const licenseById = (id: string) => withStore(STORE, async (tx) => {
  const [r] = await tx.select().from(s.license).where(eq(s.license.id, id)).limit(1);
  return r ?? null;
});

let token = '';
beforeEach(async () => { await wipe(); token = await seed(); vi.clearAllMocks(); });
afterAll(async () => { await wipe(); });

const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-store-slug': SLUG });

describe('POST /v1/shop/subscribe', () => {
  it('creates a PendingPayment order and returns a checkout URL with metadata', async () => {
    const res = await app.request('/v1/shop/subscribe', {
      method: 'POST', headers: auth(), body: JSON.stringify({ variantId: VARIANT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { url: string };
    expect(body.url).toContain('checkout.stripe.test');

    // a PendingPayment order with one line for the variant exists
    const order = await withStore(STORE, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.customerId, CUSTOMER)).limit(1);
      return o;
    });
    expect(order).toBeDefined();
    expect(order!.state).toBe('PendingPayment');
    expect(order!.grandTotal).toBe(PRICE);

    // checkout was called with {storeId, orderCode, customerId} metadata + priceId
    const call = (createSubscriptionCheckout as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const args = call[1] as { priceId: string; metadata: Record<string, string> };
    expect(args.priceId).toBe(STRIPE_PRICE_ID);
    expect(args.metadata).toMatchObject({ storeId: STORE, orderCode: order!.code, customerId: CUSTOMER });
  });

  it('rejects a non-recurring variant with 400', async () => {
    // a variant with no stripe_price_id
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`UPDATE product_variant SET stripe_price_id = NULL WHERE id = ${VARIANT}`);
    });
    const res = await app.request('/v1/shop/subscribe', {
      method: 'POST', headers: auth(), body: JSON.stringify({ variantId: VARIANT }),
    });
    expect(res.status).toBe(400);
  });

  it('requires auth (401 without a session)', async () => {
    const res = await app.request('/v1/shop/subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-store-slug': SLUG }, body: JSON.stringify({ variantId: VARIANT }),
    });
    expect(res.status).toBe(401);
  });
});

describe('subscription lifecycle', () => {
  // Helper: run subscribe to create the backing order, return its code.
  async function subscribe(): Promise<string> {
    const res = await app.request('/v1/shop/subscribe', { method: 'POST', headers: auth(), body: JSON.stringify({ variantId: VARIANT }) });
    expect(res.status).toBe(200);
    const order = await withStore(STORE, async (tx) => {
      const [o] = await tx.select({ code: s.order.code }).from(s.order).where(eq(s.order.customerId, CUSTOMER)).limit(1);
      return o!.code;
    });
    return order;
  }

  it('checkout.session.completed → subscription row incomplete', async () => {
    const code = await subscribe();
    await withStore(STORE, (tx) => onCheckoutCompleted(tx, STORE, checkoutSession(code)));
    const row = await subRow();
    expect(row).not.toBeNull();
    expect(row!.status).toBe('incomplete');
    expect(row!.orderId).not.toBeNull();
    expect(row!.stripeCustomerId).toBe('cus_test_1');
  });

  it('first invoice.paid → order Paid, license issued, subscription active + linked', async () => {
    const code = await subscribe();
    await withStore(STORE, (tx) => onCheckoutCompleted(tx, STORE, checkoutSession(code)));
    await withStore(STORE, (tx) => onInvoicePaid(tx, STORE, invoice({ reason: 'subscription_create', orderCode: code, periodEndSec: 1_800_000_000 })));

    const order = await orderByCode(code);
    expect(order!.state).toBe('Paid');

    const row = await subRow();
    expect(row!.status).toBe('active');
    expect(row!.licenseId).not.toBeNull();

    const lic = await licenseById(row!.licenseId!);
    expect(lic).not.toBeNull();
    expect(lic!.expiresAt).not.toBeNull();    // 30-day license duration
    expect(lic!.updatesUntil).not.toBeNull();
  });

  it('second invoice.paid (cycle) advances the SAME license, no new license', async () => {
    const code = await subscribe();
    await withStore(STORE, (tx) => onCheckoutCompleted(tx, STORE, checkoutSession(code)));
    await withStore(STORE, (tx) => onInvoicePaid(tx, STORE, invoice({ reason: 'subscription_create', orderCode: code, periodEndSec: 1_800_000_000 })));
    const after1 = await subRow();
    const lic1 = await licenseById(after1!.licenseId!);

    await withStore(STORE, (tx) => onInvoicePaid(tx, STORE, invoice({ reason: 'subscription_cycle', orderCode: code, periodEndSec: 1_810_000_000 })));

    // exactly one license for the order (no second issue)
    const licCount = await withStore(STORE, async (tx) => {
      const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.license).where(eq(s.license.orderId, after1!.orderId!));
      return r!.n;
    });
    expect(licCount).toBe(1);

    const lic2 = await licenseById(after1!.licenseId!);
    expect(lic2!.id).toBe(lic1!.id);
    // dates advanced by 30 days
    expect(lic2!.expiresAt!.getTime()).toBeGreaterThan(lic1!.expiresAt!.getTime());
    expect(lic2!.updatesUntil!.getTime()).toBeGreaterThan(lic1!.updatesUntil!.getTime());
  });

  it('invoice.paid with NO prior subscription row → create-or-find creates it + issues', async () => {
    const code = await subscribe();
    // skip checkout.session.completed entirely — invoice arrives first
    await withStore(STORE, (tx) => onInvoicePaid(tx, STORE, invoice({ reason: 'subscription_create', orderCode: code, periodEndSec: 1_800_000_000 })));

    const row = await subRow();
    expect(row).not.toBeNull();          // created from the invoice
    expect(row!.status).toBe('active');
    expect(row!.licenseId).not.toBeNull();

    const order = await orderByCode(code);
    expect(order!.state).toBe('Paid');
  });

  it('invoice.payment_failed → past_due (license untouched)', async () => {
    const code = await subscribe();
    await withStore(STORE, (tx) => onCheckoutCompleted(tx, STORE, checkoutSession(code)));
    await withStore(STORE, (tx) => onInvoicePaid(tx, STORE, invoice({ reason: 'subscription_create', orderCode: code, periodEndSec: 1_800_000_000 })));
    await withStore(STORE, (tx) => onInvoiceFailed(tx, STORE, invoice({ reason: 'subscription_cycle', orderCode: code, periodEndSec: 1_810_000_000 })));

    const row = await subRow();
    expect(row!.status).toBe('past_due');
    expect(row!.licenseId).not.toBeNull(); // license still linked, not revoked
  });
});
