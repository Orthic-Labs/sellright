/**
 * LOYALTY-1 DB tests (PostgreSQL, *_test database only — these wipe data).
 *
 *   earn        — posted only when the order reaches Paid, once per order,
 *                 registered customers only
 *   redeem      — server-side at checkout, discount before tax, reserved on
 *                 the order; rejections roll the whole checkout back
 *   concurrency — two simultaneous checkouts cannot double-spend
 *   refunds     — proportional restore/reversal, idempotent per refund,
 *                 shortfall instead of a negative balance
 *   cancel      — admin/stale cancellation releases the reservation
 *   expiry      — expired lots hidden from `available`, written off on spend
 *   RLS         — FORCE RLS isolates stores; the ledger is append-only
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { clearLoginAttempts } from '../auth/rate-limit.js';
import { invalidateStoreCache } from '../store-context.js';
import { createSession } from '../auth/session.js';
import { checkout } from '../routes/checkout.js';
import { loyalty as loyaltyRoutes } from '../routes/loyalty.js';
import { adminLoyalty } from '../routes/admin-loyalty.js';
import { createAdminSession } from '../auth/admin-session.js';
import { applyPaymentResult } from '../payments/settle.js';
import { releaseStaleAllocations } from '../jobs/release-stale-allocations.js';
import { createStoreAppRunner, expectRlsRejection } from '../db/rls-test-utils.js';
import {
  adjustPoints, loyaltyBalance, LoyaltyAdjustError, lockedAvailable, postEarnForPaidOrder, reconcileRefundLoyalty, releaseOrderLoyalty,
} from './ledger.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`loyalty test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'cccccccc-3333-3333-3333-333333333333';
const OTHER = 'cccccccc-3333-3333-3333-3333333333ff';
const SLUG = 'loyalty-test-store';
const PRODUCT = 'cccccccc-3333-3333-3333-3333333333a1';
const VARIANT = 'cccccccc-3333-3333-3333-3333333333b1';
const CUSTOMER = 'cccccccc-3333-3333-3333-3333333333c1';
const SKU = 'LOYALTY-1';
const PRICE = 10_000; // $100.00

const clearLimits = () => {
  clearLoginAttempts('unknown', 'checkout:unknown');
  if (token) clearLoginAttempts('unknown', `checkout:${token}`);
};

const PROGRAM = { enabled: true, earnRatePerDollar: 1, pointsPerDollarOff: 100, minRedeemPoints: 0, maxRedeemPercentOfSubtotal: null, expiryDays: null };

const app = new OpenAPIHono();
app.route('/', checkout);
app.route('/', loyaltyRoutes);
app.route('/', adminLoyalty);

const appPool = new Pool({ connectionString: env.DATABASE_URL_NONOWNER ?? env.DATABASE_URL });
const withStoreApp = createStoreAppRunner(appPool, { casing: 'snake_case' } as const);
afterAll(async () => { await appPool.end(); });

let token = '';
let seq = 0;

async function seed(program: Record<string, unknown> = PROGRAM) {
  await pool.query('TRUNCATE store CASCADE');
  clearLimits();
  invalidateStoreCache(SLUG);
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, tax_rate, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', 1000, ${JSON.stringify({ loyalty: program })}::jsonb)`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PRODUCT}, ${STORE}, 'lp', 'Loyalty Product', 'active')`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type)
      VALUES (${VARIANT}, ${STORE}, ${PRODUCT}, ${SKU}, 'Loyalty Download', ${PRICE}, 'digital_download')`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 100, 0)`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, email_verified) VALUES (${CUSTOMER}, ${STORE}, 'member@example.com', true)`);
    token = await createSession(tx, STORE, CUSTOMER);
  });
}

async function placeOrder(body: Record<string, unknown> = {}, auth = true) {
  clearLimits();
  const res = await app.request('/v1/shop/checkout', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-store-slug': SLUG, 'idempotency-key': `loyalty-${++seq}-${Date.now()}`,
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }], ...body }),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

const orderByCode = (code: string) => withStore(STORE, async (tx) => (await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1))[0]!);
const ledger = () => withStore(STORE, (tx) => tx.select().from(s.loyaltyLedger).orderBy(s.loyaltyLedger.createdAt));
const balance = () => withStore(STORE, (tx) => loyaltyBalance(tx, CUSTOMER));
const grant = (points: number) => withStore(STORE, (tx) => adjustPoints(tx, { storeId: STORE, customerId: CUSTOMER, points, reason: 'test grant', actor: 'test' }));

async function settle(code: string, ref: string) {
  const o = await orderByCode(code);
  await withStore(STORE, (tx) => applyPaymentResult(tx, {
    storeId: STORE, order: { id: o.id, state: o.state, grandTotal: o.grandTotal, currency: o.currency, customerId: o.customerId, code },
    method: 'stripe', amount: o.grandTotal, result: { state: 'Settled', providerRef: ref, metadata: { gateway: { mode: 'test' } } },
  }));
  return orderByCode(code);
}

beforeEach(async () => { await seed(); });

describe('earn', () => {
  it('posts earned points once, only when the order reaches Paid', async () => {
    const r = await placeOrder();
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('PendingPayment');
    const pending = await orderByCode(r.body.code);
    // $100 merchandise at 1 point per $1; tax (10%) never earns.
    expect((pending.metadata as any).loyalty.earnPoints).toBe(100);
    expect(await ledger()).toHaveLength(0);

    const paid = await settle(r.body.code, 'pi_loyalty_1');
    expect(paid.state).toBe('Paid');
    expect((await balance()).balance).toBe(100);
    // Replayed settle / direct re-post: still exactly one earn row.
    await settle(r.body.code, 'pi_loyalty_1');
    expect(await withStore(STORE, (tx) => postEarnForPaidOrder(tx, STORE, paid.id))).toBe(0);
    const rows = await ledger();
    expect(rows.filter((x) => x.kind === 'earn')).toHaveLength(1);
  });

  it('guests earn nothing and a disabled program writes no snapshot', async () => {
    const guest = await placeOrder({ email: 'guest@example.net' }, false);
    expect(guest.status).toBe(200);
    expect(((await orderByCode(guest.body.code)).metadata as any).loyalty.earnPoints).toBe(0);
    await seed({ ...PROGRAM, enabled: false });
    const off = await placeOrder();
    expect(((await orderByCode(off.body.code)).metadata as any).loyalty).toBeUndefined();
  });
});

describe('redeem', () => {
  it('applies points as a pre-tax discount and reserves them on the order', async () => {
    await grant(5000);
    const r = await placeOrder({ redeemPoints: 1000 });
    expect(r.status).toBe(200);
    // $100 − $10 points = $90; 10% tax on $90 = $9 → $99
    expect(r.body).toMatchObject({ pointsRedeemed: 1000, pointsDiscount: 1000, discountTotal: 1000, grandTotal: 9900, couponApplied: false });
    const order = await orderByCode(r.body.code);
    expect(order.taxTotal).toBe(900);
    expect((order.metadata as any).loyalty).toMatchObject({ redeemPoints: 1000, pointsDiscount: 1000, earnPoints: 90 });
    const redeem = (await ledger()).find((x) => x.kind === 'redeem')!;
    expect(redeem).toMatchObject({ points: -1000, orderId: order.id, sourceRef: `redeem:${order.id}` });
    expect((await balance()).available).toBe(4000);
  });

  it('rejects over-balance, guest and disabled redemptions without creating an order or holding stock', async () => {
    await grant(500);
    const over = await placeOrder({ redeemPoints: 600 });
    expect(over.status).toBe(409);
    expect(over.body.reason).toBe('insufficient_balance');
    const guest = await placeOrder({ redeemPoints: 100, email: 'guest@example.net' }, false);
    expect(guest.body.reason).toBe('not_signed_in');
    const orders = await withStore(STORE, (tx) => tx.select().from(s.order));
    expect(orders).toHaveLength(0);
    const [stock] = await withStore(STORE, (tx) => tx.select().from(s.stock).where(eq(s.stock.variantId, VARIANT)));
    expect(stock!.allocated).toBe(0);
    expect((await balance()).available).toBe(500);
    await seed({ ...PROGRAM, enabled: false });
    expect((await placeOrder({ redeemPoints: 100 })).body.reason).toBe('disabled');
  });

  it('a full-cover redemption settles the order and earns nothing on the points-paid part', async () => {
    await seed({ ...PROGRAM, maxRedeemPercentOfSubtotal: null });
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE store SET tax_rate = 0 WHERE id = ${STORE}`));
    invalidateStoreCache(SLUG);
    await grant(20_000);
    const r = await placeOrder({ redeemPoints: 20_000 });
    expect(r.body).toMatchObject({ state: 'Paid', grandTotal: 0, pointsRedeemed: 10_000, pointsDiscount: 10_000 });
    expect((await balance()).available).toBe(10_000);
  });

  it('two concurrent checkouts cannot double-spend the same points', async () => {
    await grant(1000);
    const [a, b] = await Promise.all([placeOrder({ redeemPoints: 1000 }), placeOrder({ redeemPoints: 1000 })]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect([a, b].find((x) => x.status === 409)!.body.reason).toBe('insufficient_balance');
    const bal = await balance();
    expect(bal.balance).toBe(0);
    expect((await ledger()).filter((x) => x.kind === 'redeem')).toHaveLength(1);
  });
});

describe('refunds and cancellation', () => {
  it('restores redeemed and reverses earned points proportionally, idempotently', async () => {
    await grant(1000);
    const r = await placeOrder({ redeemPoints: 1000 });
    const order = await settle(r.body.code, 'pi_loyalty_refund');
    expect((await balance()).balance).toBe(90); // 1000 − 1000 + 90 earned
    const half = { storeId: STORE, orderId: order.id, refunded: 4950, captured: 9900, actor: 'test' };
    await withStore(STORE, (tx) => reconcileRefundLoyalty(tx, { ...half, refundId: 'aaaaaaaa-0000-0000-0000-000000000001' }));
    // +500 restored, −45 reversed
    expect((await balance()).balance).toBe(90 + 500 - 45);
    // Same refund replayed → no new rows.
    await withStore(STORE, (tx) => reconcileRefundLoyalty(tx, { ...half, refundId: 'aaaaaaaa-0000-0000-0000-000000000001' }));
    expect((await balance()).balance).toBe(545);
    // Second half → converges on the full amounts.
    await withStore(STORE, (tx) => reconcileRefundLoyalty(tx, { ...half, refunded: 9900, refundId: 'aaaaaaaa-0000-0000-0000-000000000002' }));
    expect((await balance()).balance).toBe(1000);
  });

  it('never drives the balance negative: the unpostable reversal is recorded as shortfall', async () => {
    const r = await placeOrder();
    const order = await settle(r.body.code, 'pi_loyalty_short');
    expect((await balance()).balance).toBe(100);
    await grant(-80); // customer spent most of the earned points
    await withStore(STORE, (tx) => reconcileRefundLoyalty(tx, { storeId: STORE, orderId: order.id, refundId: 'aaaaaaaa-0000-0000-0000-000000000003', refunded: 11000, captured: 11000, actor: 'test' }));
    const rev = (await ledger()).find((x) => x.reason === 'earn_reversal')!;
    expect(rev).toMatchObject({ points: -20, shortfall: 80 });
    expect((await balance()).balance).toBe(0);
  });

  it('cancelling an unpaid order releases the reservation (admin path and stale-unpaid job)', async () => {
    await grant(3000);
    const a = await placeOrder({ redeemPoints: 1000 });
    const b = await placeOrder({ redeemPoints: 1000 });
    expect((await balance()).available).toBe(1000);
    const oa = await orderByCode(a.body.code);
    await withStore(STORE, (tx) => releaseOrderLoyalty(tx, STORE, oa.id, 'test'));
    await withStore(STORE, (tx) => releaseOrderLoyalty(tx, STORE, oa.id, 'test')); // idempotent
    expect((await balance()).available).toBe(2000);
    // Payment never arrived: the stale-unpaid job cancels + releases.
    const ob = await orderByCode(b.body.code);
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET created_at = now() - interval '2 hours' WHERE id = ${ob.id}`));
    await releaseStaleAllocations({ apply: true, ttlMin: 30 });
    expect((await orderByCode(b.body.code)).state).toBe('Cancelled');
    expect((await balance()).available).toBe(3000);
  });
});

describe('expiry', () => {
  it('hides expired points and writes them off before a spend', async () => {
    await withStore(STORE, (tx) => tx.insert(s.loyaltyLedger).values([
      { storeId: STORE, customerId: CUSTOMER, kind: 'earn', points: 300, createdAt: new Date(Date.now() - 10 * 86_400_000), expiresAt: new Date(Date.now() - 86_400_000), sourceRef: 'earn:old' },
      { storeId: STORE, customerId: CUSTOMER, kind: 'earn', points: 200, createdAt: new Date(Date.now() - 5 * 86_400_000), expiresAt: new Date(Date.now() + 86_400_000), sourceRef: 'earn:new' },
    ]));
    expect(await balance()).toEqual({ balance: 500, pendingExpiry: 300, available: 200 });
    expect((await placeOrder({ redeemPoints: 300 })).body.reason).toBe('insufficient_balance');
    // The rejected checkout rolled back entirely — including its write-off.
    expect((await ledger()).filter((x) => x.kind === 'expire')).toHaveLength(0);
    expect((await placeOrder({ redeemPoints: 150 })).status).toBe(200);
    const expired = (await ledger()).filter((x) => x.kind === 'expire');
    expect(expired.map((x) => x.points)).toEqual([-300]);
    expect(await balance()).toEqual({ balance: 50, pendingExpiry: 0, available: 50 });
  });
});

describe('manual adjust', () => {
  it('refuses to remove more than is available', async () => {
    await grant(50);
    await expect(withStore(STORE, (tx) => adjustPoints(tx, { storeId: STORE, customerId: CUSTOMER, points: -51, reason: 'too much', actor: 'test' })))
      .rejects.toBeInstanceOf(LoyaltyAdjustError);
    expect(await withStore(STORE, (tx) => lockedAvailable(tx, STORE, CUSTOMER))).toBe(50);
  });
});

describe('shop balance endpoint', () => {
  it('guest checkout cannot award points to an unverified email match', async () => {
    await withStore(STORE,tx=>tx.execute(sql`UPDATE customer SET email_verified=false WHERE id=${CUSTOMER}`));
    const placed=await placeOrder({email:'member@example.com'},false); expect(placed.status).toBe(200);
    const order=await orderByCode(placed.body.code);
    expect((order.metadata as {loyalty:{earnPoints:number}}).loyalty.earnPoints).toBe(0);
    await settle(placed.body.code,'guest-unproven');
    expect((await balance()).available).toBe(0);
  });
  it('guest checkout still awards points to the verified matching mailbox', async () => {
    const placed=await placeOrder({email:'member@example.com'},false); expect(placed.status).toBe(200);
    await settle(placed.body.code,'guest-proven');
    expect((await balance()).available).toBe(100);
  });
  it('refuses unverified loyalty redemption without creating an order', async () => {
    await grant(100);
    await withStore(STORE, tx=>tx.execute(sql`UPDATE customer SET email_verified=false WHERE id=${CUSTOMER}`));
    const response = await app.request('/v1/shop/checkout', {method:'POST',headers:{'x-store-slug':SLUG,authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':'unverified-redeem'},body:JSON.stringify({items:[{sku:SKU,quantity:1}],redeemPoints:50})});
    expect(response.status).toBe(409);
    const count=await withStore(STORE,tx=>tx.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM "order"`));
    expect(count.rows[0]?.n).toBe(0);
  });
  it('returns the signed-in customer balance and 401s anonymous callers', async () => {
    await grant(250);
    const res = await app.request('/v1/shop/account/loyalty', { headers: { 'x-store-slug': SLUG, authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body).toMatchObject({ balance: 250, available: 250, availableValue: 250, program: { enabled: true, pointsPerDollarOff: 100 } });
    expect(body.activity[0]).toMatchObject({ kind: 'adjust', points: 250 });
    expect(body.activity[0].reason).toBeUndefined();
    const anon = await app.request('/v1/shop/account/loyalty', { headers: { 'x-store-slug': SLUG } });
    expect(anon.status).toBe(401);
  });
});

describe('RLS + append-only', () => {
  it('isolates ledger rows per store and rejects cross-store writes', async () => {
    await grant(100);
    await withStore(OTHER, (tx) => tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${OTHER}, 'loyalty-other', 'Other')`));
    const mine = await withStoreApp(STORE, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM loyalty_ledger`));
    const theirs = await withStoreApp(OTHER, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM loyalty_ledger`));
    expect((mine.rows[0] as { n: number }).n).toBe(1);
    expect((theirs.rows[0] as { n: number }).n).toBe(0);
    await expectRlsRejection(withStoreApp(OTHER, (tx) => tx.execute(sql`INSERT INTO loyalty_ledger (store_id, customer_id, kind, points)
      VALUES (${STORE}, ${CUSTOMER}, 'adjust', 1000000)`)));
  });

  it('rejects UPDATE on ledger rows', async () => {
    await grant(100);
    await expect(withStore(STORE, (tx) => tx.execute(sql`UPDATE loyalty_ledger SET points = 999999`))).rejects.toThrow();
    expect((await balance()).balance).toBe(100);
  });
});

describe('admin', () => {
  const OWNER = 'cccccccc-3333-3333-3333-3333333333d1';
  const STAFF = 'cccccccc-3333-3333-3333-3333333333d2';
  async function admins() {
    await pool.query('DELETE FROM "session" WHERE admin_user_id IN ($1, $2)', [OWNER, STAFF]);
    await pool.query('DELETE FROM admin_user WHERE id IN ($1, $2)', [OWNER, STAFF]);
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${OWNER}, 'owner@loyalty.test', 'x'), (${STAFF}, 'staff@loyalty.test', 'x')`);
      await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${OWNER}, ${STORE}, 'owner')`);
      await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role, permissions) VALUES (${STAFF}, ${STORE}, 'staff', '{}'::jsonb)`);
    });
    return { owner: await createAdminSession(OWNER), staff: await createAdminSession(STAFF) };
  }
  const call = (token: string, method: string, path: string, body?: unknown) => app.request(path, {
    method, headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it('gates manual adjustments on the loyalty permission and audits them', async () => {
    const t = await admins();
    const path = `/v1/admin/customers/${CUSTOMER}/loyalty/adjust`;
    const denied = await call(t.staff, 'POST', path, { points: 100, reason: 'goodwill' });
    expect(denied.status).toBe(403);
    const ok = await call(t.owner, 'POST', path, { points: 100, reason: 'goodwill', idempotencyKey: 'adj-key-0001' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ balance: 100, available: 100 });
    // Same idempotency key → no second posting.
    await call(t.owner, 'POST', path, { points: 100, reason: 'goodwill', idempotencyKey: 'adj-key-0001' });
    expect((await balance()).balance).toBe(100);
    expect((await call(t.owner, 'POST', path, { points: -500, reason: 'too much' })).status).toBe(409);
    const audits = await withStore(STORE, (tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.action, 'loyalty_adjust')));
    expect(audits).toHaveLength(1);
    const view = await call(t.staff, 'GET', `/v1/admin/customers/${CUSTOMER}/loyalty`);
    expect(((await view.json()) as any).ledger).toHaveLength(1);
  });

  it('saves settings through the audited store-config path (managers only)', async () => {
    const t = await admins();
    const next = { ...PROGRAM, earnRatePerDollar: 3, maxRedeemPercentOfSubtotal: 50, expiryDays: 365 };
    expect((await call(t.staff, 'PUT', '/v1/admin/loyalty/settings', next)).status).toBe(403);
    const res = await call(t.owner, 'PUT', '/v1/admin/loyalty/settings', next);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(next);
    expect(await (await call(t.owner, 'GET', '/v1/admin/loyalty/settings')).json()).toEqual(next);
    expect((await call(t.owner, 'PUT', '/v1/admin/loyalty/settings', { ...next, pointsPerDollarOff: 0 })).status).toBe(400);
    const audits = await withStore(STORE, (tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.action, 'settings_update')));
    expect(audits.at(-1)!.data).toMatchObject({ section: 'loyalty', after: { earnRatePerDollar: 3 } });
  });
});
