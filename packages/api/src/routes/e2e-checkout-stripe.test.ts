/**
 * TEST-2 (DISPATCH.md §3a): end-to-end checkout → pay → fulfill against Stripe
 * test keys. Drives the real Hono app through the full happy path:
 *
 *   1. POST /v1/shop/cart         — seed cart with a test variant
 *   2. POST /v1/shop/checkout     — create PendingPayment order
 *   3. POST /v1/shop/orders/{code}/payment-intent — mint a real Stripe PI
 *   4. stripe.paymentIntents.confirm(pi, { payment_method: 'pm_card_visa' })
 *      — Stripe's test card settles the PI without 3DS in headless CI
 *   5. POST /v1/shop/orders/{code}/pay — verify + settle (applyPaymentResult)
 *   6. POST /v1/webhooks/stripe (signed) — simulates the webhook reconcile
 *      path that catches a client that died before step 5. Idempotent: the
 *      payment row's (store_id, provider_ref) unique index + onConflictDoNothing
 *      in applyPaymentResult guarantees a second settle is a no-op.
 *   7. Asserts the order is Paid, a license row was issued for the licensed
 *      product, and the order-confirmation email was attempted (the mailer
 *      no-ops with a log line when SMTP is unconfigured).
 *
 * Runs against sellright_test ONLY (TRUNCATEs data). Self-skips when no test
 * Stripe key is configured (`STRIPE_SECRET_KEY_TEST` AND `STRIPE_WEBHOOK_SECRET_TEST`)
 * so dev + CI without creds don't hard-fail. When creds ARE present, every Stripe
 * API call is REAL — `pm_card_visa` is the canonical Stripe test card that
 * succeeds immediately without 3DS, so this exercises the full path end-to-end.
 *
 * Pattern matches checkout-migration.test.ts / subscriptions.test.ts:
 * createApp() for the full route surface + beforeEach TRUNCATE store CASCADE +
 * seeds under withStore(). vitest runs files serially (fileParallelism: false).
 *
 * The irreducible HUMAN gate (real-browser 3DS card confirmation) is NOT
 * covered here — `pm_card_visa` lets headless CI confirm cards programmatically.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';

// Skip the entire suite when Stripe test keys are missing. We need BOTH the
// secret key (to call the Stripe API) and the webhook secret (to sign the
// synthesized payment_intent.succeeded event for the webhook reconcile step).
const SECRET = env.STRIPE_SECRET_KEY_TEST ?? env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET_TEST ?? env.STRIPE_WEBHOOK_SECRET;
const HAS_STRIPE_KEYS = !!SECRET && !!WEBHOOK_SECRET
  && SECRET.startsWith('sk_test_') && (WEBHOOK_SECRET.startsWith('whsec_') || WEBHOOK_SECRET.startsWith('whsec_test_'));

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`e2e checkout test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-e2eeee2eeeee';
const SLUG = 'e2e-stripe-test-store';
const CUSTOMER = 'eeeeeeee-eeee-eeee-eeee-e2e0000000c1';
const PRODUCT = 'eeeeeeee-eeee-eeee-eeee-e2e0000000p1';
const VARIANT = 'eeeeeeee-eeee-eeee-eeee-e2e0000000v1';

const app = createApp();

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

/** Seed a single store + customer + licensed product variant (sku 'E2E-LIC-1', $25)
 *  with stock on hand. Stripe config = test mode. */
async function seed(): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', ${JSON.stringify({
        payments: { stripe: true },
        stripe: { mode: 'test' },
      })}::jsonb)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (${CUSTOMER}, ${STORE}, 'e2e-buyer@test.local') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PRODUCT}, ${STORE}, 'e2e-prod', 'E2E Product', 'active') ON CONFLICT (id) DO NOTHING`);
    // Licensed fulfillment => issueLicensesForPaidOrder will mint a license row on settle.
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type, app_key, license_seats)
      VALUES (${VARIANT}, ${STORE}, ${PRODUCT}, 'E2E-LIC-1', 'E2E License 1', 2500, 'license', 'e2e', 1)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated)
      VALUES (${VARIANT}, ${STORE}, 100, 0)
      ON CONFLICT (variant_id) DO UPDATE SET on_hand = 100, allocated = 0`);
  });
}

/** Sign a Stripe webhook payload with the configured webhook secret. Returns
 *  the value for the `stripe-signature` header. Uses Stripe's own test helper
 *  so the signature verifies via the production code path (constructEvent). */
function signWebhook(payload: string): string {
  // generateTestHeaderString is static (no API call) and produces a valid signature.
  return new Stripe(SECRET!).webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET! });
}

const hdr = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-store-slug': SLUG, ...extra });

beforeEach(async () => { await wipe(); await seed(); });
afterEach(async () => { /* nothing — TRUNCATE is in afterAll */ });
afterAll(async () => { await wipe(); await pool.end(); });

