/**
 * DB tests for the checkout-time payment policy hook (PAYMENT-TIMING §3.1, R1; X-57): extension blocks, the
 * fingerprint, onCheckoutOrder (veto, metadata, reservations, price adjustment, failure), and checkoutReplayAllowed
 * at the idempotency replay site. Runs against defork_checkouthook_test ONLY (these wipe data).
 *
 * Without a registered policy the checkout is unchanged: the first case asserts that directly.
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { clearLoginAttempts } from '../auth/rate-limit.js';
import { createSession } from '../auth/session.js';
import { invalidateStoreCache } from '../store-context.js';
import { _resetPaymentPoliciesForTests, registerPaymentPolicy } from '../payments/policy/host.js';
import type {
  CheckoutExtensionSchema, CheckoutFingerprintBasis, CheckoutOrderInput, CheckoutReplayInput, CheckoutReplayOrigin, CheckoutRequestIntent, PaymentPolicy,
} from '../payments/policy/types.js';
import { cart } from './cart.js';
import { checkout, fingerprintMatches } from './checkout.js';

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
const FREE_VARIANT = 'cccccccc-3333-3333-3333-3333333333b2';
const FREE_SKU = 'POLICY-FREE-1';
const FREE_VARIANT_2 = 'cccccccc-3333-3333-3333-3333333333b3';
const FREE_SKU_2 = 'POLICY-FREE-2';
const GIFT_CODE = 'GC-POLICY';
const POLICY_ID = 'checkout-test';
const CUSTOMER = 'cccccccc-3333-3333-3333-3333333333c1';

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
app.route('/', cart);

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
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type)
      VALUES (${FREE_VARIANT}, ${STORE}, ${PRODUCT}, ${FREE_SKU}, 'Policy Free Download', 0, 'digital_download') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${FREE_VARIANT}, ${STORE}, 100, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 100, allocated = 0`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type)
      VALUES (${FREE_VARIANT_2}, ${STORE}, ${PRODUCT}, ${FREE_SKU_2}, 'Policy Free Download 2', 0, 'digital_download') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${FREE_VARIANT_2}, ${STORE}, 100, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 100, allocated = 0`);
    await tx.execute(sql`INSERT INTO gift_card (store_id, code, initial_balance, balance) VALUES (${STORE}, ${GIFT_CODE}, 100000, 100000) ON CONFLICT (code) DO UPDATE SET balance = 100000`);
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
  invalidateStoreCache();
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

  describe('placement check sees the persisted order (inline payment paths)', () => {
    /** A policy that contributes metadata + an adjustment at checkout and vetoes the placement unless it sees both. */
    function placementPolicy(sawOrder: Array<{ metadata: unknown; grandTotal: number; provider: string }>): PaymentPolicy {
      return policy({
        async onCheckoutOrder() { return { metadata: { partnerRef: 'P-7' }, priceAdjustment: { code: 'test.credit', label: 'Partner credit', amount: -500 } }; },
        async beforePaymentAttempt(_tx, i) {
          sawOrder.push({ metadata: i.order.metadata, grandTotal: i.order.grandTotal, provider: i.provider });
          const ok = (i.order.metadata as { partnerRef?: string } | null)?.partnerRef === 'P-7';
          return ok ? { allow: true } : { allow: false, veto: { code: 'PARTNER_REF_MISSING', message: 'checkout metadata missing' } };
        },
      });
    }

    it('zero-total: beforePaymentAttempt receives the policy-contributed metadata and the adjusted total', async () => {
      const sawOrder: Array<{ metadata: unknown; grandTotal: number; provider: string }> = [];
      registerPaymentPolicy(policy({
        async onCheckoutOrder() { return { metadata: { partnerRef: 'P-7' } }; },
        async beforePaymentAttempt(_tx, i) {
          sawOrder.push({ metadata: i.order.metadata, grandTotal: i.order.grandTotal, provider: i.provider });
          const ok = (i.order.metadata as { partnerRef?: string } | null)?.partnerRef === 'P-7';
          return ok ? { allow: true } : { allow: false, veto: { code: 'PARTNER_REF_MISSING', message: 'checkout metadata missing' } };
        },
      }));
      const res = await post({ items: [{ sku: FREE_SKU, quantity: 1 }], email: 'free@example.com', extensions: { [POLICY_ID]: { sourceId: 'LIC-1' } } });
      expect(res.status).toBe(200);
      expect((await res.json() as { state: string }).state).toBe('Paid');
      expect(sawOrder).toHaveLength(1);
      expect(sawOrder[0]).toMatchObject({ provider: 'zero_total', grandTotal: 0 });
      expect(sawOrder[0]!.metadata).toMatchObject({ partnerRef: 'P-7', contact: { email: 'free@example.com' } });
    });

    it('gift card: beforePaymentAttempt receives the persisted metadata and the adjusted total', async () => {
      const sawOrder: Array<{ metadata: unknown; grandTotal: number; provider: string }> = [];
      registerPaymentPolicy(placementPolicy(sawOrder));
      const res = await post({ ...base, giftCardCode: GIFT_CODE, extensions: { [POLICY_ID]: { sourceId: 'LIC-1' } } });
      expect(res.status).toBe(200);
      const body = await res.json() as { state: string; grandTotal: number; giftCardApplied: number };
      expect(body.state).toBe('Paid');
      expect(body.grandTotal).toBe(PRICE - 500);
      expect(sawOrder).toHaveLength(1);
      expect(sawOrder[0]).toMatchObject({ provider: 'gift_card', grandTotal: PRICE - 500 });
      expect(sawOrder[0]!.metadata).toMatchObject({ partnerRef: 'P-7' });
    });
  });

  describe('replay is decided under the stored order\'s lock set', () => {
    type Probe = { orderLocked: boolean; reservationLocked: boolean; calls: number };
    const probe: Probe = { orderLocked: false, reservationLocked: false, calls: 0 };

    /** True when ANOTHER connection cannot take the row lock (so the checkout transaction holds it). */
    async function heldByTransaction(query: ReturnType<typeof sql>): Promise<boolean> {
      try {
        await withStore(STORE, (tx) => tx.execute(query));
        return false;
      } catch (e) {
        for (let cur: unknown = e, d = 0; cur && typeof cur === 'object' && d < 5; d++, cur = (cur as { cause?: unknown }).cause) {
          if ((cur as { code?: unknown }).code === '55P03') return true;
        }
        throw e;
      }
    }

    function probingPolicy(): PaymentPolicy {
      return policy({
        async onCheckoutOrder() { return { reserve: [{ kind: 'test.credit', ownerKey: 'LIC-REPLAY' }] }; },
        async checkoutReplayAllowed(_tx, i) {
          probe.calls++;
          probe.orderLocked = await heldByTransaction(sql`SELECT 1 FROM "order" WHERE id = ${i.existingOrder.id} FOR UPDATE NOWAIT`);
          probe.reservationLocked = await heldByTransaction(sql`SELECT 1 FROM order_reservation WHERE order_id = ${i.existingOrder.id} FOR UPDATE NOWAIT`);
          return true;
        },
      });
    }

    beforeEach(() => { probe.orderLocked = false; probe.reservationLocked = false; probe.calls = 0; });

    it('same-key replay: the replayed order and its reservations are locked while the hook runs', async () => {
      registerPaymentPolicy(probingPolicy());
      const reqBody = { ...base, extensions: { [POLICY_ID]: { sourceId: 'LIC-REPLAY' } } };
      const first = await post(reqBody, { 'idempotency-key': 'idem-lock-1' });
      expect(first.status).toBe(200);
      const code = (await first.json() as { code: string }).code;
      const again = await post(reqBody, { 'idempotency-key': 'idem-lock-1' });
      expect(again.status).toBe(200);
      expect((await again.json() as { code: string }).code).toBe(code);
      expect(probe).toEqual({ calls: 1, orderLocked: true, reservationLocked: true });
    });

    it('converted-cart replay: the converted order and its reservations are locked while the hook runs', async () => {
      registerPaymentPolicy(probingPolicy());
      const cartRes = await app.request('/v1/shop/cart', { method: 'POST', headers: hdr(), body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }] }) });
      expect(cartRes.status).toBe(200);
      const { token, revision } = await cartRes.json() as { token: string; revision: number };
      const reqBody = { ...base, cartToken: token, expectedRevision: revision, extensions: { [POLICY_ID]: { sourceId: 'LIC-REPLAY' } } };
      const first = await post(reqBody);
      expect(first.status).toBe(200);
      const code = (await first.json() as { code: string }).code;
      const again = await post(reqBody);
      expect(again.status).toBe(200);
      expect((await again.json() as { code: string }).code).toBe(code);
      expect(probe).toEqual({ calls: 1, orderLocked: true, reservationLocked: true });
    });

    it('concurrent same-key double submit: the loser\'s replay holds the winner\'s order lock set', async () => {
      const gate = holdUntilOtherRequestWaits();
      registerPaymentPolicy({ ...probingPolicy(), async onCheckoutOrder() { await gate(); return { reserve: [{ kind: 'test.credit', ownerKey: 'LIC-REPLAY' }] }; } });
      const reqBody = { ...base, extensions: { [POLICY_ID]: { sourceId: 'LIC-REPLAY' } } };
      const [a, b] = await Promise.all([post(reqBody, { 'idempotency-key': 'idem-lock-2' }), post(reqBody, { 'idempotency-key': 'idem-lock-2' })]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(((await a.json()) as { code: string }).code).toBe(((await b.json()) as { code: string }).code);
      expect(probe).toEqual({ calls: 1, orderLocked: true, reservationLocked: true });
    });
  });

  describe('concurrent reservation conflict', () => {
    it('two checkouts reserving the same owner at once: one succeeds, the other is 409 RESERVATION_CONFLICT (not 500)', async () => {
      // Zero-total checkouts: the winner reaches its placement check (after its reserve, before its commit) and holds
      // there until the other request is blocked on the live-owner index, so both passed reserve()'s existence check.
      const wait = holdUntilOtherRequestWaits();
      registerPaymentPolicy(policy({
        async onCheckoutOrder() { return { reserve: [{ kind: 'test.credit', ownerKey: 'LIC-RACE' }] }; },
        async beforePaymentAttempt() { await wait(); return { allow: true }; },
      }));
      // Distinct SKUs so the two requests do not serialize on one stock row before reaching the reservation insert.
      const reqBody = (email: string) => ({ items: [{ sku: email.startsWith('a') ? FREE_SKU : FREE_SKU_2, quantity: 1 }], email, extensions: { [POLICY_ID]: { sourceId: 'LIC-RACE' } } });
      const [a, b] = await Promise.all([post(reqBody('a@example.com')), post(reqBody('b@example.com'))]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(((await loser.json()) as { error: { code: string } }).error.code).toBe('RESERVATION_CONFLICT');
      expect(await count('order')).toBe(1);
      expect(await count('order_reservation')).toBe(1);
    });

    it('the same race with an Idempotency-Key is still a 409 RESERVATION_CONFLICT (not mistaken for a key race)', async () => {
      const wait = holdUntilOtherRequestWaits();
      registerPaymentPolicy(policy({
        async onCheckoutOrder() { return { reserve: [{ kind: 'test.credit', ownerKey: 'LIC-RACE-2' }] }; },
        async beforePaymentAttempt() { await wait(); return { allow: true }; },
      }));
      // Distinct SKUs so the two requests do not serialize on one stock row before reaching the reservation insert.
      const reqBody = (email: string) => ({ items: [{ sku: email.startsWith('a') ? FREE_SKU : FREE_SKU_2, quantity: 1 }], email, extensions: { [POLICY_ID]: { sourceId: 'LIC-RACE-2' } } });
      const [a, b] = await Promise.all([
        post(reqBody('a@example.com'), { 'idempotency-key': 'idem-race-a' }),
        post(reqBody('b@example.com'), { 'idempotency-key': 'idem-race-b' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(((await loser.json()) as { error: { code: string } }).error.code).toBe('RESERVATION_CONFLICT');
    });
  });
});

// ── Wire parity with the RightSites fork (X-57 ruling D2–D9) ──────────────────────────────────────────
// Each case drives the real route. "Before" the engine change these fail: the result fields and hooks they use did not exist.
const EXT_BODY = { [POLICY_ID]: { sourceId: 'LIC-1' } };
const REFUSAL_MESSAGE = 'Mobile upgrade requires sign-in, one Full Pro license in USD, no other discount, & accepted credit terms';
const REPLAY_MESSAGE_KEY = 'Upgrade order replay requires its signed-in owner & original Mobile Pro source';
const REPLAY_MESSAGE_SHORT = 'Upgrade order replay requires its signed-in owner';
const UPGRADE_PRICE = 3000;

async function setStore(taxRate: number, taxInclusive: boolean, config: Record<string, unknown> = {}): Promise<void> {
  await withStore(STORE, (tx) => tx.execute(sql`UPDATE store SET tax_rate = ${taxRate}, tax_inclusive = ${taxInclusive}, config = ${JSON.stringify(config)}::jsonb WHERE id = ${STORE}`));
  invalidateStoreCache();
}

interface OrderRow { subtotal: number; discount_total: number; shipping_total: number; tax_total: number; grand_total: number; promotion_id: string | null; metadata: Record<string, unknown> }
async function orderRow(code: string): Promise<OrderRow> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT subtotal, discount_total, shipping_total, tax_total, grand_total, promotion_id, metadata FROM "order" WHERE store_id = ${STORE} AND code = ${code}`);
    return r.rows[0] as unknown as OrderRow;
  });
}

async function lineRows(code: string) {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT l.quantity, l.unit_price, l.line_subtotal, l.line_discount, l.line_tax, l.line_total
      FROM order_line l JOIN "order" o ON o.id = l.order_id WHERE o.store_id = ${STORE} AND o.code = ${code} ORDER BY l.variant_sku`);
    return r.rows as Array<{ quantity: number; unit_price: number; line_subtotal: number; line_discount: number; line_tax: number; line_total: number }>;
  });
}

