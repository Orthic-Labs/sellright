import { _setRateLimitBackendForTest, createMemoryRateLimitBackend } from '../auth/rate-limit-backend.js';
/**
 * #370: POST /v1/shop/cart/{token}/reopen — a shopper who reached payment can change the cart again. The unpaid order
 * is cancelled (stock and its reservation released), the same cart is active with its lines, and the next checkout
 * creates a new order. A paid order or a payment in flight is refused and the cart stays converted.
 *
 * Runs against a dedicated *_test DB ONLY (wipes data). Same conventions as cart-hardening.db.test.ts.
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { clearLoginAttempts } from '../auth/rate-limit.js';
import { invalidateStoreCache } from '../store-context.js';
import { cart } from './cart.js';
import { checkout } from './checkout.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'cart-reopen.db.test.ts');

const STORE = 'cccccccc-3700-3700-3700-370000000001';
const SLUG = 'cart-reopen-test-store';
const PRODUCT = 'cccccccc-3700-3700-3700-3700000000a1';
const VARIANT = 'cccccccc-3700-3700-3700-3700000000b1';
const VARIANT_2 = 'cccccccc-3700-3700-3700-3700000000b2';
const SKU = 'RO-SKU-1';
const SKU_2 = 'RO-SKU-2';
const SHIP = 'ro-flat';

const app = new OpenAPIHono();
app.route('/', cart);
app.route('/', checkout);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

beforeEach(async () => {
  _setRateLimitBackendForTest(createMemoryRateLimitBackend());
  clearLoginAttempts('unknown', 'checkout:unknown');
  await wipe();
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, tax_rate) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', 0)`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PRODUCT}, ${STORE}, 'ro-prod', 'RO Product', 'active')`);
    for (const [id, sku] of [[VARIANT, SKU], [VARIANT_2, SKU_2]]) {
      await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type) VALUES (${id}, ${STORE}, ${PRODUCT}, ${sku}, ${sku}, 4000, 'physical')`);
      await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${id}, ${STORE}, 10, 0)`);
    }
    await tx.insert(s.shippingMethod).values({ storeId: STORE, code: SHIP, name: 'Flat', calculator: { flat: 0 }, enabled: true });
  });
  invalidateStoreCache();
});
afterAll(async () => {
  await wipe();
  await pool.end();
});

const hdr = { 'content-type': 'application/json', 'x-store-slug': SLUG };

async function convertedCart(): Promise<{ token: string; code: string }> {
  const res = await app.request('/v1/shop/cart', { method: 'POST', headers: hdr, body: JSON.stringify({ items: [{ sku: SKU, quantity: 2 }] }) });
  expect(res.status).toBe(200);
  const { token, revision } = await res.json() as { token: string; revision: number };
  const co = await app.request('/v1/shop/checkout', {
    method: 'POST', headers: hdr,
    body: JSON.stringify({ items: [{ sku: SKU, quantity: 2 }], cartToken: token, expectedRevision: revision, shippingMethodCode: SHIP }),
  });
  expect(co.status).toBe(200);
  const { code, state } = await co.json() as { code: string; state: string };
  expect(state).toBe('PendingPayment');
  return { token, code };
}

const reopen = (token: string) => app.request(`/v1/shop/cart/${token}/reopen`, { method: 'POST', headers: hdr });

async function facts(token: string, code: string) {
  return withStore(STORE, async (tx) => {
    const [c] = await tx.select().from(s.cart).where(eq(s.cart.token, token)).limit(1);
    const [o] = await tx.select({ state: s.order.state }).from(s.order).where(eq(s.order.code, code)).limit(1);
    const r = await tx.execute(sql`SELECT allocated FROM stock WHERE variant_id = ${VARIANT}`);
    const lines = await tx.select({ quantity: s.cartLine.quantity }).from(s.cartLine).where(eq(s.cartLine.cartId, c!.id));
    return { cart: c!, orderState: o?.state, allocated: Number((r.rows[0] as { allocated: number }).allocated), lines };
  });
}

describe('#370 cart reopen', () => {
  it('cancels the unpaid order, releases its stock and reactivates the same cart with its lines', async () => {
    const { token, code } = await convertedCart();
    const before = await facts(token, code);
    expect(before.cart.status).toBe('converted');
    expect(before.allocated).toBe(2);

    const res = await reopen(token);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; token: string; lines: Array<{ sku: string; quantity: number }>; revision: number };
    expect(body.status).toBe('active');
    expect(body.token).toBe(token);
    expect(body.lines.map((l) => [l.sku, l.quantity])).toEqual([[SKU, 2]]);
    expect(body.revision).toBe(before.cart.revision + 1);

    const after = await facts(token, code);
    expect(after.orderState).toBe('Cancelled');
    expect(after.cart.convertedOrderId).toBeNull();
    expect(after.allocated).toBe(0);
    const audit = await withStore(STORE, (tx) => tx.select({ actor: s.auditLog.actor, data: s.auditLog.data }).from(s.auditLog)
      .where(eq(s.auditLog.action, 'cancel')));
    expect(audit).toEqual([{ actor: 'shopper:cart-reopen', data: { reason: 'cart_reopened' } }]);
  });

  it('the reopened cart takes changes and checks out as a NEW order', async () => {
    const { token, code } = await convertedCart();
    expect((await reopen(token)).status).toBe(200);
    const add = await app.request(`/v1/shop/cart/${token}/lines`, { method: 'PATCH', headers: hdr, body: JSON.stringify({ lines: [{ sku: SKU_2, quantity: 1 }] }) });
    expect(add.status).toBe(200);
    const { revision } = await add.json() as { revision: number };
    const co = await app.request('/v1/shop/checkout', {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ items: [{ sku: SKU, quantity: 2 }], cartToken: token, expectedRevision: revision, shippingMethodCode: SHIP }),
    });
    expect(co.status).toBe(200);
    const next = await co.json() as { code: string; grandTotal: number };
    expect(next.code).not.toBe(code);
    expect(next.grandTotal).toBe(12000);
  });

  it('is idempotent: a second reopen (another tab) returns the open cart and cancels nothing more', async () => {
    const { token, code } = await convertedCart();
    const [a, b] = await Promise.all([reopen(token), reopen(token)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const after = await facts(token, code);
    expect(after.cart.status).toBe('active');
    expect(after.allocated).toBe(0);
    const cancels = await withStore(STORE, (tx) => tx.select({ id: s.auditLog.id }).from(s.auditLog).where(eq(s.auditLog.action, 'cancel')));
    expect(cancels).toHaveLength(1);
  });

  it('refuses a paid order: 409 ORDER_ALREADY_PAID, cart stays converted', async () => {
    const { token, code } = await convertedCart();
    await withStore(STORE, (tx) => tx.update(s.order).set({ state: 'Paid' }).where(eq(s.order.code, code)));
    const res = await reopen(token);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('ORDER_ALREADY_PAID');
    const after = await facts(token, code);
    expect(after.cart.status).toBe('converted');
    expect(after.orderState).toBe('Paid');
  });

  it('refuses while a payment is in flight: 409 PAYMENT_IN_PROGRESS, order and stock untouched', async () => {
    const { token, code } = await convertedCart();
    await withStore(STORE, async (tx) => {
      const [o] = await tx.select({ id: s.order.id }).from(s.order).where(eq(s.order.code, code)).limit(1);
      await tx.insert(s.paymentAttempt).values({
        storeId: STORE, orderId: o!.id, method: 'nmi', operation: 'charge', accountId: 'acct', mode: 'live', status: 'pending',
        amount: 8000, currency: 'USD', idempotencyKey: 'ro-pending', fingerprint: 'ro-fp',
      });
    });
    const res = await reopen(token);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('PAYMENT_IN_PROGRESS');
    const after = await facts(token, code);
    expect(after.cart.status).toBe('converted');
    expect(after.orderState).toBe('PendingPayment');
    expect(after.allocated).toBe(2);
  });

  it('a cancelled order (expired by the job) reopens without a second cancel', async () => {
    const { token, code } = await convertedCart();
    await withStore(STORE, (tx) => tx.update(s.order).set({ state: 'Cancelled' }).where(eq(s.order.code, code)));
    expect((await reopen(token)).status).toBe(200);
    expect((await facts(token, code)).cart.status).toBe('active');
  });

  it('an unknown token is 404; an active cart reopens as a no-op', async () => {
    expect((await reopen('no-such-token')).status).toBe(404);
    const res = await app.request('/v1/shop/cart', { method: 'POST', headers: hdr, body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }] }) });
    const { token, revision } = await res.json() as { token: string; revision: number };
    const again = await reopen(token);
    expect(again.status).toBe(200);
    expect((await again.json() as { revision: number }).revision).toBe(revision);
  });
});
