/**
 * E2E checkout → gateway-payment (NMI + Sezzle) against REAL test-mode gateways.
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
 *     no-token control does not prove settlement. Supply a real Collect.js
 *     token via NMI_TEST_PAYMENT_TOKEN for settlement and a different token
 *     via NMI_REFUND_TEST_PAYMENT_TOKEN for the refund leg.
 *   - Sezzle checkout requires interactive shopper approval on the hosted
 *     page. Headless coverage ends at session creation + verify reporting the
 *     pending order — the browser approval leg is the human step.
 *
 * Runs against *_test ONLY (TRUNCATEs data), requiring the exact database
 * name in SR_GATEWAY_E2E_RESET_DATABASE. Provider legs require ALL of:
 *   SR_GATEWAY_E2E=1
 *   NMI_TEST_SECURITY_KEY      — key for the selected NMI environment
 *   NMI_TEST_ENVIRONMENT       — sandbox (default) or production with test_mode
 *   SEZZLE_TEST_PUBLIC_KEY / SEZZLE_TEST_PRIVATE_KEY — sandbox Sezzle pair
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { dispute as disputeTable } from '../db/schema-ops.js';
import { createAdminSession } from '../auth/admin-session.js';
import { reconcileGatewayEvents } from '../jobs/reconcile-gateway-events.js';
import { assertGatewayTestTarget as assertTestDatabase } from '../payments/gateway-e2e-safety.js';

const NMI_KEY = process.env.NMI_TEST_SECURITY_KEY ?? '';
const SEZZLE_PUB = process.env.SEZZLE_TEST_PUBLIC_KEY ?? '';
const SEZZLE_PRIV = process.env.SEZZLE_TEST_PRIVATE_KEY ?? '';
const NMI_TOKEN = process.env.NMI_TEST_PAYMENT_TOKEN ?? '';
const NMI_REFUND_TOKEN = process.env.NMI_REFUND_TEST_PAYMENT_TOKEN ?? '';
const NMI_ENVIRONMENT = process.env.NMI_TEST_ENVIRONMENT ?? 'sandbox';
const ENABLED = process.env.SR_GATEWAY_E2E === '1' && !!NMI_KEY && !!SEZZLE_PUB && !!SEZZLE_PRIV;
// Webhook ingress is self-contained: the signature is HMAC over whatever
// privateKey is configured, so these legs produce real evidence even with
// placeholder keys — they never call Sezzle.
const INGRESS_ENABLED = process.env.SR_GATEWAY_E2E === '1' && !!SEZZLE_PRIV;
const RUN_ENABLED = ENABLED || INGRESS_ENABLED;

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (RUN_ENABLED) assertTestDatabase(DB, process.env.SR_GATEWAY_E2E_RESET_DATABASE);
if (RUN_ENABLED && !['sandbox', 'production'].includes(NMI_ENVIRONMENT)) throw new Error('Invalid NMI_TEST_ENVIRONMENT');

const STORE = 'e2e00000-0000-4000-8000-000000000001';
const SLUG = 'e2e-gateway-test-store';
const PRODUCT = 'e2e00000-0000-4000-8000-000000000002';
const VARIANT = 'e2e00000-0000-4000-8000-000000000003';
const NMI_ACCT = 'acct-nmi-e2e-test';
const SEZZLE_ACCT = 'acct-sezzle-e2e-test';
const ADMIN = 'e2e00000-0000-4000-8000-000000000004';

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
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@gateway-e2e.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
  });
}

/** Signed Sezzle webhook fixture — signature scheme is HMAC-SHA256 over the raw
 *  body keyed on the account's privateKey; identical for test and live. */
