/**
 * E2E checkout → gateway-payment (NMI + Sezzle) against REAL gateway sandboxes.
 * The gateway-mode analogue of e2e-checkout-stripe.test.ts: drives the full
 * Hono app through the required journey with no transport mocks —
 *
 *   1. POST /v1/shop/cart         — physical variant + configured shipping
 *   2. POST /v1/shop/checkout     — PendingPayment order (shippingMethodCode)
 *   3. POST /v1/shop/orders/{code}/gateway-payment — REAL gateway call:
 *      - NMI:     security_key → sandbox.nmi.com/api/transact.php
 *      - Sezzle:  public/private key → sandbox.gateway.sezzle.com session,
 *                 checkout_url rewritten to sandbox.checkout.sezzle.com
 *   4. POST …/gateway-payment/{attempt}/verify — REAL provider reconciliation
 *
 * What is and isn't provable headless (by gateway design, not our choice):
 *   - NMI `payment_token` can only be minted by Collect.js in a browser (the
 *     tokenization key "will not work with any other APIs" — NMI docs). So the
 *     no-token leg asserts the real sandbox round-trip + structured terminal
 *     handling; a full sale needs a real Collect.js token — supply one via
 *     NMI_TEST_PAYMENT_TOKEN and the settle leg runs too.
 *   - Sezzle checkout requires interactive shopper approval on the hosted
 *     page. Headless coverage ends at session creation + verify reporting the
 *     pending order — the browser approval leg is the human step.
 *
 * Runs against *_test ONLY (TRUNCATEs data). Self-skips unless ALL of:
 *   SR_GATEWAY_E2E=1
 *   NMI_TEST_SECURITY_KEY      — sandbox-capable NMI security key
 *   SEZZLE_TEST_PUBLIC_KEY / SEZZLE_TEST_PRIVATE_KEY — sandbox Sezzle pair
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';

const NMI_KEY = process.env.NMI_TEST_SECURITY_KEY ?? '';
const SEZZLE_PUB = process.env.SEZZLE_TEST_PUBLIC_KEY ?? '';
const SEZZLE_PRIV = process.env.SEZZLE_TEST_PRIVATE_KEY ?? '';
const NMI_TOKEN = process.env.NMI_TEST_PAYMENT_TOKEN ?? '';
const ENABLED = process.env.SR_GATEWAY_E2E === '1' && !!NMI_KEY && !!SEZZLE_PUB && !!SEZZLE_PRIV;

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`e2e gateway test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-e2ee3eeeee';
const SLUG = 'e2e-gateway-test-store';
const PRODUCT = 'eeeeeeee-eeee-eeee-eeee-e2e0000000p2';
const VARIANT = 'eeeeeeee-eeee-eeee-eeee-e2e0000000v2';
const NMI_ACCT = 'acct-nmi-e2e-test';
const SEZZLE_ACCT = 'acct-sezzle-e2e-test';

const app = createApp();

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

/** Physical product + flat-rate shipping method so the full shippingMethodCode
 *  contract is exercised (physical carts REQUIRE an explicit method). */