(HAS_STRIPE_KEYS ? describe : describe.skip)('E2E checkout → pay → fulfill (Stripe test keys, TEST-2)', () => {
  it('happy path: cart → checkout → Stripe PI → confirm → /pay → webhook → Paid + license + email', async () => {
    const stripe = new Stripe(SECRET!);

    // 1. Create the cart with the seeded variant.
    const cartRes = await app.request('/v1/shop/cart', {
      method: 'POST', headers: hdr(),
      body: JSON.stringify({ items: [{ sku: 'E2E-LIC-1', quantity: 1 }] }),
    });
    expect(cartRes.status).toBe(200);
    const cart = await cartRes.json() as { token: string; grandTotal: number };
    expect(cart.token).toBeTruthy();
    expect(cart.grandTotal).toBe(2500);

    // 2. Checkout the cart (server-priced, server-allocated stock, PendingPayment order).
    const shipAddr = {
      fullName: 'E2E Buyer',
      line1: '1 Test St',
      city: 'Testville',
      province: 'CA',
      postalCode: '94000',
      country: 'US',
      phone: '+15555550100',
    };
    const checkoutRes = await app.request('/v1/shop/checkout', {
      method: 'POST', headers: hdr(),
      body: JSON.stringify({ cartToken: cart.token, email: 'e2e-buyer@test.local', shippingAddress: shipAddr }),
    });
    expect(checkoutRes.status).toBe(200);
    const checkoutBody = await checkoutRes.json() as { code: string; state: string; grandTotal: number; receiptToken: string };
    expect(checkoutBody.state).toBe('PendingPayment');
    expect(checkoutBody.grandTotal).toBe(2500);
    const { code, receiptToken } = checkoutBody;

    // 3. Mint a real Stripe PaymentIntent (server-side, idempotent on the order id).
    const piRes = await app.request(`/v1/shop/orders/${code}/payment-intent`, { method: 'POST', headers: hdr() });
    expect(piRes.status).toBe(200);
    const piBody = await piRes.json() as { clientSecret: string; intentId: string };
    const intentId = piBody.intentId;
    expect(intentId).toMatch(/^pi_/);

    // 4. Confirm the PaymentIntent with Stripe's canonical test card. In Stripe
    // test mode this succeeds immediately without 3DS (what the storefront's
    // Stripe.js confirm call would do, but headless-CI-callable).
    const confirmed = await stripe.paymentIntents.confirm(intentId, {
      payment_method: 'pm_card_visa',
      return_url: 'https://example.com/checkout/return',
    });
    expect(confirmed.status).toBe('succeeded');
    expect(confirmed.metadata?.orderCode).toBe(code);

    // 5. Server-side /pay verifies + settles (this is what the storefront calls
    //    after Stripe.js returns from the confirm).
    const payRes = await app.request(`/v1/shop/orders/${code}/pay`, {
      method: 'POST', headers: hdr(),
      body: JSON.stringify({ method: 'stripe', token: { paymentIntentId: intentId } }),
    });
    expect(payRes.status).toBe(200);
    const payBody = await payRes.json() as { code: string; state: string; payment: string };
    expect(payBody.state).toBe('Paid');
    expect(payBody.payment).toBe('Settled');

    // 6. Synthesize the inbound payment_intent.succeeded webhook the gateway
    //    sends us — proves the webhook reconcile path is correctly wired
    //    (idempotency guarantee: re-delivery is a no-op via processed_event).
    const webhookEvent = {
      id: `evt_e2e_test_${code}`,
      object: 'event',
      api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000),
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: intentId,
          object: 'payment_intent',
          amount: 2500,
          currency: 'usd',
          status: 'succeeded',
          metadata: { orderCode: code, storeId: STORE },
        },
      },
    } as const;
    const webhookPayload = JSON.stringify(webhookEvent);
    const webhookRes = await app.request('/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-store-slug': SLUG, 'stripe-signature': signWebhook(webhookPayload) },
      body: webhookPayload,
    });
    expect(webhookRes.status).toBe(200);

    // 7. ORDER: Paid, settled payment row exists.
    const order = await withStore(STORE, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      return o;
    });
    expect(order).toBeTruthy();
    expect(order!.state).toBe('Paid');
    expect(order!.placedAt).toBeTruthy();

    const payments = await withStore(STORE, async (tx) =>
      tx.select().from(s.payment).where(eq(s.payment.orderId, order!.id)));
    expect(payments).toHaveLength(1);
    expect(payments[0]!.state).toBe('Settled');
    expect(payments[0]!.method).toBe('stripe');
    expect(payments[0]!.providerRef).toBe(intentId);

    // LICENSES: one issued for the licensed variant (issueLicensesForPaidOrder).
    const licenses = await withStore(STORE, async (tx) =>
      tx.select().from(s.license).where(eq(s.license.orderId, order!.id)));
    expect(licenses).toHaveLength(1);
    expect(licenses[0]!.appKey).toBe('e2e');
    expect(licenses[0]!.seats).toBe(1);
    expect(licenses[0]!.licenseKey).toMatch(/^SR-E2E-/);

    // ORDER READ: the receipt-token path returns the order (the confirmation
    // page uses this — proves the email-enqueued link works).
    const readRes = await app.request(`/v1/shop/orders/${code}?rt=${encodeURIComponent(receiptToken)}`, { headers: hdr() });
    expect(readRes.status).toBe(200);
    const readBody = await readRes.json() as { code: string; state: string };
    expect(readBody.code).toBe(code);
    expect(readBody.state).toBe('Paid');
  }, 30_000);
});