async function promotionStats(): Promise<{ usage: number; usedCount: number }> {
  return withStore(STORE, async (tx) => {
    const u = await tx.execute(sql`SELECT count(*)::int AS n FROM promotion_usage WHERE store_id = ${STORE}`);
    const c = await tx.execute(sql`SELECT coalesce(sum(used_count), 0)::int AS n FROM promotion WHERE store_id = ${STORE}`);
    return { usage: (u.rows[0] as { n: number }).n, usedCount: (c.rows[0] as { n: number }).n };
  });
}

async function addPromotion(code: string | null, percent: number): Promise<void> {
  await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO promotion (store_id, code, type, value, enabled) VALUES (${STORE}, ${code}, 'percentage', ${percent}, true)`));
}

async function giftCardBalance(): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT balance FROM gift_card WHERE store_id = ${STORE} AND code = ${GIFT_CODE}`);
    return (r.rows[0] as { balance: number }).balance;
  });
}

/** A policy whose checkout replaces the applied promotion so the single line costs UPGRADE_PRICE (the fork's `subtotal - FULL_UPGRADE_PRICE`). */
function replacingPolicy(over: Partial<PaymentPolicy> = {}): PaymentPolicy {
  return policy({
    async onCheckoutOrder(_tx, i) {
      return { replacePromotion: { fixedDiscount: i.lines.reduce((a, l) => a + l.unitPrice * l.quantity, 0) - UPGRADE_PRICE } };
    },
    ...over,
  });
}