async function postSezzleEvent(body: Record<string, unknown>, opts: { signature?: string; accountId?: string } = {}) {
  const raw = JSON.stringify(body);
  const signature = opts.signature ?? createHmac('sha256', SEZZLE_PRIV).update(raw).digest('hex');
  return app.request(`/v1/webhooks/sezzle/${STORE}/${opts.accountId ?? SEZZLE_ACCT}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sezzle-signature': signature }, body: raw,
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
  if (!RUN_ENABLED) return;
  await wipe();
  await seed();
  // Test-mode gateway accounts are injected into the mutable env object the
  // runtime resolves from — GATEWAY_ACCOUNTS_JSON itself stays operator-owned.
  env.GATEWAY_ACCOUNTS_JSON = JSON.stringify([
    // Key material must be non-empty to pass account schema validation —
    // placeholders keep identities resolvable when real keys aren't supplied;
    // provider legs gate on ENABLED so they never run on placeholder secrets.
    { accountId: NMI_ACCT, storeId: STORE, method: 'nmi', mode: 'test', nmiEnvironment: NMI_ENVIRONMENT,
      securityKey: NMI_KEY || 'placeholder-nmi-key', tokenizationKey: 'e2e-tok-key' },
    { accountId: SEZZLE_ACCT, storeId: STORE, method: 'sezzle', mode: 'test',
      publicKey: SEZZLE_PUB || 'placeholder-sezzle-pub', privateKey: SEZZLE_PRIV || 'placeholder-sezzle-priv' },
  ]);
});
afterAll(async () => {
  if (!RUN_ENABLED) return;
  await wipe();
  await pool.end();
});

(ENABLED ? describe : describe.skip)('E2E checkout → gateway-payment (real NMI/Sezzle sandboxes)', () => {

  it.skipIf(!NMI_TOKEN)('NMI: a real token settles and the same attempt replays without another charge', async () => {
    const { code, receiptToken, grandTotal } = await cartToPendingOrder();
    expect(grandTotal).toBe(3300); // 2500 + 800 flat shipping

    const payRes = await app.request(`/v1/shop/orders/${code}/gateway-payment`, {
      method: 'POST', headers: hdr({ 'idempotency-key': `e2e-nmi-${code}`, 'x-receipt-token': receiptToken }),
      body: JSON.stringify({ method: 'nmi', token: NMI_TOKEN || 'e2e-invalid-token' }),
    });
    expect(payRes.status).toBe(200);
    const attempt = await payRes.json() as { attemptId: string; status: string };
    expect(attempt.attemptId).toBeTruthy();
    // Unknown/auth failures are not provider acceptance evidence.
    expect(attempt.status).toBe('settled');
    const [order] = await withStore(STORE, async tx =>
      tx.select().from(s.order).where(eq(s.order.code, code)).limit(1));
    expect(order!.state).toBe('Paid');

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

  it('payment controls: idempotency mismatch, second-charge guard, verify-404, immutable attempt identity', async () => {
    const { code, receiptToken } = await cartToPendingOrder();
    const key = `e2e-ctrl-${code}`;

    const first = await app.request(`/v1/shop/orders/${code}/gateway-payment`, {
      method: 'POST', headers: hdr({ 'idempotency-key': key, 'x-receipt-token': receiptToken }),
      body: JSON.stringify({ method: 'nmi', token: 'e2e-token-a' }),
    });
    expect(first.status).toBe(200);
    const attempt = await first.json() as { attemptId: string };

    // Same idempotency key, different payload → rejected, never a second charge.
    const mismatch = await app.request(`/v1/shop/orders/${code}/gateway-payment`, {
      method: 'POST', headers: hdr({ 'idempotency-key': key, 'x-receipt-token': receiptToken }),
      body: JSON.stringify({ method: 'nmi', token: 'e2e-token-b-different' }),
    });
    expect(mismatch.status).toBe(409);

    // An unresolved attempt blocks a second charge on ANY method.
    const second = await app.request(`/v1/shop/orders/${code}/gateway-payment`, {
      method: 'POST', headers: hdr({ 'idempotency-key': `e2e-ctrl2-${code}`, 'x-receipt-token': receiptToken }),
      body: JSON.stringify({ method: 'sezzle' }),
    });
    expect(second.status).toBe(409);
    expect((await second.json() as { error: string }).error).toMatch(/existing payment/i);

    // The attempt row stamps account + mode identity — refunds/webhooks bind to it.
    const [row] = await withStore(STORE, async tx =>
      tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.id, attempt.attemptId)).limit(1));
    expect(row!.method).toBe('nmi');
    expect(row!.accountId).toBe(NMI_ACCT);
    expect(row!.mode).toBe('test');
    expect(row!.idempotencyKey).toBe(key);

    // Verify on a nonexistent attempt → 404, not a fabricated state.
    const bogus = await app.request(`/v1/shop/orders/${code}/gateway-payment/${crypto.randomUUID()}/verify`, {
      method: 'POST', headers: hdr({ 'x-receipt-token': receiptToken }),
    });
    expect(bogus.status).toBe(404);

    // Verify without the receipt token → ownership check holds.
    const noRt = await app.request(`/v1/shop/orders/${code}/gateway-payment/${attempt.attemptId}/verify`, {
      method: 'POST', headers: hdr(),
    });
    expect([401, 403, 404]).toContain(noRt.status);
  });
});

// ── Sezzle webhook ingress — self-contained: HMAC signs against the configured
// privateKey; runs with any key value (placeholder included). Provider calls
// only happen inside the reconcile leg, which degrades honestly without them.
(INGRESS_ENABLED ? describe : describe.skip)('Sezzle webhook ingress (signed fixtures, no provider calls)', () => {

  it('signed order.authorized lands durably with account+mode binding; bad signature 401s; unknown account 404s', async () => {
    const event = { uuid: `evt-${crypto.randomUUID()}`, event: 'order.authorized', data_type: 'order',
      data: { uuid: 'sz-order-e2e-1', order_reference_id: crypto.randomUUID() } };

    const ok = await postSezzleEvent(event);
    expect(ok.status).toBe(200);

    const [row] = await withStore(STORE, async tx =>
      tx.select().from(s.gatewayEvent).where(eq(s.gatewayEvent.eventId, event.uuid)).limit(1));
    expect(row!.method).toBe('sezzle');
    expect(row!.accountId).toBe(SEZZLE_ACCT);
    expect(row!.mode).toBe('test');
    expect(row!.providerRef).toBe('sz-order-e2e-1');
    expect(row!.status).toBe('pending');

    // Provider redelivery collapses to the same row — no duplicate work.
    const dup = await postSezzleEvent(event);
    expect(dup.status).toBe(200);
    const count = await withStore(STORE, async tx =>
      tx.select({ id: s.gatewayEvent.id }).from(s.gatewayEvent).where(eq(s.gatewayEvent.eventId, event.uuid)));
    expect(count.length).toBe(1);

    const badSig = await postSezzleEvent(event, { signature: 'f'.repeat(64) });
    expect(badSig.status).toBe(401);
    const badAcct = await postSezzleEvent(event, { accountId: 'not-a-configured-account' });
    expect(badAcct.status).toBe(404);
  });

  it('signed dispute event (order_uuid shape, no data.uuid) records durably + lands in disputes — SR-06', async () => {
    const event = { uuid: `evt-${crypto.randomUUID()}`, event: 'dispute.opened', data_type: 'dispute',
      data: { order_uuid: 'sz-order-e2e-2', dispute_id: 'dsp-1', dispute_type: 'chargeback', dispute_status: 'open',
        dispute_amount_in_cents: 3300, dispute_currency: 'USD' } };
    const res = await postSezzleEvent(event);
    expect(res.status).toBe(200);

    const [row] = await withStore(STORE, async tx =>
      tx.select().from(s.gatewayEvent).where(eq(s.gatewayEvent.eventId, event.uuid)).limit(1));
    expect(row!.providerRef).toBe('sz-order-e2e-2');
    const disputes = await withStore(STORE, async tx =>
      tx.select().from(disputeTable).where(eq(disputeTable.storeId, STORE)));
    expect(disputes.length).toBe(1);
    expect(disputes[0]!.providerRef).toContain('sz-order-e2e-2');
  });

  it('reconcile worker consumes the event: settles a real order ref or parks honestly when none exists', async () => {
    // A signed event whose providerRef matches no session attempt must NOT
    // settle anything — it stays pending for retry, then parks as manual.
    const event = { uuid: `evt-${crypto.randomUUID()}`, event: 'order.captured', data_type: 'order',
      data: { uuid: 'sz-order-no-attempt', order_reference_id: crypto.randomUUID() } };
    await postSezzleEvent(event);
    await reconcileGatewayEvents();
    const [row] = await withStore(STORE, async tx =>
      tx.select().from(s.gatewayEvent).where(eq(s.gatewayEvent.eventId, event.uuid)).limit(1));
    expect(['pending', 'manual']).toContain(row!.status);
    expect(row!.attempts).toBe(1);
    // Never marked processed on an unresolvable ref — fail closed.
    expect(row!.status).not.toBe('processed');
  });
});

// ── NMI refund leg — only runs when NMI_TEST_PAYMENT_TOKEN produces a real
// sale; refund calls the live sandbox transact API (synchronous, no webhook).
(ENABLED && NMI_REFUND_TOKEN && NMI_REFUND_TOKEN !== NMI_TOKEN ? describe : describe.skip)('NMI refund (requires a separate single-use token)', () => {
  it('settled sale → admin refund → provider refund + ledger row', async () => {
    const { code, receiptToken } = await cartToPendingOrder();
    const payRes = await app.request(`/v1/shop/orders/${code}/gateway-payment`, {
      method: 'POST', headers: hdr({ 'idempotency-key': `e2e-nmi-ref-${code}`, 'x-receipt-token': receiptToken }),
      body: JSON.stringify({ method: 'nmi', token: NMI_REFUND_TOKEN }),
    });
    expect((await payRes.json() as { status: string }).status).toBe('settled');

    const token = await createAdminSession(ADMIN);
    const refundRes = await app.request(`/v1/admin/orders/${code}/refund`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: `e2e-ref-${code}`, reason: 'e2e refund' }),
    });
    expect(refundRes.status).toBe(200);
    const refunds = await withStore(STORE, async tx =>
      tx.select().from(s.refund).where(eq(s.refund.storeId, STORE)));
    expect(refunds.length).toBe(1);
    expect(refunds[0]!.state).toBe('Settled');
  });
});
