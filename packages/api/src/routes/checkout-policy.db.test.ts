/**
 * DB tests for the checkout-time payment policy hook (PAYMENT-TIMING §3.1, R1; X-57): extension blocks, the
 * fingerprint, onCheckoutOrder (veto, metadata, reservations, price adjustment, failure), and checkoutReplayAllowed
 * at the idempotency replay site. Runs against defork_checkouthook_test ONLY (these wipe data).
 *
 * Without a registered policy the checkout is unchanged: the first case asserts that directly.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { clearLoginAttempts } from '../auth/rate-limit.js';
import { _resetPaymentPoliciesForTests, registerPaymentPolicy } from '../payments/policy/host.js';
import type { CheckoutExtensionSchema, CheckoutOrderInput, CheckoutReplayInput, PaymentPolicy } from '../payments/policy/types.js';
import { checkout } from './checkout.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`checkout-policy test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'cccccccc-3333-3333-3333-333333333333';
const SLUG = 'checkout-policy-test-store';
const PRODUCT = 'cccccccc-3333-3333-3333-3333333333a1';
const VARIANT = 'cccccccc-3333-3333-3333-3333333333b1';
const SKU = 'POLICY-DIG-1';
const PRICE = 4900;
const POLICY_ID = 'checkout-test';

/** A structural schema: the block must be an object with a string sourceId. */
const EXT: CheckoutExtensionSchema = {
  safeParse(v: unknown) {
    return v && typeof v === 'object' && typeof (v as { sourceId?: unknown }).sourceId === 'string'
      ? { success: true, data: { sourceId: (v as { sourceId: string }).sourceId } }
      : { success: false };
  },
};

const seen: { order?: CheckoutOrderInput['order']; extensions?: unknown; customer?: unknown } = {};
let replayAllowed = true;

function policy(over: Partial<PaymentPolicy> = {}): PaymentPolicy {
  return {
    id: POLICY_ID,
    async beforePaymentAttempt() { return { allow: true }; },
    checkoutExtensions: EXT,
    async onCheckoutOrder(_tx, i) {
      seen.order = i.order;
      seen.extensions = i.extensions;
      seen.customer = i.customer;
      return {};
    },
    async checkoutReplayAllowed(_tx, _i: CheckoutReplayInput) { return replayAllowed; },
    ...over,
  };
}

const app = new OpenAPIHono();
app.route('/', checkout);

async function wipe(): Promise<void> {
  await pool.query('TRUNCATE store CASCADE');
}

async function seed(): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, tax_rate, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', 0, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PRODUCT}, ${STORE}, 'policy-prod', 'Policy Product', 'active') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type)
      VALUES (${VARIANT}, ${STORE}, ${PRODUCT}, ${SKU}, 'Policy Download', ${PRICE}, 'digital_download') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 100, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 100, allocated = 0`);
  });
}

async function count(table: 'order' | 'order_adjustment' | 'order_reservation'): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql.raw(`SELECT count(*)::int n FROM "${table}" WHERE store_id = '${STORE}'`));
    return (r.rows[0] as { n: number }).n;
  });
}

async function orderByCode(code: string) {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT grand_total, metadata FROM "order" WHERE store_id = ${STORE} AND code = ${code}`);
    return r.rows[0] as { grand_total: number; metadata: Record<string, unknown> } | undefined;
  });
}

const hdr = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-store-slug': SLUG, ...extra });
function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.request('/v1/shop/checkout', { method: 'POST', headers: hdr(headers), body: JSON.stringify(body) });
}
const base = { items: [{ sku: SKU, quantity: 1 }], email: 'buyer@example.com' };

beforeEach(async () => {
  clearLoginAttempts('unknown', 'checkout:unknown');
  seen.order = undefined; seen.extensions = undefined; seen.customer = undefined;
  replayAllowed = true;
  await wipe();
  await seed();
});
afterEach(() => { _resetPaymentPoliciesForTests(); });
afterAll(async () => { _resetPaymentPoliciesForTests(); await wipe(); await pool.end(); });