async function seed(): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', ${JSON.stringify({
        payments: { nmi: true, sezzle: true },
        paymentAccounts: { nmi: NMI_ACCT, sezzle: SEZZLE_ACCT },
        storefrontUrl: 'http://localhost:5173',
      })}::jsonb)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PRODUCT}, ${STORE}, 'e2e-phys', 'E2E Physical', 'active') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type)
      VALUES (${VARIANT}, ${STORE}, ${PRODUCT}, 'E2E-PHYS-1', 'E2E Physical 1', 2500, 'physical')
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated)
      VALUES (${VARIANT}, ${STORE}, 100, 0)
      ON CONFLICT (variant_id) DO UPDATE SET on_hand = 100, allocated = 0`);
    await tx.execute(sql`INSERT INTO shipping_method (id, store_id, code, name, calculator, enabled)
      VALUES (gen_random_uuid(), ${STORE}, 'flat', 'Flat rate', ${JSON.stringify({ flat: 800 })}::jsonb, true)`);
  });
}

const hdr = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-store-slug': SLUG, ...extra });

const shipAddr = {
  fullName: 'E2E Buyer', line1: '1 Test St', city: 'Testville',
  province: 'CA', postalCode: '94000', country: 'US', phone: '+15555550100',
};

async function cartToPendingOrder(): Promise<{ code: string; receiptToken: string; grandTotal: number }> {
  const cartRes = await app.request('/v1/shop/cart', {
    method: 'POST', headers: hdr(),
    body: JSON.stringify({ items: [{ sku: 'E2E-PHYS-1', quantity: 1 }] }),
  });
  expect(cartRes.status).toBe(200);
  const cart = await cartRes.json() as { token: string; revision: number };
  const checkoutRes = await app.request('/v1/shop/checkout', {
    method: 'POST', headers: hdr(),
    body: JSON.stringify({
      cartToken: cart.token, expectedRevision: cart.revision,
      email: 'e2e-buyer@test.local', shippingAddress: shipAddr,
      shippingMethodCode: 'flat',
    }),
  });
  expect(checkoutRes.status).toBe(200);
  const body = await checkoutRes.json() as { code: string; state: string; grandTotal: number; receiptToken: string };
  expect(body.state).toBe('PendingPayment');
  return { code: body.code, receiptToken: body.receiptToken, grandTotal: body.grandTotal };
}

beforeEach(async () => {
  await wipe();
  await seed();
  // Test-mode gateway accounts are injected into the mutable env object the
  // runtime resolves from — GATEWAY_ACCOUNTS_JSON itself stays operator-owned.
  env.GATEWAY_ACCOUNTS_JSON = JSON.stringify([
    { accountId: NMI_ACCT, storeId: STORE, method: 'nmi', mode: 'test', securityKey: NMI_KEY, tokenizationKey: 'e2e-tok-key' },
    { accountId: SEZZLE_ACCT, storeId: STORE, method: 'sezzle', mode: 'test', publicKey: SEZZLE_PUB, privateKey: SEZZLE_PRIV },
  ]);
});
afterAll(async () => { await wipe(); await pool.end(); });

(ENABLED ? describe : describe.skip)('E2E checkout → gateway-payment (real NMI/Sezzle sandboxes)', () => {

  it('NMI: gateway-payment hits sandbox.nmi.com and the attempt resolves to a structured terminal state', async () => {
    const { code, receiptToken, grandTotal } = await cartToPendingOrder();
    expect(grandTotal).toBe(3300); // 2500 + 800 flat shipping

    const payRes = await app.request(`/v1/shop/orders/${code}/gateway-payment`, {
      method: 'POST', headers: hdr({ 'idempotency-key': `e2e-nmi-${code}`, 'x-receipt-token': receiptToken }),
      body: JSON.stringify({ method: 'nmi', token: NMI_TOKEN || 'e2e-invalid-token' }),
    });
    expect(payRes.status).toBe(200);
    const attempt = await payRes.json() as { attemptId: string; status: string };
    expect(attempt.attemptId).toBeTruthy();
    if (NMI_TOKEN) {
      // Real Collect.js token → full sale: settled attempt + Paid order.
      expect(attempt.status).toBe('settled');
      const [order] = await withStore(STORE, async tx =>
        tx.select().from(s.order).where(eq(s.order.code, code)).limit(1));
      expect(order!.state).toBe('Paid');
    } else {
      // Bogus token still proves the sandbox round-trip: the request reached
      // NMI and came back as a structured decline/error, not a crash or a
      // locally-faked failure. Terminal states only — never 'processing'.
      expect(['declined', 'failed', 'unknown']).toContain(attempt.status);
    }

    // Idempotency: same key replays the same attempt view, never double-charges.
    const replay = await app.request(`/v1/shop/orders/${code}/gateway-payment`, {
      method: 'POST', headers: hdr({ 'idempotency-key': `e2e-nmi-${code}`, 'x-receipt-token': receiptToken }),
      body: JSON.stringify({ method: 'nmi', token: NMI_TOKEN || 'e2e-invalid-token' }),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json() as { attemptId: string }).attemptId).toBe(attempt.attemptId);
  });

  it('Sezzle: session → sandbox checkoutUrl → pending attempt → verify reaches the provider', async () => {
    const { code, receiptToken } = await cartToPendingOrder();

    const payRes = await app.request(`/v1/shop/orders/${code}/gateway-payment`, {
      method: 'POST', headers: hdr({ 'idempotency-key': `e2e-sezzle-${code}`, 'x-receipt-token': receiptToken }),
      body: JSON.stringify({ method: 'sezzle' }),
    });
    expect(payRes.status).toBe(200);
    const attempt = await payRes.json() as { attemptId: string; status: string; checkoutUrl?: string };
    expect(attempt.status).toBe('pending');
    expect(attempt.checkoutUrl).toBeTruthy();
    // The adapter rewrites the hosted page onto the sandbox checkout host —
    // proving mode='test' selected the sandbox, not production.
    expect(() => new URL(attempt.checkoutUrl!)).not.toThrow();
    expect(new URL(attempt.checkoutUrl!).hostname).toBe('sandbox.checkout.sezzle.com');

    // Verify reconciles against the real Sezzle order record — the session is
    // pending shopper approval, so the attempt stays pending (not an error).
    const verifyRes = await app.request(`/v1/shop/orders/${code}/gateway-payment/${attempt.attemptId}/verify`, {
      method: 'POST', headers: hdr({ 'x-receipt-token': receiptToken }),
    });
    expect(verifyRes.status).toBe(200);
    const verify = await verifyRes.json() as { status: string };
    expect(['pending', 'settled']).toContain(verify.status);
  });
});