describe('checkout policy wire parity (X-57 ruling)', () => {
  describe('D2 — refusals carry their own status and extras', () => {
    it('a refusal answers with exactly its status, code and message and adds no synthetic state', async () => {
      registerPaymentPolicy(policy({ async onCheckoutOrder() { return { refusal: { status: 422, code: 'LEGAL_ACCEPTANCE_REQUIRED', message: REFUSAL_MESSAGE } }; } }));
      const res = await post({ ...base, extensions: EXT_BODY });
      expect(res.status).toBe(422);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toEqual({ error: { code: 'LEGAL_ACCEPTANCE_REQUIRED', message: REFUSAL_MESSAGE } });
      expect(Object.keys(body)).toEqual(['error']);
      expect(await count('order')).toBe(0);
    });

    it('refusal extras are top-level siblings of error; the status may be 409', async () => {
      registerPaymentPolicy(policy({ async onCheckoutOrder() { return { refusal: { status: 409, code: 'PARTNER_REFUSED', message: 'no', extra: { reason: 'partner' } } }; } }));
      const res = await post({ ...base, extensions: EXT_BODY });
      expect(res.status).toBe(409);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toEqual({ reason: 'partner', error: { code: 'PARTNER_REFUSED', message: 'no' } });
      expect(Object.keys(body).sort()).toEqual(['error', 'reason']);
      expect(await count('order')).toBe(0);
    });

    it('a veto keeps its placement defaults: 409 and a state defaulting to the code', async () => {
      registerPaymentPolicy(policy({ async onCheckoutOrder() { return { veto: { code: 'CHECKOUT_TEST_VETO', message: 'not today' } }; } }));
      const res = await post({ ...base, extensions: EXT_BODY });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ state: 'CHECKOUT_TEST_VETO', error: { code: 'CHECKOUT_TEST_VETO', message: 'not today' } });
    });

    it('a result carrying both a veto and a refusal fails closed and persists nothing', async () => {
      registerPaymentPolicy(policy({
        async onCheckoutOrder() { return { veto: { code: 'V', message: 'v' }, refusal: { status: 422, code: 'R', message: 'r' } }; },
      }));
      const res = await post({ ...base, extensions: EXT_BODY });
      expect(res.status).toBe(500);
      expect(await count('order')).toBe(0);
    });
  });

  describe('D3 — structured replay refusal with the replay origin', () => {
    const origins: CheckoutReplayOrigin[] = [];
    let refuse = false;
    const replayPolicy = (): PaymentPolicy => policy({
      async checkoutReplayAllowed(_tx, i) {
        origins.push(i.origin);
        if (!refuse) return true;
        return { allow: false, message: i.origin === 'idempotency_key' ? REPLAY_MESSAGE_KEY : REPLAY_MESSAGE_SHORT };
      },
    });
    beforeEach(() => { origins.length = 0; refuse = false; });

    it('same-key replay: the policy sees origin idempotency_key and its message reaches the wire unchanged (422, legacy code)', async () => {
      registerPaymentPolicy(replayPolicy());
      const reqBody = { ...base, extensions: EXT_BODY };
      expect((await post(reqBody, { 'idempotency-key': 'idem-d3-a' })).status).toBe(200);
      refuse = true;
      const res = await post(reqBody, { 'idempotency-key': 'idem-d3-a' });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: { code: 'LEGAL_ACCEPTANCE_REQUIRED', message: REPLAY_MESSAGE_KEY } });
      expect(origins).toEqual(['idempotency_key']);
      expect(await count('order')).toBe(1);
    });

    it('converted-cart replay: origin converted_cart, and the shorter message', async () => {
      registerPaymentPolicy(replayPolicy());
      const cartRes = await app.request('/v1/shop/cart', { method: 'POST', headers: hdr(), body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }] }) });
      const { token, revision } = await cartRes.json() as { token: string; revision: number };
      const reqBody = { ...base, cartToken: token, expectedRevision: revision, extensions: EXT_BODY };
      expect((await post(reqBody)).status).toBe(200);
      refuse = true;
      const res = await post(reqBody);
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: { code: 'LEGAL_ACCEPTANCE_REQUIRED', message: REPLAY_MESSAGE_SHORT } });
      expect(origins).toEqual(['converted_cart']);
    });

    it('unique-violation race: the loser\'s replay carries origin unique_violation and the shorter message', async () => {
      const gate = holdUntilOtherRequestWaits();
      refuse = true;
      registerPaymentPolicy({ ...replayPolicy(), async onCheckoutOrder() { await gate(); return {}; } });
      const reqBody = { ...base, extensions: EXT_BODY };
      const [a, b] = await Promise.all([post(reqBody, { 'idempotency-key': 'idem-d3-race' }), post(reqBody, { 'idempotency-key': 'idem-d3-race' })]);
      expect([a.status, b.status].sort()).toEqual([200, 422]);
      const loser = a.status === 422 ? a : b;
      expect(await loser.json()).toEqual({ error: { code: 'LEGAL_ACCEPTANCE_REQUIRED', message: REPLAY_MESSAGE_SHORT } });
      expect(origins).toEqual(['unique_violation']);
      expect(await count('order')).toBe(1);
    });

    it('a bare false keeps the engine\'s generic refusal bytes (422 LEGAL_ACCEPTANCE_REQUIRED)', async () => {
      registerPaymentPolicy(policy());
      const reqBody = { ...base, extensions: EXT_BODY };
      await post(reqBody, { 'idempotency-key': 'idem-d3-false' });
      replayAllowed = false;
      const res = await post(reqBody, { 'idempotency-key': 'idem-d3-false' });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: { code: 'LEGAL_ACCEPTANCE_REQUIRED', message: 'checkout replay refused by payment policy' } });
    });

    it('a refusal may choose its own code, status and extras', async () => {
      registerPaymentPolicy(policy({
        async checkoutReplayAllowed() { return { allow: false, message: 'owner only', code: 'OWNER_ONLY', status: 409, extra: { reason: 'owner' } }; },
      }));
      const reqBody = { ...base, extensions: EXT_BODY };
      await post(reqBody, { 'idempotency-key': 'idem-d3-custom' });
      const res = await post(reqBody, { 'idempotency-key': 'idem-d3-custom' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ reason: 'owner', error: { code: 'OWNER_ONLY', message: 'owner only' } });
    });
  });

  describe('D4/D5/D8 — a policy replaces the applied promotion with a fixed merchandise discount', () => {
    const upgradeBody = { ...base, extensions: EXT_BODY };

    it('exclusive tax: discount, tax, grand total, line discount and line total are recomputed and persisted', async () => {
      await setStore(1000, false);
      registerPaymentPolicy(replacingPolicy());
      const res = await post(upgradeBody);
      expect(res.status).toBe(200);
      const body = await res.json() as { code: string };
      // 4900 - 1900 = 3000 taxed at 10% = 300; the credit is a discount, taxed like any promotion.
      expect(body).toEqual({ code: expect.any(String), state: 'PendingPayment', grandTotal: 3300, discountTotal: 1900, currency: 'USD', couponApplied: false, giftCardApplied: 0, receiptToken: expect.any(String), pointsRedeemed: 0, pointsDiscount: 0 });
      expect(await orderRow(body.code)).toMatchObject({ subtotal: 4900, discount_total: 1900, shipping_total: 0, tax_total: 300, grand_total: 3300, promotion_id: null });
      expect(await lineRows(body.code)).toEqual([{ quantity: 1, unit_price: 4900, line_subtotal: 4900, line_discount: 1900, line_tax: 0, line_total: 3000 }]);
      expect(await count('order_adjustment')).toBe(0);
    });

    it('inclusive tax: the tax is extracted from the discounted merchandise and the amount due is the discounted price', async () => {
      await setStore(1000, true);
      registerPaymentPolicy(replacingPolicy());
      const res = await post(upgradeBody);
      expect(res.status).toBe(200);
      const body = await res.json() as { code: string };
      // 3000 includes tax: 3000 - round(3000 * 10000 / 11000) = 273.
      expect(body).toEqual({ code: expect.any(String), state: 'PendingPayment', grandTotal: 3000, discountTotal: 1900, currency: 'USD', couponApplied: false, giftCardApplied: 0, receiptToken: expect.any(String), pointsRedeemed: 0, pointsDiscount: 0 });
      expect(await orderRow(body.code)).toMatchObject({ subtotal: 4900, discount_total: 1900, tax_total: 273, grand_total: 3000, promotion_id: null });
      expect(await lineRows(body.code)).toEqual([{ quantity: 1, unit_price: 4900, line_subtotal: 4900, line_discount: 1900, line_tax: 0, line_total: 3000 }]);
    });

    it('the order-adjustment result is unchanged (untaxed, discount stays 0): the contrast case at the same tax rate', async () => {
      await setStore(1000, false);
      registerPaymentPolicy(policy({ async onCheckoutOrder() { return { priceAdjustment: { code: 'test.credit', label: 'Partner credit', amount: -1900 } }; } }));
      const res = await post({ ...base, extensions: EXT_BODY });
      const body = await res.json() as { code: string; grandTotal: number; discountTotal: number };
      expect(body.grandTotal).toBe(4900 + 490 - 1900);
      expect(body.discountTotal).toBe(0);
      expect(await orderRow(body.code)).toMatchObject({ discount_total: 0, tax_total: 490, grand_total: 3490 });
      expect(await lineRows(body.code)).toEqual([{ quantity: 1, unit_price: 4900, line_subtotal: 4900, line_discount: 0, line_tax: 0, line_total: 4900 }]);
    });

    it('a replacement and an adjustment compose: the adjustment is applied on top of the replaced totals', async () => {
      await setStore(1000, false);
      registerPaymentPolicy(replacingPolicy({
        async onCheckoutOrder(_tx, i) {
          return { replacePromotion: { fixedDiscount: i.lines[0]!.unitPrice - UPGRADE_PRICE }, priceAdjustment: { code: 'test.fee', label: 'Fee', amount: 100 } };
        },
      }));
      const body = await (await post(upgradeBody)).json() as { code: string; grandTotal: number };
      expect(body.grandTotal).toBe(3300 + 100);
      expect(await orderRow(body.code)).toMatchObject({ discount_total: 1900, tax_total: 300, grand_total: 3400 });
    });

    it('a fixed discount of 0 still displaces the promotion (the fork cleared it even when the price already matched)', async () => {
      await setStore(1000, false);
      await addPromotion(null, 10);
      registerPaymentPolicy(policy({ async onCheckoutOrder() { return { replacePromotion: { fixedDiscount: 0 } }; } }));
      const body = await (await post(upgradeBody)).json() as { code: string; discountTotal: number; grandTotal: number; couponApplied: boolean };
      expect(body).toMatchObject({ discountTotal: 0, grandTotal: 4900 + 490, couponApplied: false });
      expect(await promotionStats()).toEqual({ usage: 0, usedCount: 0 });
    });

    it('the loyalty earn snapshot is recomputed on the replaced totals before settlement', async () => {
      await setStore(1000, false, { loyalty: { enabled: true, earnRatePerDollar: 10, pointsPerDollarOff: 10, minRedeemPoints: 0, maxRedeemPercentOfSubtotal: null, expiryDays: null } });
      const token = await signedInCustomer();
      registerPaymentPolicy(replacingPolicy());
      const res = await post(upgradeBody, { authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      const code = (await res.json() as { code: string }).code;
      // Earn base is the merchandise after the replacement: 4900 - 1900 = 3000 -> floor(3000 * 10 / 100) = 300 (the full price would earn 490).
      expect((await orderRow(code)).metadata.loyalty).toMatchObject({ redeemPoints: 0, pointsDiscount: 0, earnPoints: 300 });
    });

    it('inclusive tax: the earn base has the item tax removed from the replaced merchandise', async () => {
      await setStore(1000, true, { loyalty: { enabled: true, earnRatePerDollar: 10, pointsPerDollarOff: 10, minRedeemPoints: 0, maxRedeemPercentOfSubtotal: null, expiryDays: null } });
      const token = await signedInCustomer();
      registerPaymentPolicy(replacingPolicy());
      const code = (await (await post(upgradeBody, { authorization: `Bearer ${token}` })).json() as { code: string }).code;
      // round(3000 * 10000 / 11000) = 2727 -> floor(2727 * 10 / 100) = 272.
      expect((await orderRow(code)).metadata.loyalty).toMatchObject({ earnPoints: 272 });
    });

    it('a points redemption is re-planned against the replaced discountable base (cap and points follow the new total)', async () => {
      await setStore(0, false, { loyalty: { enabled: true, earnRatePerDollar: 10, pointsPerDollarOff: 10, minRedeemPoints: 0, maxRedeemPercentOfSubtotal: 50, expiryDays: null } });
      const token = await signedInCustomer();
      await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO loyalty_ledger (store_id, customer_id, kind, points, reason) VALUES (${STORE}, ${CUSTOMER}, 'adjust', 1000, 'test')`));
      registerPaymentPolicy(replacingPolicy());
      const res = await post({ ...upgradeBody, redeemPoints: 250 }, { authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      const body = await res.json() as { code: string };
      // Against the full 4900 the 50% cap would allow 2450 cents (245 points); against the replaced 3000 it allows 1500 cents (150 points).
      expect(body).toEqual({ code: expect.any(String), state: 'PendingPayment', grandTotal: 1500, discountTotal: 3400, currency: 'USD', couponApplied: false, giftCardApplied: 0, receiptToken: expect.any(String), pointsRedeemed: 150, pointsDiscount: 1500 });
      const row = await orderRow(body.code);
      expect(row).toMatchObject({ discount_total: 3400, grand_total: 1500 });
      expect(row.metadata.loyalty).toMatchObject({ redeemPoints: 150, pointsDiscount: 1500, earnPoints: 150 });
      const redeem = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT points FROM loyalty_ledger WHERE store_id = ${STORE} AND kind = 'redeem'`)).rows as Array<{ points: number }>);
      expect(redeem).toEqual([{ points: -150 }]);
      expect(await lineRows(body.code)).toEqual([{ quantity: 1, unit_price: 4900, line_subtotal: 4900, line_discount: 3400, line_tax: 0, line_total: 1500 }]);
    });

    it('two policies replacing the promotion is a composition failure and persists nothing', async () => {
      registerPaymentPolicy(replacingPolicy());
      registerPaymentPolicy({ ...replacingPolicy(), id: 'checkout-test-2', checkoutExtensions: undefined });
      const res = await post({ ...base, extensions: EXT_BODY });
      expect(res.status).toBe(500);
      expect(await count('order')).toBe(0);
    });

    it('a negative discount fails closed', async () => {
      registerPaymentPolicy(policy({ async onCheckoutOrder() { return { replacePromotion: { fixedDiscount: -1 } }; } }));
      expect((await post({ ...base, extensions: EXT_BODY })).status).toBe(500);
      expect(await count('order')).toBe(0);
    });

    describe('D8 — no promotion attribution or usage', () => {
      it('no policy: an automatic promotion is attributed, recorded and counted (unchanged baseline)', async () => {
        await setStore(1000, false);
        await addPromotion(null, 10);
        const res = await post(base);
        const body = await res.json() as { code: string };
        expect(body).toEqual({ code: expect.any(String), state: 'PendingPayment', grandTotal: 4851, discountTotal: 490, currency: 'USD', couponApplied: true, giftCardApplied: 0, receiptToken: expect.any(String), pointsRedeemed: 0, pointsDiscount: 0 });
        expect(await orderRow(body.code)).toMatchObject({ discount_total: 490, tax_total: 441, grand_total: 4851 });
        expect((await orderRow(body.code)).promotion_id).not.toBeNull();
        expect(await promotionStats()).toEqual({ usage: 1, usedCount: 1 });
      });

      it('a replaced automatic promotion leaves no promotionId, no usage row and no used_count increment; couponApplied is false', async () => {
        await setStore(1000, false);
        await addPromotion(null, 10);
        registerPaymentPolicy(replacingPolicy());
        const res = await post(upgradeBody);
        const body = await res.json() as { code: string };
        expect(body).toEqual({ code: expect.any(String), state: 'PendingPayment', grandTotal: 3300, discountTotal: 1900, currency: 'USD', couponApplied: false, giftCardApplied: 0, receiptToken: expect.any(String), pointsRedeemed: 0, pointsDiscount: 0 });
        expect((await orderRow(body.code)).promotion_id).toBeNull();
        expect(await promotionStats()).toEqual({ usage: 0, usedCount: 0 });
      });

      it('a replaced coded coupon is likewise not attributed or counted', async () => {
        await setStore(1000, false);
        await addPromotion('SAVE20', 20);
        registerPaymentPolicy(replacingPolicy());
        const res = await post({ ...upgradeBody, couponCode: 'SAVE20' });
        const body = await res.json() as { code: string; couponApplied: boolean; discountTotal: number };
        expect(body).toMatchObject({ couponApplied: false, discountTotal: 1900 });
        expect((await orderRow(body.code)).promotion_id).toBeNull();
        expect(await promotionStats()).toEqual({ usage: 0, usedCount: 0 });
      });

      it('the replay of a replaced order derives couponApplied from its stored discount (fork parity) and repeats the same totals', async () => {
        await setStore(1000, false);
        registerPaymentPolicy(replacingPolicy());
        const first = await (await post(upgradeBody, { 'idempotency-key': 'idem-d8-replay' })).json() as { code: string; grandTotal: number; discountTotal: number; couponApplied: boolean };
        expect(first.couponApplied).toBe(false);
        const again = await (await post(upgradeBody, { 'idempotency-key': 'idem-d8-replay' })).json() as { code: string; grandTotal: number; discountTotal: number; couponApplied: boolean; replay: boolean };
        expect(again).toMatchObject({ code: first.code, grandTotal: 3300, discountTotal: 1900, couponApplied: true });
      });
    });
  });

  describe('D6 — request intent is visible and eligibility runs before loyalty', () => {
    const eligibilitySeen: { intent?: CheckoutRequestIntent; customer?: unknown; lines?: unknown; extensions?: unknown } = {};
    const orderSeen: { intent?: CheckoutRequestIntent } = {};
    beforeEach(() => { eligibilitySeen.intent = undefined; eligibilitySeen.customer = undefined; eligibilitySeen.lines = undefined; eligibilitySeen.extensions = undefined; orderSeen.intent = undefined; });

    /** Refuses any request that names a coupon, a gift card or points (the fork's eligibility predicate). */
    const noDiscountsPolicy = (): PaymentPolicy => policy({
      async checkoutEligibility(_tx, i) {
        eligibilitySeen.intent = i.intent; eligibilitySeen.customer = i.customer; eligibilitySeen.lines = i.lines; eligibilitySeen.extensions = i.extensions;
        return i.intent.couponCode || i.intent.giftCardCode || i.intent.redeemPoints
          ? { ok: false, refusal: { status: 422, code: 'LEGAL_ACCEPTANCE_REQUIRED', message: REFUSAL_MESSAGE } }
          : { ok: true };
      },
      async onCheckoutOrder(_tx, i) { orderSeen.intent = i.intent; return {}; },
    });

    it('the eligibility hook receives the lines, the validated extension block and no customer for a guest', async () => {
      registerPaymentPolicy(noDiscountsPolicy());
      const res = await post({ ...base, extensions: EXT_BODY });
      expect(res.status).toBe(200);
      expect(eligibilitySeen.customer).toBeNull();
      expect(eligibilitySeen.extensions).toEqual({ sourceId: 'LIC-1' });
      expect(eligibilitySeen.lines).toEqual([{ variantId: VARIANT, sku: SKU, productId: PRODUCT, quantity: 1, unitPrice: PRICE }]);
    });

    it('a valid gift card that would fund and settle the order is refused: 422, no order, balance untouched', async () => {
      registerPaymentPolicy(noDiscountsPolicy());
      const res = await post({ ...base, giftCardCode: GIFT_CODE, extensions: EXT_BODY });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: { code: 'LEGAL_ACCEPTANCE_REQUIRED', message: REFUSAL_MESSAGE } });
      expect(eligibilitySeen.intent).toEqual({ giftCardCode: GIFT_CODE });
      expect(await count('order')).toBe(0);
      expect(await giftCardBalance()).toBe(100000);
    });

    it('an unknown gift card code is still refused (the intent is what was sent, not what applied)', async () => {
      registerPaymentPolicy(noDiscountsPolicy());
      const res = await post({ ...base, giftCardCode: 'GC-DOES-NOT-EXIST', extensions: EXT_BODY });
      expect(res.status).toBe(422);
      expect(eligibilitySeen.intent).toEqual({ giftCardCode: 'GC-DOES-NOT-EXIST' });
      expect(await count('order')).toBe(0);
    });

    it('a coupon string that matches no promotion is refused', async () => {
      registerPaymentPolicy(noDiscountsPolicy());
      const res = await post({ ...base, couponCode: 'NO-SUCH-COUPON', extensions: EXT_BODY });
      expect(res.status).toBe(422);
      expect(eligibilitySeen.intent).toEqual({ couponCode: 'NO-SUCH-COUPON' });
      expect(await count('order')).toBe(0);
    });

    it('a points request is refused by the policy before loyalty processing can answer 409 LOYALTY_REDEEM_FAILED', async () => {
      // Control: with the program disabled and no eligibility hook the loyalty step answers.
      registerPaymentPolicy(policy());
      const control = await post({ ...base, redeemPoints: 100, extensions: EXT_BODY });
      expect(control.status).toBe(409);
      expect(((await control.json()) as { error: { code: string } }).error.code).toBe('LOYALTY_REDEEM_FAILED');
      _resetPaymentPoliciesForTests();

      registerPaymentPolicy(noDiscountsPolicy());
      const res = await post({ ...base, redeemPoints: 100, extensions: EXT_BODY });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: { code: 'LEGAL_ACCEPTANCE_REQUIRED', message: REFUSAL_MESSAGE } });
      expect(eligibilitySeen.intent).toEqual({ redeemPoints: 100 });
      expect(await count('order')).toBe(0);
    });

    it('onCheckoutOrder sees the same intent as sent, including a gift card and a coupon that did not apply', async () => {
      registerPaymentPolicy(policy({ async onCheckoutOrder(_tx, i) { orderSeen.intent = i.intent; return {}; } }));
      const res = await post({ ...base, couponCode: 'NO-SUCH-COUPON', giftCardCode: 'GC-DOES-NOT-EXIST', extensions: EXT_BODY });
      expect(res.status).toBe(200);
      expect(orderSeen.intent).toEqual({ couponCode: 'NO-SUCH-COUPON', giftCardCode: 'GC-DOES-NOT-EXIST' });
    });

    it('a request with none of them passes eligibility and the checkout is unchanged', async () => {
      registerPaymentPolicy(noDiscountsPolicy());
      const res = await post({ ...base, extensions: EXT_BODY });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { grandTotal: number }).grandTotal).toBe(PRICE);
      expect(orderSeen.intent).toEqual({});
    });

    it('a signed-in customer reaches the eligibility hook', async () => {
      const token = await signedInCustomer();
      registerPaymentPolicy(noDiscountsPolicy());
      const res = await post({ ...base, extensions: EXT_BODY }, { authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      expect(eligibilitySeen.customer).toEqual({ id: CUSTOMER, email: 'member@example.com', emailVerified: true });
    });

    it('a throwing eligibility hook is 409 PAYMENT_POLICY_UNAVAILABLE and persists nothing', async () => {
      registerPaymentPolicy(policy({ async checkoutEligibility() { throw new Error('boom'); } }));
      const res = await post({ ...base, extensions: EXT_BODY });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PAYMENT_POLICY_UNAVAILABLE');
      expect(await count('order')).toBe(0);
    });
  });

  describe('D9 — legacy fingerprint candidates', () => {
    const sha = (v: string) => createHash('sha256').update(v).digest('hex');
    const LEGACY_A = sha('legacy-order-a');
    const calls: Array<{ origin: string; request: CheckoutFingerprintBasis; extensions: unknown; orderId: string }> = [];
    let candidate: string | null = null;
    const legacyPolicy = (over: Partial<PaymentPolicy> = {}): PaymentPolicy => policy({
      async legacyCheckoutFingerprint(_tx, i) {
        calls.push({ origin: i.origin, request: i.request, extensions: i.extensions, orderId: i.existingOrder.id });
        return candidate;
      },
      ...over,
    });
    beforeEach(() => { calls.length = 0; candidate = null; });

    it('fingerprintMatches accepts a candidate only by exact equality with the stored value; no stored value always replays', () => {
      expect(fingerprintMatches({ checkoutFingerprint: 'a' }, 'a')).toBe(true);
      expect(fingerprintMatches({ checkoutFingerprint: 'a' }, 'b')).toBe(false);
      expect(fingerprintMatches({ checkoutFingerprint: 'a' }, 'b', ['c'])).toBe(false);
      expect(fingerprintMatches({ checkoutFingerprint: 'a' }, 'b', ['c', 'a'])).toBe(true);
      expect(fingerprintMatches({}, 'b', [])).toBe(true);
      expect(fingerprintMatches(null, 'b')).toBe(true);
    });

    async function storedFingerprint(code: string): Promise<string> {
      return (await orderRow(code)).metadata.checkoutFingerprint as string;
    }
    async function setStoredFingerprint(code: string, fp: string): Promise<void> {
      await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET metadata = jsonb_set(metadata, '{checkoutFingerprint}', to_jsonb(${fp}::text)) WHERE store_id = ${STORE} AND code = ${code}`));
    }

    it('a stored legacy fingerprint replays when the policy supplies it; without a candidate the same retry is a payload mismatch', async () => {
      registerPaymentPolicy(legacyPolicy());
      const reqBody = { ...base, extensions: EXT_BODY };
      const first = await (await post(reqBody, { 'idempotency-key': 'idem-d9-a' })).json() as { code: string };
      await setStoredFingerprint(first.code, LEGACY_A);

      candidate = null;
      const mismatch = await post(reqBody, { 'idempotency-key': 'idem-d9-a' });
      expect(mismatch.status).toBe(409);
      expect(((await mismatch.json()) as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');

      candidate = LEGACY_A;
      const replay = await post(reqBody, { 'idempotency-key': 'idem-d9-a' });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ code: first.code });
      // Never erased or waived: the stored fingerprint is exactly what it was.
      expect(await storedFingerprint(first.code)).toBe(LEGACY_A);
      expect(await count('order')).toBe(1);
    });

    it('the candidate is accepted only for the matching stored order: another order\'s mismatch stays a 409', async () => {
      registerPaymentPolicy(legacyPolicy());
      const reqA = { ...base, extensions: EXT_BODY };
      const reqB = { items: [{ sku: SKU, quantity: 1 }], email: 'other@example.com', extensions: { [POLICY_ID]: { sourceId: 'LIC-2' } } };
      const a = await (await post(reqA, { 'idempotency-key': 'idem-d9-wrong-a' })).json() as { code: string };
      const b = await (await post(reqB, { 'idempotency-key': 'idem-d9-wrong-b' })).json() as { code: string };
      await setStoredFingerprint(a.code, LEGACY_A);
      const storedB = await storedFingerprint(b.code);
      candidate = LEGACY_A; // derived for order A only

      // Order B replayed with a changed payload: normal fingerprint differs from B's, and A's candidate is not B's stored value.
      const changed = await post({ ...reqB, email: 'changed@example.com' }, { 'idempotency-key': 'idem-d9-wrong-b' });
      expect(changed.status).toBe(409);
      expect(((await changed.json()) as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
      expect(await storedFingerprint(b.code)).toBe(storedB);

      // Order A with its own candidate still replays.
      expect((await post(reqA, { 'idempotency-key': 'idem-d9-wrong-a' })).status).toBe(200);
    });

    it('a candidate that equals neither stored value does not waive the comparison', async () => {
      registerPaymentPolicy(legacyPolicy());
      const reqBody = { ...base, extensions: EXT_BODY };
      const first = await (await post(reqBody, { 'idempotency-key': 'idem-d9-bad' })).json() as { code: string };
      await setStoredFingerprint(first.code, LEGACY_A);
      candidate = sha('something else');
      expect((await post(reqBody, { 'idempotency-key': 'idem-d9-bad' })).status).toBe(409);
    });

    it('the policy authorizes first: a refused replay never reaches the legacy hook and learns nothing about the fingerprint', async () => {
      registerPaymentPolicy(legacyPolicy());
      const reqBody = { ...base, extensions: EXT_BODY };
      const first = await (await post(reqBody, { 'idempotency-key': 'idem-d9-order' })).json() as { code: string };
      await setStoredFingerprint(first.code, LEGACY_A);
      candidate = LEGACY_A;
      replayAllowed = false;
      const res = await post(reqBody, { 'idempotency-key': 'idem-d9-order' });
      expect(res.status).toBe(422);
      expect(calls).toEqual([]);
    });

    it('the hook is not consulted when the normal fingerprint matches, nor at the converted-cart site', async () => {
      registerPaymentPolicy(legacyPolicy());
      const reqBody = { ...base, extensions: EXT_BODY };
      await post(reqBody, { 'idempotency-key': 'idem-d9-normal' });
      expect((await post(reqBody, { 'idempotency-key': 'idem-d9-normal' })).status).toBe(200);
      expect(calls).toEqual([]);

      const cartRes = await app.request('/v1/shop/cart', { method: 'POST', headers: hdr(), body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }] }) });
      const { token, revision } = await cartRes.json() as { token: string; revision: number };
      const cartBody = { ...base, cartToken: token, expectedRevision: revision, extensions: EXT_BODY };
      await post(cartBody);
      expect((await post(cartBody)).status).toBe(200);
      expect(calls).toEqual([]);
    });

    it('a policy with only a legacy hook still decides replays under the stored order\'s lock set', async () => {
      registerPaymentPolicy(legacyPolicy({ checkoutReplayAllowed: undefined }));
      const reqBody = { ...base, extensions: EXT_BODY };
      const first = await (await post(reqBody, { 'idempotency-key': 'idem-d9-only' })).json() as { code: string };
      await setStoredFingerprint(first.code, LEGACY_A);
      candidate = LEGACY_A;
      const res = await post(reqBody, { 'idempotency-key': 'idem-d9-only' });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.origin).toBe('idempotency_key');
    });

    it('the policy receives the complete normalized request; hashing it with the extensions reproduces the engine fingerprint', async () => {
      registerPaymentPolicy(legacyPolicy());
      const reqBody = { ...base, shippingAddress: { streetLine1: '1 Main', city: 'X', countryCode: 'US' }, extensions: EXT_BODY };
      const first = await (await post(reqBody, { 'idempotency-key': 'idem-d9-basis' })).json() as { code: string };
      const stored = await storedFingerprint(first.code);
      await setStoredFingerprint(first.code, LEGACY_A);
      candidate = LEGACY_A;
      await post(reqBody, { 'idempotency-key': 'idem-d9-basis' });
      const request = calls[0]!.request;
      expect(Object.keys(request)).toEqual(['v', 'cartToken', 'items', 'couponCode', 'giftCardCode', 'shippingMethodCode', 'email', 'shippingAddress', 'billingAddress', 'legalAcceptance']);
      expect(request).toEqual({
        v: 1, cartToken: null, items: [{ sku: SKU, quantity: 1 }], couponCode: null, giftCardCode: null, shippingMethodCode: null, email: 'buyer@example.com',
        shippingAddress: { fullName: null, line1: '1 Main', line2: null, city: 'X', province: null, postalCode: null, country: 'US', phone: null },
        billingAddress: null, legalAcceptance: null,
      });
      expect(calls[0]!.extensions).toEqual({ sourceId: 'LIC-1' });
      expect(createHash('sha256').update(JSON.stringify({ ...request, extensions: { [POLICY_ID]: { sourceId: 'LIC-1' } } })).digest('hex')).toBe(stored);
    });

    it('the unique-violation replay passes origin unique_violation', async () => {
      const gate = holdUntilOtherRequestWaits();
      registerPaymentPolicy(legacyPolicy({ async onCheckoutOrder() { await gate(); return {}; } }));
      const reqBody = { ...base, extensions: EXT_BODY };
      // The payloads differ, so whichever request loses the race fails the normal fingerprint comparison against the
      // winner's stored one and reaches the legacy hook with origin unique_violation (no candidate: still a mismatch).
      const [a, b] = await Promise.all([post(reqBody, { 'idempotency-key': 'idem-d9-race' }), post({ ...reqBody, email: 'racer@example.com' }, { 'idempotency-key': 'idem-d9-race' })]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(calls.map((c) => c.origin)).toEqual(['unique_violation']);
    });
  });

  // Discount-dependent checks (shipping eligibility on a discounted basis, loyalty redemption) are decided against the
  // EFFECTIVE promotion: the replacement when a policy replaces it, otherwise the one that applied. The upgrade price is 3000 of 4900.
  describe('promotion replacement decides discount-dependent shipping eligibility and loyalty redemption', () => {
    const PHYS_VARIANT = 'cccccccc-3333-3333-3333-3333333333b4';
    const PHYS_SKU = 'POLICY-PHYS-1';
    const shipBody = { items: [{ sku: PHYS_SKU, quantity: 1 }], email: 'buyer@example.com', shippingMethodCode: 'std', extensions: EXT_BODY };

    async function seedPhysical(calculator: Record<string, unknown>): Promise<void> {
      await withStore(STORE, async (tx) => {
        await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type)
          VALUES (${PHYS_VARIANT}, ${STORE}, ${PRODUCT}, ${PHYS_SKU}, 'Policy Physical', ${PRICE}, 'physical')`);
        await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${PHYS_VARIANT}, ${STORE}, 100, 0)`);
        await tx.execute(sql`INSERT INTO shipping_method (id, store_id, code, name, calculator, enabled)
          VALUES (gen_random_uuid(), ${STORE}, 'std', 'Standard', ${JSON.stringify({ flat: 0, subtotalBasis: 'discounted_with_tax', ...calculator })}::jsonb, true)`);
      });
    }
    const noReplacement = () => policy({ async onCheckoutOrder() { return {}; } });
    // A request with no policy registered must not carry a policy extension block (the engine refuses unknown extensions).
    const noExt = <T extends { extensions?: unknown }>(b: T) => { const { extensions: _drop, ...rest } = b; return rest; };
    const replaceWith = (fixedDiscount: number) => policy({ async onCheckoutOrder() { return { replacePromotion: { fixedDiscount } }; } });
    const notEligible = { error: { code: 'SHIPPING_UNAVAILABLE' }, reason: 'not_eligible' };

    it('a replacement that drops the discounted total below the minimum rejects a method the displaced promotion qualified', async () => {
      await seedPhysical({ min: 4000 });
      expect((await post(noExt(shipBody))).status).toBe(200); // control, no policy: 4900 >= 4000
      await wipe(); await seed(); invalidateStoreCache(); await seedPhysical({ min: 4000 });
      registerPaymentPolicy(replacingPolicy());
      const res = await post(shipBody);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject(notEligible);
      expect(await count('order')).toBe(0);
    });

    it('a replacement that lifts the discounted total over the minimum grants a method the displaced promotion disqualified', async () => {
      await seedPhysical({ min: 3000 });
      await addPromotion(null, 60); // 4900 -> 1960 < 3000
      const control = await post(noExt(shipBody));
      expect(control.status).toBe(409);
      expect(await control.json()).toMatchObject(notEligible);
      registerPaymentPolicy(replacingPolicy()); // effective total 3000 >= 3000
      const res = await post(shipBody);
      expect(res.status).toBe(200);
      const code = (await res.json() as { code: string }).code;
      expect(await orderRow(code)).toMatchObject({ discount_total: 1900, shipping_total: 0, grand_total: 3000, promotion_id: null });
    });

    it('a replacement that brings the discounted total under the maximum grants a method the displaced promotion disqualified', async () => {
      await seedPhysical({ max: 3500 });
      const control = await post(noExt(shipBody)); // no promotion: 4900 > 3500
      expect(control.status).toBe(409);
      expect(await control.json()).toMatchObject(notEligible);
      registerPaymentPolicy(replacingPolicy());
      expect((await post(shipBody)).status).toBe(200); // 3000 <= 3500
    });

    it('a replacement that pushes the discounted total over the maximum rejects a method the displaced promotion qualified', async () => {
      await seedPhysical({ max: 3500 });
      await addPromotion(null, 60); // 1960 <= 3500
      expect((await post(noExt(shipBody))).status).toBe(200); // control
      await wipe(); await seed(); invalidateStoreCache(); await seedPhysical({ max: 3500 }); await addPromotion(null, 60);
      registerPaymentPolicy(replaceWith(0)); // price stays 4900 > 3500
      const res = await post(shipBody);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject(notEligible);
      expect(await count('order')).toBe(0);
    });

    it('a policy that does not replace keeps the preliminary rejection', async () => {
      await seedPhysical({ min: 3000 });
      await addPromotion(null, 60);
      registerPaymentPolicy(noReplacement());
      const res = await post(shipBody);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject(notEligible);
    });

    it('a pre-discount basis is unaffected by a replacement: the rejection stands', async () => {
      await seedPhysical({ min: 6000, subtotalBasis: 'pre_discount' });
      registerPaymentPolicy(replaceWith(0));
      const res = await post(shipBody);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject(notEligible);
    });

    describe('loyalty redemption', () => {
      const loyaltyCfg = (minRedeemPoints: number) => ({ loyalty: { enabled: true, earnRatePerDollar: 10, pointsPerDollarOff: 10, minRedeemPoints, maxRedeemPercentOfSubtotal: null, expiryDays: null } });
      const redeemBody = (points: number) => ({ ...base, extensions: EXT_BODY, redeemPoints: points });
      async function member(): Promise<{ authorization: string }> {
        const token = await signedInCustomer();
        await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO loyalty_ledger (store_id, customer_id, kind, points, reason) VALUES (${STORE}, ${CUSTOMER}, 'adjust', 1000, 'test')`));
        return { authorization: `Bearer ${token}` };
      }
      async function redeemRows(): Promise<Array<{ points: number }>> {
        return withStore(STORE, async (tx) => (await tx.execute(sql`SELECT points FROM loyalty_ledger WHERE store_id = ${STORE} AND kind = 'redeem'`)).rows as Array<{ points: number }>);
      }
      const rejected = (reason: string) => ({ error: { code: 'LOYALTY_REDEEM_FAILED' }, reason });

      it('nothing_to_discount before the replacement becomes a valid redemption after it', async () => {
        await setStore(0, false, loyaltyCfg(0));
        await addPromotion(null, 100); // discountable 0 -> nothing_to_discount
        const auth = await member();
        const control = await post(noExt(redeemBody(250)), auth);
        expect(control.status).toBe(409);
        expect(await control.json()).toMatchObject(rejected('nothing_to_discount'));
        registerPaymentPolicy(replacingPolicy()); // discountable 3000: 250 points buy 2500
        const res = await post(redeemBody(250), auth);
        expect(res.status).toBe(200);
        const body = await res.json() as { code: string };
        expect(body).toMatchObject({ pointsRedeemed: 250, pointsDiscount: 2500, discountTotal: 1900 + 2500, grandTotal: 500, couponApplied: false });
        expect((await orderRow(body.code)).metadata.loyalty).toMatchObject({ redeemPoints: 250, pointsDiscount: 2500 });
        expect(await redeemRows()).toEqual([{ points: -250 }]);
      });

      it('below_minimum before the replacement becomes a valid redemption after it', async () => {
        await setStore(0, false, loyaltyCfg(200));
        await addPromotion(null, 96); // discountable 196 -> 20 points < 200 minimum
        const auth = await member();
        const control = await post(noExt(redeemBody(250)), auth);
        expect(control.status).toBe(409);
        expect(await control.json()).toMatchObject(rejected('below_minimum'));
        registerPaymentPolicy(replacingPolicy());
        const res = await post(redeemBody(250), auth);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ pointsRedeemed: 250, pointsDiscount: 2500 });
        expect(await redeemRows()).toEqual([{ points: -250 }]);
      });

      it('a preliminary rejection that the replacement does not cure stays rejected, with no order and no ledger row', async () => {
        await setStore(0, false, loyaltyCfg(0));
        await addPromotion(null, 100);
        const auth = await member();
        registerPaymentPolicy(replaceWith(PRICE)); // replaced discountable is still 0
        const res = await post(redeemBody(250), auth);
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject(rejected('nothing_to_discount'));
        expect(await count('order')).toBe(0);
        expect(await redeemRows()).toEqual([]);
      });

      it('a policy that does not replace leaves the preliminary rejection standing', async () => {
        await setStore(0, false, loyaltyCfg(0));
        await addPromotion(null, 100);
        const auth = await member();
        registerPaymentPolicy(noReplacement());
        const res = await post(redeemBody(250), auth);
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject(rejected('nothing_to_discount'));
        expect(await count('order')).toBe(0);
      });

      it('the balance check is not deferred: a request above the balance is rejected even when the replacement would fit it', async () => {
        await setStore(0, false, loyaltyCfg(0));
        const auth = await member(); // balance 1000
        registerPaymentPolicy(replacingPolicy());
        const res = await post(redeemBody(2000), auth);
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject(rejected('insufficient_balance'));
        expect(await count('order')).toBe(0);
      });

      it('authentication is not deferred: a guest redemption is rejected before the policy hook runs', async () => {
        await setStore(0, false, loyaltyCfg(0));
        let hookRan = false;
        registerPaymentPolicy(policy({ async onCheckoutOrder() { hookRan = true; return { replacePromotion: { fixedDiscount: 1900 } }; } }));
        const res = await post(redeemBody(250));
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject(rejected('not_signed_in'));
        expect(hookRan).toBe(false);
      });
    });
  });

  it('with no policy registered the full row set is the same as before (totals, lines, no adjustment, no usage)', async () => {
    await setStore(1000, false);
    const res = await post(base);
    const body = await res.json() as { code: string };
    expect(body).toEqual({ code: expect.any(String), state: 'PendingPayment', grandTotal: 5390, discountTotal: 0, currency: 'USD', couponApplied: false, giftCardApplied: 0, receiptToken: expect.any(String), pointsRedeemed: 0, pointsDiscount: 0 });
    expect(await orderRow(body.code)).toMatchObject({ subtotal: 4900, discount_total: 0, shipping_total: 0, tax_total: 490, grand_total: 5390, promotion_id: null });
    expect(await lineRows(body.code)).toEqual([{ quantity: 1, unit_price: 4900, line_subtotal: 4900, line_discount: 0, line_tax: 0, line_total: 4900 }]);
    expect(await count('order_adjustment')).toBe(0);
    expect(await promotionStats()).toEqual({ usage: 0, usedCount: 0 });
  });
});

async function signedInCustomer(): Promise<string> {
  return withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, email_verified) VALUES (${CUSTOMER}, ${STORE}, 'member@example.com', true)`);
    return createSession(tx, STORE, CUSTOMER);
  });
}

/**
 * Returns a gate that resolves once another backend is blocked on a lock (the second request of a race), so the
 * request holding the gate commits only after the other has reached its conflicting write. Fails loudly instead of
 * passing vacuously if no waiter appears.
 */
function holdUntilOtherRequestWaits(): () => Promise<void> {
  let entered = 0;
  return async () => {
    entered++;
    if (entered > 1) return; // only the first request waits; the other is the one being waited for
    const deadline = Date.now() + 8000;
    for (;;) {
      const r = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      if ((r.rows[0] as { n: number }).n > 0) return;
      if (Date.now() > deadline) throw new Error('race not reproduced: no request ever blocked on a lock');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
}