describe('POST /v1/shop/checkout — payment policy hook (X-57)', () => {
  it('with no policy registered the checkout is unchanged (no adjustment, no extra metadata)', async () => {
    const res = await post(base);
    expect(res.status).toBe(200);
    const body = await res.json() as { code: string; grandTotal: number };
    expect(body.grandTotal).toBe(PRICE);
    const o = await orderByCode(body.code);
    expect(o?.metadata).not.toHaveProperty('extensions');
    expect(await count('order_adjustment')).toBe(0);
  });

  it('a block that fails its policy schema is a 400 and creates no order', async () => {
    _resetPaymentPoliciesForTests();
    registerPaymentPolicy(policy());
    const res = await post({ ...base, extensions: { [POLICY_ID]: { sourceId: 7 } } });
    expect(res.status).toBe(400);
    expect(await count('order')).toBe(0);
  });

  it('an extension key naming no declared policy is a 400', async () => {
    _resetPaymentPoliciesForTests();
    registerPaymentPolicy(policy());
    const res = await post({ ...base, extensions: { unknown: {} } });
    expect(res.status).toBe(400);
    expect(await count('order')).toBe(0);
  });

  it('a valid block reaches the hook as the policy\'s validated extension, and the fingerprint differs per block', async () => {
    _resetPaymentPoliciesForTests();
    registerPaymentPolicy(policy());
    const key = 'idem-ext-a';
    const first = await post({ ...base, extensions: { [POLICY_ID]: { sourceId: 'LIC-1' } } }, { 'idempotency-key': key });
    expect(first.status).toBe(200);
    expect(seen.extensions).toEqual({ sourceId: 'LIC-1' });
    // Same key, same items, different block: the fingerprint no longer matches, so this is a payload conflict.
    const second = await post({ ...base, extensions: { [POLICY_ID]: { sourceId: 'LIC-2' } } }, { 'idempotency-key': key });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  it('a veto rolls the checkout back: 409 with the veto code and no order rows', async () => {
    _resetPaymentPoliciesForTests();
    registerPaymentPolicy(policy({ async onCheckoutOrder() { return { veto: { code: 'CHECKOUT_TEST_VETO', message: 'not today' } }; } }));
    const res = await post({ ...base, extensions: { [POLICY_ID]: { sourceId: 'LIC-1' } } });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CHECKOUT_TEST_VETO');
    expect(body.error.message).toBe('not today');
    expect(await count('order')).toBe(0);
  });

  it('metadata is merged into the order without disturbing the engine fingerprint', async () => {
    _resetPaymentPoliciesForTests();
    registerPaymentPolicy(policy({ async onCheckoutOrder() { return { metadata: { partnerRef: 'P-7' } }; } }));
    const res = await post({ ...base, extensions: { [POLICY_ID]: { sourceId: 'LIC-1' } } });
    expect(res.status).toBe(200);
    const o = await orderByCode((await res.json() as { code: string }).code);
    expect(o?.metadata.partnerRef).toBe('P-7');
    expect(typeof o?.metadata.checkoutFingerprint).toBe('string');
  });

  it('a reserve request creates a held row in the checkout transaction; a second order for the same owner conflicts', async () => {
    _resetPaymentPoliciesForTests();
    registerPaymentPolicy(policy({ async onCheckoutOrder() { return { reserve: [{ kind: 'test.credit', ownerKey: 'LIC-9' }] }; } }));
    const first = await post({ ...base, extensions: { [POLICY_ID]: { sourceId: 'LIC-9' } } });
    expect(first.status).toBe(200);
    const held = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT state, owner_key FROM order_reservation WHERE store_id = ${STORE}`);
      return r.rows as Array<{ state: string; owner_key: string }>;
    });
    expect(held).toEqual([{ state: 'held', owner_key: 'LIC-9' }]);
    const second = await post({ items: [{ sku: SKU, quantity: 1 }], email: 'other@example.com', extensions: { [POLICY_ID]: { sourceId: 'LIC-9' } } });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('RESERVATION_CONFLICT');
    expect(await count('order')).toBe(1);
  });

  it('a price adjustment is an order_adjustment row, recomputes the grand total, and is the amount due', async () => {
    _resetPaymentPoliciesForTests();
    registerPaymentPolicy(policy({ async onCheckoutOrder() { return { priceAdjustment: { code: 'test.credit', label: 'Partner credit', amount: -500 } }; } }));
    const res = await post({ ...base, extensions: { [POLICY_ID]: { sourceId: 'LIC-1' } } });
    expect(res.status).toBe(200);
    const body = await res.json() as { code: string; grandTotal: number };
    expect(body.grandTotal).toBe(PRICE - 500);
    const o = await orderByCode(body.code);
    expect(o?.grand_total).toBe(PRICE - 500);
    const adj = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT label, amount, actor FROM order_adjustment WHERE store_id = ${STORE}`);
      return r.rows as Array<{ label: string; amount: number; actor: string }>;
    });
    expect(adj).toEqual([{ label: 'Partner credit', amount: -500, actor: `policy:${POLICY_ID}` }]);
  });

  it('a replay the policy refuses returns the fork wire (422 LEGAL_ACCEPTANCE_REQUIRED); an allowed replay returns the same order', async () => {
    _resetPaymentPoliciesForTests();
    registerPaymentPolicy(policy());
    const key = 'idem-replay-1';
    const reqBody = { ...base, extensions: { [POLICY_ID]: { sourceId: 'LIC-1' } } };
    const first = await post(reqBody, { 'idempotency-key': key });
    expect(first.status).toBe(200);
    const code = (await first.json() as { code: string }).code;

    replayAllowed = true;
    const ok = await post(reqBody, { 'idempotency-key': key });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { code: string }).code).toBe(code);

    replayAllowed = false;
    const refused = await post(reqBody, { 'idempotency-key': key });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
    expect(await count('order')).toBe(1);
  });

  it('a policy that throws is 409 PAYMENT_POLICY_UNAVAILABLE and persists nothing', async () => {
    _resetPaymentPoliciesForTests();
    registerPaymentPolicy(policy({ async onCheckoutOrder() { throw new Error('boom'); } }));
    const res = await post({ ...base, extensions: { [POLICY_ID]: { sourceId: 'LIC-1' } } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PAYMENT_POLICY_UNAVAILABLE');
    expect(await count('order')).toBe(0);
    expect(await count('order_reservation')).toBe(0);
    expect(await count('order_adjustment')).toBe(0);
  });
});
