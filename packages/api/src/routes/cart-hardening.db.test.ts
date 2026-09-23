/**
 * DB integration tests for cart hardening (CART-01..CART-04) and the
 * per-store variant pricing parity fix.
 *
 *   CART-01  a cart converts to exactly ONE order — concurrent same-cart
 *            submissions, lost-response retries, and edit/checkout races all
 *            collapse onto a single order + a single stock/promotion effect.
 *            Idempotency-Key replay is bound to a request fingerprint: the
 *            same key with a changed payload is a 409, not a silent replay.
 *   CART-02  a converted cart is terminal — line/identity/merge mutations are
 *            rejected (never resurrected to 'active'), convertedOrderId is
 *            immutable, and a repeat checkout resumes the ORIGINAL order.
 *   CART-03  cart.revision is a monotonic optimistic-concurrency counter —
 *            mutations and conversion may pass expectedRevision; a stale base
 *            returns 409 + the current snapshot.
 *   Pricing  config.pricing.variantRule selects the effective-price rule
 *            ('preorder' = Damned Designs parity, 'sale' = Rotten Hand parity)
 *            and cart + checkout use the SAME selector.
 *
 * Runs against a dedicated *_test DB ONLY (these wipe data). vitest runs
 * files serially (fileParallelism: false). Mirrors checkout.route.test.ts
 * conventions: TRUNCATE store CASCADE wipe, seeds under withStore(),
 * x-store-slug header, real Hono handler via app.request().
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { clearLoginAttempts } from '../auth/rate-limit.js';
import { createSession } from '../auth/session.js';
import { invalidateStoreCache } from '../store-context.js';
import { createStoreAppRunner } from '../db/rls-test-utils.js';
import { cart } from './cart.js';
import { checkout } from './checkout.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`cart-hardening test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'bbbbbbbb-2222-2222-2222-222222222222';
const STORE_B = 'bbbbbbbb-3333-3333-3333-333333333333';
const SLUG = 'cart-hardening-test-store';
const SLUG_B = 'cart-hardening-test-store-b';
const PRODUCT = 'bbbbbbbb-2222-2222-2222-2222222222a1';
const VARIANT = 'bbbbbbbb-2222-2222-2222-2222222222b1';
const SKU = 'CH-SKU-1';
const PRICE = 5000;
const VARIANT_P = 'bbbbbbbb-2222-2222-2222-2222222222b2';
const SKU_P = 'CH-SKU-PHYS';
const SHIP_CODE = 'ch-flat';
const CUSTOMER = 'bbbbbbbb-2222-2222-2222-2222222222c1';

const app = new OpenAPIHono();
app.route('/', cart);
app.route('/', checkout);

// App-role pool: exercises FORCE ROW LEVEL SECURITY as the non-owner role.
const appPool = new Pool({ connectionString: env.DATABASE_URL_NONOWNER ?? env.DATABASE_URL });
const withStoreApp = createStoreAppRunner(appPool, { schema: s, casing: 'snake_case' });

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

async function seed(): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, tax_rate) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', 0) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, tax_rate) VALUES (${STORE_B}, ${SLUG_B}, ${SLUG_B}, 'USD', 0) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PRODUCT}, ${STORE}, 'ch-prod', 'CH Product', 'active') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type) VALUES (${VARIANT}, ${STORE}, ${PRODUCT}, ${SKU}, 'CH Variant', ${PRICE}, 'digital_download') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type) VALUES (${VARIANT_P}, ${STORE}, ${PRODUCT}, ${SKU_P}, 'CH Physical', ${PRICE}, 'physical') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT_P}, ${STORE}, 20, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 20, allocated = 0`);
    await tx.insert(s.shippingMethod).values({ storeId: STORE, code: SHIP_CODE, name: 'Flat', calculator: { flat: 0 }, enabled: true }).onConflictDoNothing();
    await tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (${CUSTOMER}, ${STORE}, 'ch-customer@example.com') ON CONFLICT (id) DO NOTHING`);
  });
  invalidateStoreCache();
}

beforeEach(async () => {
  clearLoginAttempts('unknown', 'checkout:unknown');
  await wipe();
  await seed();
});
afterAll(async () => {
  await wipe();
  await pool.end();
  await appPool.end();
});

const hdr = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-store-slug': SLUG, ...extra });

type CheckoutOpts = {
  items?: Array<{ sku: string; quantity: number }>;
  cartToken?: string;
  idemKey?: string;
  expectedRevision?: number;
  shippingMethodCode?: string;
  email?: string;
  couponCode?: string;
};

function checkoutReq(o: CheckoutOpts) {
  return app.request('/v1/shop/checkout', {
    method: 'POST',
    headers: hdr(o.idemKey ? { 'idempotency-key': o.idemKey } : {}),
    body: JSON.stringify({
      items: o.items ?? [{ sku: SKU, quantity: 1 }],
      ...(o.cartToken ? { cartToken: o.cartToken } : {}),
      ...(o.expectedRevision != null ? { expectedRevision: o.expectedRevision } : {}),
      ...(o.shippingMethodCode ? { shippingMethodCode: o.shippingMethodCode } : {}),
      ...(o.email ? { email: o.email } : {}),
      ...(o.couponCode ? { couponCode: o.couponCode } : {}),
    }),
  });
}

/** Create a persisted cart through the public route; returns token + revision. */
async function makeCart(items: Array<{ sku: string; quantity: number }>): Promise<{ token: string; revision: number }> {
  const res = await app.request('/v1/shop/cart', { method: 'POST', headers: hdr(), body: JSON.stringify({ items }) });
  expect(res.status).toBe(200);
  const body = await res.json() as { token: string; revision: number };
  return { token: body.token, revision: body.revision };
}

