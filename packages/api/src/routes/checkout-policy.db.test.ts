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
import { cart } from './cart.js';
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
const FREE_VARIANT = 'cccccccc-3333-3333-3333-3333333333b2';
const FREE_SKU = 'POLICY-FREE-1';
const FREE_VARIANT_2 = 'cccccccc-3333-3333-3333-3333333333b3';
const FREE_SKU_2 = 'POLICY-FREE-2';
const GIFT_CODE = 'GC-POLICY';
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