async function cartRowByToken(token: string) {
  return withStore(STORE, async (tx) => {
    const [row] = await tx.select().from(s.cart).where(eq(s.cart.token, token)).limit(1);
    return row ?? null;
  });
}

async function orderCount(): Promise<number> {
  // Must go through withStore: "order" has FORCE ROW LEVEL SECURITY and the
  // migration-owner pool role is NOT BYPASSRLS, so a bare pool.query() with no
  // app.current_store set sees zero rows regardless of what actually committed.
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT count(*)::int n FROM "order" WHERE store_id = ${STORE}`);
    return Number((r.rows[0] as { n: number }).n);
  });
}

async function allocatedPhysical(): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT allocated FROM stock WHERE variant_id = ${VARIANT_P}`);
    return Number((r.rows[0] as { allocated: number }).allocated);
  });
}

// ── CART-01: exactly one conversion ─────────────────────────────────────────
describe('CART-01: exactly one order per cart', () => {
  it('two concurrent checkouts on the same cart (different idempotency keys) produce ONE order', async () => {
    const { token, revision } = await makeCart([{ sku: SKU, quantity: 2 }]);
    const [a, b] = await Promise.all([
      checkoutReq({ cartToken: token, idemKey: 'race-key-a', expectedRevision: revision }),
      checkoutReq({ cartToken: token, idemKey: 'race-key-b', expectedRevision: revision }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ab = await a.json() as { code: string };
    const bb = await b.json() as { code: string };
    expect(ab.code).toBe(bb.code);
    expect(await orderCount()).toBe(1);
    const row = await cartRowByToken(token);
    expect(row!.status).toBe('converted');
  });

  it('two concurrent checkouts with NO idempotency key still produce ONE order', async () => {
    const { token, revision } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const [a, b] = await Promise.all([
      checkoutReq({ cartToken: token, expectedRevision: revision }),
      checkoutReq({ cartToken: token, expectedRevision: revision }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ab = await a.json() as { code: string };
    const bb = await b.json() as { code: string };
    expect(ab.code).toBe(bb.code);
    expect(await orderCount()).toBe(1);
  });

  it('concurrent same-cart checkouts reserve stock exactly once', async () => {
    const { token, revision } = await makeCart([{ sku: SKU_P, quantity: 3 }]);
    const [a, b] = await Promise.all([
      checkoutReq({ cartToken: token, shippingMethodCode: SHIP_CODE, expectedRevision: revision, items: [{ sku: SKU_P, quantity: 3 }] }),
      checkoutReq({ cartToken: token, shippingMethodCode: SHIP_CODE, expectedRevision: revision, items: [{ sku: SKU_P, quantity: 3 }] }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await orderCount()).toBe(1);
    // The loser must NOT reserve again — allocated reflects one conversion only.
    expect(await allocatedPhysical()).toBe(3);
  });

  it('a repeat checkout on a converted cart returns the SAME order (lost-response recovery)', async () => {
    const { token, revision } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const first = await checkoutReq({ cartToken: token, expectedRevision: revision });
    expect(first.status).toBe(200);
    const f = await first.json() as { code: string; receiptToken: string };

    // No idempotency key — the cart's converted state is what binds the retry.
    const second = await checkoutReq({ cartToken: token });
    expect(second.status).toBe(200);
    const sres = await second.json() as { code: string; receiptToken: string };
    expect(sres.code).toBe(f.code);
    expect(sres.receiptToken).toBe(f.receiptToken);
    expect(await orderCount()).toBe(1);
  });

  it('the SAME Idempotency-Key with a CHANGED payload is a 409 conflict, not a silent replay', async () => {
    const first = await checkoutReq({ items: [{ sku: SKU, quantity: 1 }], idemKey: 'fp-key-1' });
    expect(first.status).toBe(200);

    const changed = await checkoutReq({ items: [{ sku: SKU, quantity: 5 }], idemKey: 'fp-key-1' });
    expect(changed.status).toBe(409);

    // An identical retry still replays the original order.
    const same = await checkoutReq({ items: [{ sku: SKU, quantity: 1 }], idemKey: 'fp-key-1' });
    expect(same.status).toBe(200);
    expect(await orderCount()).toBe(1);
  });

  it('a concurrent line-edit racing the conversion never produces a second order', async () => {
    const { token, revision } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const [co, edit] = await Promise.all([
      checkoutReq({ cartToken: token, expectedRevision: revision }),
      app.request(`/v1/shop/cart/${token}/lines`, {
        method: 'PATCH', headers: hdr(), body: JSON.stringify({ lines: [{ sku: SKU, quantity: 4 }] }),
      }),
    ]);
    // The edit either won the row lock before conversion (200 — checkout's
    // base revision then goes stale and its first attempt conflicts) or lost
    // it (409 — cart already converted). Either outcome is consistent; a
    // stale-checkout 409 retries against the fresh revision, which is exactly
    // the recoverable path the contract is designed for.
    expect([200, 409]).toContain(edit.status);
    if (co.status === 409) {
      const fresh = await app.request(`/v1/shop/cart/${token}`, { headers: hdr() });
      const rev = (await fresh.json() as { revision: number }).revision;
      const retry = await checkoutReq({ cartToken: token, expectedRevision: rev });
      expect(retry.status).toBe(200);
    } else {
      expect(co.status).toBe(200);
    }
    expect(await orderCount()).toBe(1);
    const row = await cartRowByToken(token);
    expect(row!.status).toBe('converted');
    expect(row!.convertedOrderId).not.toBeNull();
  });
});

// ── CART-02: converted carts are terminal ───────────────────────────────────
describe('CART-02: a converted cart is terminal', () => {
  async function convertedCart(): Promise<{ token: string; orderCode: string }> {
    const { token, revision } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const res = await checkoutReq({ cartToken: token, expectedRevision: revision });
    expect(res.status).toBe(200);
    const body = await res.json() as { code: string };
    return { token, orderCode: body.code };
  }

  it('PATCH lines on a converted cart returns 409 and does NOT resurrect it to active', async () => {
    const { token } = await convertedCart();
    const res = await app.request(`/v1/shop/cart/${token}/lines`, {
      method: 'PATCH', headers: hdr(), body: JSON.stringify({ lines: [{ sku: SKU, quantity: 9 }] }),
    });
    expect(res.status).toBe(409);
    const row = await cartRowByToken(token);
    expect(row!.status).toBe('converted');
    expect(row!.convertedOrderId).not.toBeNull();
    // The line write must not have landed either.
    const lines = await withStore(STORE, (tx) => tx.select().from(s.cartLine).where(eq(s.cartLine.cartId, row!.id)));
    expect(lines.map((l) => l.quantity)).toEqual([1]);
  });

  it('PATCH identity (email capture) on a converted cart returns 409', async () => {
    const { token } = await convertedCart();
    const res = await app.request(`/v1/shop/cart/${token}`, {
      method: 'PATCH', headers: hdr(), body: JSON.stringify({ email: 'newmail@example.com' }),
    });
    expect(res.status).toBe(409);
    const row = await cartRowByToken(token);
    expect(row!.status).toBe('converted');
  });

  it('POST merge into a converted cart returns 409', async () => {
    const { token } = await convertedCart();
    const sessionToken = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
    const res = await app.request(`/v1/shop/cart/${token}/merge`, {
      method: 'POST', headers: hdr({ authorization: `Bearer ${sessionToken}` }),
    });
    expect(res.status).toBe(409);
    const row = await cartRowByToken(token);
    expect(row!.status).toBe('converted');
    expect(row!.customerId).toBeNull();
  });

  it('convertedOrderId is immutable — a second checkout keeps pointing at the original order', async () => {
    const { token, orderCode } = await convertedCart();
    const row1 = await cartRowByToken(token);
    const again = await checkoutReq({ cartToken: token });
    expect(again.status).toBe(200);
    const row2 = await cartRowByToken(token);
    expect(row2!.convertedOrderId).toBe(row1!.convertedOrderId);
    const order = await withStore(STORE, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.id, row2!.convertedOrderId!)).limit(1);
      return o!;
    });
    expect(order.code).toBe(orderCode);
  });

  it('new shopping after conversion uses a NEW cart (create is unaffected)', async () => {
    await convertedCart();
    const { token, revision } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const row = await cartRowByToken(token);
    expect(row!.status).toBe('active');
    expect(revision).toBeGreaterThanOrEqual(0);
  });
});

// ── CART-03: optimistic-concurrency revision ────────────────────────────────
describe('CART-03: cart revision stale-write protection', () => {
  it('cart responses carry a revision that bumps on every mutation', async () => {
    const { token, revision } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const res = await app.request(`/v1/shop/cart/${token}/lines`, {
      method: 'PATCH', headers: hdr(), body: JSON.stringify({ lines: [{ sku: SKU, quantity: 3 }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { revision: number };
    expect(body.revision).toBeGreaterThan(revision);
    const row = await cartRowByToken(token);
    expect(row!.revision).toBe(body.revision);
  });

  it('PATCH lines with a stale expectedRevision → 409 + current snapshot', async () => {
    const { token, revision } = await makeCart([{ sku: SKU, quantity: 1 }]);
    // Move the cart forward so `revision` is stale (expectedRevision present
    // → absolute-set semantics: the line becomes quantity 2, not 1+2).
    await app.request(`/v1/shop/cart/${token}/lines`, {
      method: 'PATCH', headers: hdr(), body: JSON.stringify({ lines: [{ sku: SKU, quantity: 2 }], expectedRevision: revision }),
    });
    const res = await app.request(`/v1/shop/cart/${token}/lines`, {
      method: 'PATCH', headers: hdr(), body: JSON.stringify({ lines: [{ sku: SKU, quantity: 7 }], expectedRevision: revision }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; revision: number; cart: { revision: number; lines: Array<{ quantity: number }> } };
    expect(body.revision).toBe(revision + 1);
    expect(body.cart.revision).toBe(revision + 1);
    // Snapshot reflects the committed cart (quantity 2), not the rejected write.
    expect(body.cart.lines[0]!.quantity).toBe(2);
  });

  it('PATCH lines with the CURRENT expectedRevision succeeds', async () => {
    const { token } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const getRes = await app.request(`/v1/shop/cart/${token}`, { headers: hdr() });
    const current = (await getRes.json() as { revision: number }).revision;
    const res = await app.request(`/v1/shop/cart/${token}/lines`, {
      method: 'PATCH', headers: hdr(), body: JSON.stringify({ lines: [{ sku: SKU, quantity: 5 }], expectedRevision: current }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { revision: number }).revision).toBe(current + 1);
  });

  it('PATCH identity with a stale expectedRevision → 409', async () => {
    const { token, revision } = await makeCart([{ sku: SKU, quantity: 1 }]);
    await app.request(`/v1/shop/cart/${token}/lines`, {
      method: 'PATCH', headers: hdr(), body: JSON.stringify({ lines: [{ sku: SKU, quantity: 2 }], expectedRevision: revision }),
    });
    const res = await app.request(`/v1/shop/cart/${token}`, {
      method: 'PATCH', headers: hdr(), body: JSON.stringify({ email: 'id@example.com', expectedRevision: revision }),
    });
    expect(res.status).toBe(409);
  });

  it('checkout with a stale expectedRevision → 409 + current snapshot, no order created', async () => {
    const { token, revision } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const res = await checkoutReq({ cartToken: token, expectedRevision: revision + 5 });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; revision: number; cart: { revision: number } };
    expect(body.revision).toBe(revision);
    expect(await orderCount()).toBe(0);
    const row = await cartRowByToken(token);
    expect(row!.status).toBe('active');
  });

  it('checkout with the CURRENT expectedRevision converts normally', async () => {
    const { token, revision } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const res = await checkoutReq({ cartToken: token, expectedRevision: revision });
    expect(res.status).toBe(200);
    expect(await orderCount()).toBe(1);
  });

  it('merge with a stale expectedRevision → 409', async () => {
    const { token, revision } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const sessionToken = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
    const res = await app.request(`/v1/shop/cart/${token}/merge?expectedRevision=${revision + 3}`, {
      method: 'POST', headers: hdr({ authorization: `Bearer ${sessionToken}` }),
    });
    expect(res.status).toBe(409);
    const row = await cartRowByToken(token);
    expect(row!.customerId).toBeNull();
  });
});

// ── CART-03 contract boundary: expectedRevision is REQUIRED on non-appends ──
// Every mutation that depends on the cart's current state — line quantity
// update, line remove, identity attach, merge, checkout conversion — must
// echo the revision it read. Missing it → 409 'revision_required' (distinct
// from 'stale': there is no base to compare). The ONE exception is the blind
// append path: a lines-PATCH whose lines are all quantity ≥ 1 may omit the
// revision because it applies as a commutative increment, so two blind
// writers can't lose each other's adds.
describe('CART-03 contract: expectedRevision required on non-append mutations', () => {
  const patchLines = (token: string, body: unknown) =>
    app.request(`/v1/shop/cart/${token}/lines`, { method: 'PATCH', headers: hdr(), body: JSON.stringify(body) });

  it('the blind append path stays revision-free AND commutative — two blind adds on one sku sum (no lost update)', async () => {
    const { token } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const [a, b] = await Promise.all([
      patchLines(token, { lines: [{ sku: SKU, quantity: 2 }] }),
      patchLines(token, { lines: [{ sku: SKU, quantity: 3 }] }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = (await cartRowByToken(token))!;
    const lines = await withStore(STORE, (tx) => tx.select().from(s.cartLine).where(eq(s.cartLine.cartId, row.id)));
    // Under last-writer-wins the second blind write overwrote the first
    // (final quantity 3); commutative increment must yield 1 + 2 + 3.
    expect(lines.find((l) => l.sku === SKU)!.quantity).toBe(6);
  });

  it('a blind add of a NEW sku also works without a revision', async () => {
    const { token } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const res = await patchLines(token, { lines: [{ sku: SKU_P, quantity: 2 }] });
    expect(res.status).toBe(200);
    const body = await res.json() as { lines: Array<{ sku: string; quantity: number }> };
    expect(body.lines.find((l) => l.sku === SKU_P)!.quantity).toBe(2);
  });

  it('a line remove (quantity 0) without expectedRevision → 409 revision_required, line untouched', async () => {
    const { token } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const res = await patchLines(token, { lines: [{ sku: SKU, quantity: 0 }] });
    expect(res.status).toBe(409);
    const body = await res.json() as { code: string; error: string };
    expect(body.code).toBe('revision_required');
    const row = (await cartRowByToken(token))!;
    const lines = await withStore(STORE, (tx) => tx.select().from(s.cartLine).where(eq(s.cartLine.cartId, row.id)));
    expect(lines).toHaveLength(1);
  });

  it('a mixed update+remove without expectedRevision → 409 revision_required (the whole request is non-append)', async () => {
    const { token } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const res = await patchLines(token, { lines: [{ sku: SKU, quantity: 2 }, { sku: SKU_P, quantity: 0 }] });
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe('revision_required');
  });

  it('identity attach without expectedRevision → 409 revision_required', async () => {
    const { token } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const res = await app.request(`/v1/shop/cart/${token}`, {
      method: 'PATCH', headers: hdr(), body: JSON.stringify({ email: 'norev@example.com' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('revision_required');
    expect((await cartRowByToken(token))!.email).toBeNull();
  });

  it('merge without expectedRevision → 409 revision_required', async () => {
    const { token } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const sessionToken = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
    const res = await app.request(`/v1/shop/cart/${token}/merge`, {
      method: 'POST', headers: hdr({ authorization: `Bearer ${sessionToken}` }),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe('revision_required');
    expect((await cartRowByToken(token))!.customerId).toBeNull();
  });

  it('checkout with cartToken but no expectedRevision → 409 revision_required, no order created', async () => {
    const { token } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const res = await checkoutReq({ cartToken: token });
    expect(res.status).toBe(409);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('revision_required');
    expect(await orderCount()).toBe(0);
    expect((await cartRowByToken(token))!.status).toBe('active');
  });

  it('409 bodies carry the machine-readable code alongside error + snapshot', async () => {
    const { token, revision } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const stale = await patchLines(token, { lines: [{ sku: SKU, quantity: 5 }], expectedRevision: revision + 9 });
    expect(stale.status).toBe(409);
    const body = await stale.json() as { code: string; revision: number; cart: { revision: number } };
    expect(body.code).toBe('stale');
    expect(body.revision).toBe(revision);
    expect(body.cart.revision).toBe(revision);
  });
});

// ── CART-05: merge CONSUMES donors — 'merged' is terminal and empty ────────
// Regression for the repeated-merge duplication: a donor used to be retired
// as 'abandoned' WITH its lines intact, so editing it (reactivating it) and
// merging again re-added the same quantities. Now the fold is a MOVE — donor
// lines are deleted after being summed into the target — and 'merged' is a
// terminal status that mutationBlocker rejects like 'converted'.
describe('CART-05: merged donor carts are terminal and can never re-fold', () => {
  async function session(): Promise<string> {
    return withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
  }
  /** Create a cart already owned by the test customer (a merge donor). */
  async function customerCart(items: Array<{ sku: string; quantity: number }>, auth: string): Promise<{ token: string; revision: number }> {
    const res = await app.request('/v1/shop/cart', {
      method: 'POST', headers: hdr({ authorization: `Bearer ${auth}` }), body: JSON.stringify({ items }),
    });
    expect(res.status).toBe(200);
    return await res.json() as { token: string; revision: number };
  }
  function mergeReq(token: string, auth: string, expectedRevision?: number) {
    return app.request(`/v1/shop/cart/${token}/merge${expectedRevision != null ? `?expectedRevision=${expectedRevision}` : ''}`, {
      method: 'POST', headers: hdr({ authorization: `Bearer ${auth}` }),
    });
  }
  async function linesOf(cartId: string) {
    return withStore(STORE, (tx) => tx.select().from(s.cartLine).where(eq(s.cartLine.cartId, cartId)));
  }

  it('merge folds donor lines into the target (sum on conflict) and the donor ends merged + EMPTY', async () => {
    const auth = await session();
    const donor = await customerCart([{ sku: SKU, quantity: 1 }], auth);
    const guest = await makeCart([{ sku: SKU, quantity: 2 }]);
    const res = await mergeReq(guest.token, auth, guest.revision);
    expect(res.status).toBe(200);
    const body = await res.json() as { lines: Array<{ sku: string; quantity: number }> };
    expect(body.lines.find((l) => l.sku === SKU)!.quantity).toBe(3);

    const donorRow = (await cartRowByToken(donor.token))!;
    expect(donorRow.status).toBe('merged');
    // Fold = move: the donor's cart_line rows are deleted, not kept.
    expect(await linesOf(donorRow.id)).toHaveLength(0);
  });

  it('editing the donor after merge is a 409 and re-merging adds NOTHING', async () => {
    const auth = await session();
    const donor = await customerCart([{ sku: SKU, quantity: 1 }], auth);
    const guest = await makeCart([{ sku: SKU, quantity: 2 }]);
    const first = await mergeReq(guest.token, auth, guest.revision);
    expect(first.status).toBe(200);

    // The old bug: donor stayed 'abandoned' with its lines, so this blind
    // add reactivated it and the second merge re-added the quantities.
    const edit = await app.request(`/v1/shop/cart/${donor.token}/lines`, {
      method: 'PATCH', headers: hdr(), body: JSON.stringify({ lines: [{ sku: SKU, quantity: 4 }] }),
    });
    expect(edit.status).toBe(409);
    const editBody = await edit.json() as { code: string };
    expect(editBody.code).toBe('merged');

    const get = await app.request(`/v1/shop/cart/${guest.token}`, { headers: hdr() });
    const rev = (await get.json() as { revision: number }).revision;
    const again = await mergeReq(guest.token, auth, rev);
    expect(again.status).toBe(200);
    const body = await again.json() as { lines: Array<{ sku: string; quantity: number }> };
    expect(body.lines.find((l) => l.sku === SKU)!.quantity).toBe(3); // never 3 + 4

    const donorRow = (await cartRowByToken(donor.token))!;
    expect(donorRow.status).toBe('merged');
    expect(await linesOf(donorRow.id)).toHaveLength(0);
  });

  it('a merged cart rejects identity attach and checkout too (terminal everywhere)', async () => {
    const auth = await session();
    const donor = await customerCart([{ sku: SKU, quantity: 1 }], auth);
    const guest = await makeCart([{ sku: SKU, quantity: 2 }]);
    const first = await mergeReq(guest.token, auth, guest.revision);
    expect(first.status).toBe(200);
    const donorRow = (await cartRowByToken(donor.token))!;

    const ident = await app.request(`/v1/shop/cart/${donor.token}`, {
      method: 'PATCH', headers: hdr(), body: JSON.stringify({ email: 'donor@example.com', expectedRevision: donorRow.revision }),
    });
    expect(ident.status).toBe(409);

    const co = await checkoutReq({ cartToken: donor.token, expectedRevision: donorRow.revision });
    expect(co.status).toBe(409);
    expect(await orderCount()).toBe(0);
  });

  it('GET on a merged cart still works — it reports status merged with empty lines', async () => {
    const auth = await session();
    const donor = await customerCart([{ sku: SKU, quantity: 1 }], auth);
    const guest = await makeCart([{ sku: SKU, quantity: 2 }]);
    await mergeReq(guest.token, auth, guest.revision);
    const res = await app.request(`/v1/shop/cart/${donor.token}`, { headers: hdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; lines: unknown[] };
    expect(body.status).toBe('merged');
    expect(body.lines).toHaveLength(0);
  });
});

// ── Variant pricing parity (store-config-driven rule) ───────────────────────
describe('variant pricing rule — store-config-driven, cart/checkout parity', () => {
  async function setVariantPriceFields(fields: { salePrice?: number | null; isPreOrder?: boolean; preOrderPrice?: number | null }): Promise<void> {
    await withStore(STORE, async (tx) => {
      await tx.update(s.productVariant).set(fields).where(eq(s.productVariant.id, VARIANT));
    });
  }
  async function setPricingRule(rule: 'preorder' | 'sale' | null): Promise<void> {
    await pool.query(`UPDATE store SET config = coalesce(config, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
      [JSON.stringify(rule ? { pricing: { variantRule: rule } } : { pricing: {} }), STORE]);
    invalidateStoreCache(SLUG);
  }
  async function estimate(): Promise<{ unitPrice: number; grandTotal: number }> {
    const res = await app.request('/v1/shop/cart/estimate', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { lines: Array<{ unitPrice: number }>; grandTotal: number };
    return { unitPrice: body.lines[0]!.unitPrice, grandTotal: body.grandTotal };
  }
  async function checkoutGrand(): Promise<number> {
    const res = await checkoutReq({ items: [{ sku: SKU, quantity: 1 }] });
    expect(res.status).toBe(200);
    return (await res.json() as { grandTotal: number }).grandTotal;
  }

  it("default rule ('preorder'): positive preOrderPrice wins while preordering; estimate == checkout", async () => {
    await setVariantPriceFields({ salePrice: 4000, isPreOrder: true, preOrderPrice: 3000 });
    expect((await estimate()).unitPrice).toBe(3000);
    expect(await checkoutGrand()).toBe(3000);
  });

  it("'preorder' rule: a preorder with NO positive preOrderPrice falls back to BASE — never to salePrice", async () => {
    await setVariantPriceFields({ salePrice: 4000, isPreOrder: true, preOrderPrice: null });
    expect((await estimate()).unitPrice).toBe(PRICE);
    expect(await checkoutGrand()).toBe(PRICE);
    await setVariantPriceFields({ preOrderPrice: 0 });
    expect((await estimate()).unitPrice).toBe(PRICE);
  });

  it("'preorder' rule: a zero salePrice is treated as absent (base, not 0)", async () => {
    await setVariantPriceFields({ salePrice: 0, isPreOrder: false, preOrderPrice: null });
    expect((await estimate()).unitPrice).toBe(PRICE);
    expect(await checkoutGrand()).toBe(PRICE);
  });

  it("'preorder' rule: off-preorder variants still use a positive salePrice", async () => {
    await setVariantPriceFields({ salePrice: 4000, isPreOrder: false, preOrderPrice: null });
    expect((await estimate()).unitPrice).toBe(4000);
    expect(await checkoutGrand()).toBe(4000);
  });

  it("'sale' rule (Rotten Hand): positive salePrice else base; preorder fields ignored", async () => {
    await setPricingRule('sale');
    await setVariantPriceFields({ salePrice: 4000, isPreOrder: true, preOrderPrice: 3000 });
    expect((await estimate()).unitPrice).toBe(4000);
    expect(await checkoutGrand()).toBe(4000);

    // preOrderPrice is NOT consulted under the sale rule.
    await setVariantPriceFields({ salePrice: null });
    expect((await estimate()).unitPrice).toBe(PRICE);
    expect(await checkoutGrand()).toBe(PRICE);
  });
});

// ── RLS: the new revision field behaves under the app (non-owner) role ──────
describe('cart hardening under the app role (FORCE RLS)', () => {
  it('the app role cannot see or touch another store\u2019s carts; own-store writes bump revision', async () => {
    const { token } = await makeCart([{ sku: SKU, quantity: 1 }]);
    const own = await cartRowByToken(token);

    // Cross-tenant: store B sees nothing and its update matches zero rows.
    const seen = await withStoreApp(STORE_B, (tx) => tx.select().from(s.cart));
    expect(seen).toHaveLength(0);
    const upd = await withStoreApp(STORE_B, (tx) =>
      tx.update(s.cart).set({ revision: sql`${s.cart.revision} + 1` }).where(eq(s.cart.id, own!.id)).returning({ id: s.cart.id }));
    expect(upd).toHaveLength(0);

    // Same-tenant app-role write works (mirrors a route mutation under RLS).
    const ok = await withStoreApp(STORE, (tx) =>
      tx.update(s.cart).set({ revision: sql`${s.cart.revision} + 1` }).where(eq(s.cart.id, own!.id)).returning({ revision: s.cart.revision }));
    expect(ok[0]!.revision).toBe(own!.revision + 1);
  });
});

// ── Zero-cache stock rule: cart pricing must report LIVE stock availability,
// never a cached/assumed one (see CLAUDE.md's locked stock architecture). ───
describe('cart estimate — live stock availability', () => {
  const VARIANT_NOSTOCK = 'bbbbbbbb-2222-2222-2222-2222222222b3';
  const SKU_NOSTOCK = 'CH-SKU-NOSTOCK';

  async function setStock(onHand: number, allocated: number): Promise<void> {
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE stock SET on_hand = ${onHand}, allocated = ${allocated} WHERE variant_id = ${VARIANT_P}`));
  }
  async function seedNoStockVariant(): Promise<void> {
    await withStore(STORE, (tx) => tx.execute(sql`
      INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type)
      VALUES (${VARIANT_NOSTOCK}, ${STORE}, ${PRODUCT}, ${SKU_NOSTOCK}, 'CH No Stock Row', ${PRICE}, 'physical')
      ON CONFLICT (id) DO NOTHING`));
  }
  type Line = { sku: string; available: boolean; availableQuantity: number | null };
  async function estimateLines(items: Array<{ sku: string; quantity: number }>): Promise<{ lines: Line[]; unavailable: string[] }> {
    const res = await app.request('/v1/shop/cart/estimate', { method: 'POST', headers: hdr(), body: JSON.stringify({ items }) });
    expect(res.status).toBe(200);
    return res.json() as Promise<{ lines: Line[]; unavailable: string[] }>;
  }

  it('a physical line within stock is available and reports the live (on_hand - allocated) count', async () => {
    await setStock(20, 0);
    const { lines, unavailable } = await estimateLines([{ sku: SKU_P, quantity: 5 }]);
    expect(lines[0]).toMatchObject({ sku: SKU_P, available: true, availableQuantity: 20 });
    expect(unavailable).toEqual([]);
  });

  it('a physical line requesting more than (on_hand - allocated) is unavailable, excluded from totals', async () => {
    await setStock(10, 8); // only 2 saleable
    const { lines, unavailable } = await estimateLines([{ sku: SKU_P, quantity: 5 }]);
    expect(lines[0]).toMatchObject({ sku: SKU_P, available: false, availableQuantity: 2 });
    expect(unavailable).toEqual([SKU_P]);
  });

  it('allocated stock (reserved by other pending orders) lowers live availability immediately — no cache lag', async () => {
    await setStock(10, 0);
    expect((await estimateLines([{ sku: SKU_P, quantity: 10 }])).lines[0]).toMatchObject({ available: true, availableQuantity: 10 });
    await setStock(10, 10); // fully allocated by other orders
    expect((await estimateLines([{ sku: SKU_P, quantity: 1 }])).lines[0]).toMatchObject({ available: false, availableQuantity: 0 });
  });

  it('a stock-limited variant with NO stock row fails closed — never defaults to in-stock', async () => {
    await seedNoStockVariant();
    const { lines, unavailable } = await estimateLines([{ sku: SKU_NOSTOCK, quantity: 1 }]);
    expect(lines[0]).toMatchObject({ sku: SKU_NOSTOCK, available: false, availableQuantity: 0 });
    expect(unavailable).toEqual([SKU_NOSTOCK]);
  });

  it('a non-physical (digital) line is never stock-limited — availableQuantity is null, not a stock number', async () => {
    const { lines, unavailable } = await estimateLines([{ sku: SKU, quantity: 1000 }]);
    expect(lines[0]).toMatchObject({ sku: SKU, available: true, availableQuantity: null });
    expect(unavailable).toEqual([]);
  });
});
