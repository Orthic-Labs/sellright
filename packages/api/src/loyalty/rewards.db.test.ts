/**
 * REWARDS-1 DB tests (PostgreSQL, *_test database only — these wipe data).
 *
 *   bonus rules  — review / signup / first-order / birthday: configurable, off
 *                  by default, exactly one grant per trigger, reversible
 *   multiplier   — product multiplier raises the earn snapshot at checkout
 *   reviews      — submit (signed-in / guest-with-proof), verified-buyer flag,
 *                  duplicate guard, moderation queue, approval → bonus once,
 *                  aggregate, rating in the catalog manifest entries
 *   RLS          — product_review is store-isolated
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { invalidateStoreCache } from '../store-context.js';
import { createSession } from '../auth/session.js';
import { createAdminSession } from '../auth/admin-session.js';
import { clearLoginAttempts } from '../auth/rate-limit.js';
import { checkout } from '../routes/checkout.js';
import { loyalty as loyaltyRoutes } from '../routes/loyalty.js';
import { adminLoyalty } from '../routes/admin-loyalty.js';
import { reviews as reviewRoutes } from '../routes/reviews.js';
import { adminReviews } from '../routes/admin-reviews.js';
import { cart as cartRoutes } from '../routes/cart.js';
import { applyPaymentResult } from '../payments/settle.js';
import { createStoreAppRunner, expectRlsRejection } from '../db/rls-test-utils.js';
import { adjustPoints, loyaltyBalance } from './ledger.js';
import { grantBirthdayBonuses, grantFirstOrderBonus, grantReviewBonus, grantSignupBonus, reverseBonus, BonusReverseError } from './bonus.js';
import { aggregateForProduct, approveReview } from '../reviews/reviews.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishCatalogManifest } from '../manifest/catalog.js';
import { readCurrentGeneration, readCurrentGenerationV2 } from '../manifest/publish.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`rewards test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'dddddddd-4444-4444-4444-444444444444';
const OTHER = 'dddddddd-4444-4444-4444-4444444444ff';
const SLUG = 'rewards-test-store';
const PRODUCT = 'dddddddd-4444-4444-4444-4444444444a1';
const PRODUCT2 = 'dddddddd-4444-4444-4444-4444444444a2';
const VARIANT = 'dddddddd-4444-4444-4444-4444444444b1';
const VARIANT2 = 'dddddddd-4444-4444-4444-4444444444b2';
const CUSTOMER = 'dddddddd-4444-4444-4444-4444444444c1';
const BUYER2 = 'dddddddd-4444-4444-4444-4444444444c2';
const OWNER = 'dddddddd-4444-4444-4444-4444444444d1';

const PROGRAM = {
  enabled: true, earnRatePerDollar: 1, pointsPerDollarOff: 10, minRedeemPoints: 0, maxRedeemPercentOfSubtotal: null, expiryDays: null,
  reviewBonusPoints: 50, reviewBonusVerifiedOnly: true, signupBonusPoints: 0, signupBonusSince: null,
  firstOrderBonusPoints: 0, birthdayBonusPoints: 0, productMultipliers: [] as Array<{ productId: string; multiplier: number }>,
};

const app = new OpenAPIHono();
app.route('/', checkout);
app.route('/', loyaltyRoutes);
app.route('/', adminLoyalty);
app.route('/', reviewRoutes);
app.route('/', adminReviews);
app.route('/', cartRoutes);

const appPool = new Pool({ connectionString: env.DATABASE_URL_NONOWNER ?? env.DATABASE_URL });
const withStoreApp = createStoreAppRunner(appPool, { casing: 'snake_case' } as const);
afterAll(async () => { await appPool.end(); });

let token = '';
let token2 = '';
let adminToken = '';
let orderSeq = 0;

async function seed(program: Record<string, unknown> = PROGRAM, reviewsCfg: Record<string, unknown> = {}) {
  await pool.query('TRUNCATE store CASCADE');
  clearLoginAttempts('unknown', 'checkout:unknown');
  invalidateStoreCache(SLUG);
  await pool.query('DELETE FROM rate_limit_attempt');
  await pool.query('DELETE FROM "session" WHERE admin_user_id = $1', [OWNER]);
  await pool.query('DELETE FROM admin_user WHERE id = $1', [OWNER]);
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, tax_rate, config)
      VALUES (${STORE}, ${SLUG}, 'Rewards Shop', 'USD', 0, ${JSON.stringify({ loyalty: program, reviews: reviewsCfg })}::jsonb)`);
    for (const [pid, vid, slug, sku] of [[PRODUCT, VARIANT, 'rp', 'RW-1'], [PRODUCT2, VARIANT2, 'rp2', 'RW-2']] as const) {
      await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${pid}, ${STORE}, ${slug}, ${'Product ' + slug}, 'active')`);
      await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type)
        VALUES (${vid}, ${STORE}, ${pid}, ${sku}, ${'Variant ' + sku}, 10000, 'digital_download')`);
      await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${vid}, ${STORE}, 100, 0)`);
    }
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, email_verified, first_name, last_name, created_at) VALUES (${CUSTOMER}, ${STORE}, 'member@example.com', true, 'Mia', 'Ranger', now())`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, email_verified, created_at) VALUES (${BUYER2}, ${STORE}, 'other@example.com', true, now())`);
    token = await createSession(tx, STORE, CUSTOMER);
    token2 = await createSession(tx, STORE, BUYER2);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${OWNER}, 'owner@rewards.test', 'x')`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${OWNER}, ${STORE}, 'owner')`);
  });
  adminToken = await createAdminSession(OWNER);
}

/** Insert a PAID order for `customerId` containing `variantId` (+ optionally a PendingPayment one). */
async function paidOrder(customerId: string | null, variantId = VARIANT, email = 'member@example.com', state: 'Paid' | 'PendingPayment' = 'Paid', snapshot?: object) {
  const id = crypto.randomUUID();
  const code = `RW${String(++orderSeq).padStart(5, '0')}`;
  await withStore(STORE, async (tx) => {
    await tx.insert(s.order).values({
      id, storeId: STORE, code, customerId, state, currency: 'USD', subtotal: 10000, grandTotal: 10000, placedAt: new Date(),
      metadata: { contact: { email }, ...(snapshot ? { loyalty: snapshot } : {}) },
    });
    await tx.insert(s.orderLine).values({ storeId: STORE, orderId: id, variantId, variantSku: 'X', variantName: 'X', quantity: 1, unitPrice: 10000, lineSubtotal: 10000, lineTotal: 10000 });
  });
  return { id, code };
}

const call = (method: string, path: string, body?: unknown, auth: string | null = adminToken, extra: Record<string, string> = {}) => app.request(path, {
  method, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), 'x-store-slug': SLUG, 'content-type': 'application/json', ...extra },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const ledger = () => withStore(STORE, (tx) => tx.select().from(s.loyaltyLedger).orderBy(s.loyaltyLedger.createdAt));
const balanceOf = (id = CUSTOMER) => withStore(STORE, (tx) => loyaltyBalance(tx, id));
const emails = (kind: string) => withStore(STORE, (tx) => tx.select().from(s.emailOutbox).where(eq(s.emailOutbox.kind, kind)));
let ipSeq = 0; // a distinct client IP per submit so the per-IP review throttle never interferes
const submit = (slug: string, body: Record<string, unknown>, auth: string | null = token) => call('POST', `/v1/shop/catalog/products/${slug}/reviews`, body, auth, { 'x-real-ip': `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}` });
async function manifestEntries() {
  const outDir = await mkdtemp(join(tmpdir(), 'sr-rewards-'));
  try {
    await publishCatalogManifest({ outDir, storeSlug: SLUG });
    const v1 = (await readCurrentGeneration(outDir, SLUG))!;
    const v2 = (await readCurrentGenerationV2(outDir, SLUG))!;
    return { manifestProducts: v1.manifest.products as any[], detailsV1: v1.details as any[], detailsV2: v2.details as any[] };
  } finally { await rm(outDir, { recursive: true, force: true }); }
}
const GOOD = { rating: 5, title: 'Great', body: 'Really solid, held an edge all season.' };

beforeEach(async () => { await seed(); });

describe('bonus rules are off by default and one-shot', () => {
  it('review bonus pays once per approved review, only for verified buyers by default', async () => {
    await paidOrder(CUSTOMER);
    const sub = await submit('rp', GOOD);
    expect(sub.status).toBe(201);
    const { id, status, verifiedBuyer } = await sub.json() as any;
    expect(status).toBe('pending');
    expect(verifiedBuyer).toBe(true);
    expect((await balanceOf()).balance).toBe(0); // nothing on submit

    const approve = await call('POST', `/v1/admin/reviews/${id}/approve`);
    expect(approve.status).toBe(200);
    expect((await approve.json() as any).bonusPoints).toBe(50);
    expect((await balanceOf()).balance).toBe(50);
    // Approve again, and replay the grant directly: still a single row.
    await call('POST', `/v1/admin/reviews/${id}/approve`);
    expect(await withStore(STORE, (tx) => grantReviewBonus(tx, STORE, id))).toMatchObject({ points: 0 });
    const bonuses = (await ledger()).filter((r) => r.kind === 'bonus');
    expect(bonuses).toHaveLength(1);
    expect(bonuses[0]).toMatchObject({ points: 50, sourceRef: `bonus:review:${id}`, reason: 'bonus_review' });
    // Email: review_approved with points (queued once even after re-approve).
    expect(await emails('review_approved')).toHaveLength(1);
    expect(JSON.stringify((await emails('review_approved'))[0]!.payload)).toContain('50 points');
  });

  it('an unverified-buyer review earns nothing while reviewBonusVerifiedOnly is on, and earns when it is off', async () => {
    const sub = await submit('rp2', GOOD); // CUSTOMER has no paid order for rp2
    const { id, verifiedBuyer } = await sub.json() as any;
    expect(verifiedBuyer).toBe(false);
    expect((await (await call('POST', `/v1/admin/reviews/${id}/approve`)).json() as any).bonusPoints).toBe(0);
    await seed({ ...PROGRAM, reviewBonusVerifiedOnly: false });
    const again = await (await submit('rp2', GOOD)).json() as any;
    expect((await (await call('POST', `/v1/admin/reviews/${again.id}/approve`)).json() as any).bonusPoints).toBe(50);
  });

  it('review bonus respects the program switch and a zero amount', async () => {
    await seed({ ...PROGRAM, enabled: false });
    await paidOrder(CUSTOMER);
    const a = await (await submit('rp', GOOD)).json() as any;
    expect((await (await call('POST', `/v1/admin/reviews/${a.id}/approve`)).json() as any).bonusPoints).toBe(0);
    await seed({ ...PROGRAM, reviewBonusPoints: 0 });
    await paidOrder(CUSTOMER);
    const b = await (await submit('rp', GOOD)).json() as any;
    expect((await (await call('POST', `/v1/admin/reviews/${b.id}/approve`)).json() as any).bonusPoints).toBe(0);
    expect((await ledger())).toHaveLength(0);
  });

  it('signup bonus pays once per customer, only after activation and only to verified customers', async () => {
    const since = new Date(Date.now() - 3600_000).toISOString();
    await seed({ ...PROGRAM, signupBonusPoints: 200, signupBonusSince: since });
    expect(await withStore(STORE, (tx) => grantSignupBonus(tx, STORE, CUSTOMER))).toBe(200);
    expect(await withStore(STORE, (tx) => grantSignupBonus(tx, STORE, CUSTOMER))).toBe(0);
    expect((await ledger()).filter((r) => r.kind === 'bonus')).toHaveLength(1);
    // A customer created before activation never qualifies.
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE customer SET created_at = ${new Date(Date.now() - 86_400_000)} WHERE id = ${BUYER2}`));
    expect(await withStore(STORE, (tx) => grantSignupBonus(tx, STORE, BUYER2))).toBe(0);
    // Unverified never qualifies; missing activation stamp fails closed.
    await seed({ ...PROGRAM, signupBonusPoints: 200, signupBonusSince: null });
    expect(await withStore(STORE, (tx) => grantSignupBonus(tx, STORE, CUSTOMER))).toBe(0);
    await seed({ ...PROGRAM, signupBonusPoints: 200, signupBonusSince: since });
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE customer SET email_verified = false WHERE id = ${CUSTOMER}`));
    expect(await withStore(STORE, (tx) => grantSignupBonus(tx, STORE, CUSTOMER))).toBe(0);
  });

  it('admin settings stamp signupBonusSince on activation and clear it when switched off', async () => {
    const res = await call('PUT', '/v1/admin/loyalty/settings', { ...PROGRAM, signupBonusPoints: 100 });
    const on = await res.json() as any;
    expect(on.signupBonusSince).toMatch(/^\d{4}-/);
    const keep = await (await call('PUT', '/v1/admin/loyalty/settings', { ...PROGRAM, signupBonusPoints: 150, signupBonusSince: null })).json() as any;
    expect(keep.signupBonusSince).toBe(on.signupBonusSince); // changing the amount does not reset the window
    const off = await (await call('PUT', '/v1/admin/loyalty/settings', { ...PROGRAM, signupBonusPoints: 0 })).json() as any;
    expect(off.signupBonusSince).toBeNull();
  });

  it('first-order bonus is paid once on the first paid order, never when earlier paid history exists', async () => {
    await seed({ ...PROGRAM, firstOrderBonusPoints: 500 });
    const first = await paidOrder(CUSTOMER);
    expect(await withStore(STORE, (tx) => grantFirstOrderBonus(tx, STORE, first.id))).toBe(500);
    expect(await withStore(STORE, (tx) => grantFirstOrderBonus(tx, STORE, first.id))).toBe(0);
    const second = await paidOrder(CUSTOMER);
    expect(await withStore(STORE, (tx) => grantFirstOrderBonus(tx, STORE, second.id))).toBe(0);
    expect((await ledger()).filter((r) => r.sourceRef === `bonus:first_order:${CUSTOMER}`)).toHaveLength(1);
    // A returning customer (history imported/paid earlier) never qualifies.
    const hist = await paidOrder(BUYER2, VARIANT, 'other@example.com');
    const fresh = await paidOrder(BUYER2, VARIANT, 'other@example.com');
    expect(await withStore(STORE, (tx) => grantFirstOrderBonus(tx, STORE, fresh.id))).toBe(0);
    void hist;
  });

  it('paying an order posts earn + first-order bonus and queues ONE points_earned email with the balance', async () => {
    await seed({ ...PROGRAM, firstOrderBonusPoints: 500 });
    const o = await paidOrder(CUSTOMER, VARIANT, 'member@example.com', 'PendingPayment', { redeemPoints: 0, pointsDiscount: 0, earnPoints: 100, expiryDays: null });
    await withStore(STORE, (tx) => applyPaymentResult(tx, {
      storeId: STORE, order: { id: o.id, state: 'PendingPayment', grandTotal: 10000, currency: 'USD', customerId: CUSTOMER, code: o.code },
      method: 'stripe', amount: 10000, result: { state: 'Settled', providerRef: 'pi_rewards_1', metadata: { gateway: { mode: 'test' } } },
    }));
    expect((await balanceOf()).balance).toBe(600);
    const mails = await emails('points_earned');
    expect(mails).toHaveLength(1);
    const text = JSON.stringify(mails[0]!.payload);
    expect(text).toContain('600 points'); // total posted
    expect(text).toContain('First order bonus');
    expect(text).toContain('New balance: 600');
  });

  it('birthday bonus: once per year, leap-day birthdays on Feb 28 in common years, unverified skipped', async () => {
    await seed({ ...PROGRAM, birthdayBonusPoints: 300 });
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE customer SET birth_month = 2, birth_day = 29 WHERE id = ${CUSTOMER}`));
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE customer SET birth_month = 7, birth_day = 4, email_verified = false WHERE id = ${BUYER2}`));
    expect(await withStore(STORE, (tx) => grantBirthdayBonuses(tx, STORE, new Date('2027-02-28T10:00:00Z')))).toBe(1);
    expect(await withStore(STORE, (tx) => grantBirthdayBonuses(tx, STORE, new Date('2027-02-28T23:00:00Z')))).toBe(0);
    expect(await withStore(STORE, (tx) => grantBirthdayBonuses(tx, STORE, new Date('2028-02-28T10:00:00Z')))).toBe(0); // leap year: due on the 29th
    expect(await withStore(STORE, (tx) => grantBirthdayBonuses(tx, STORE, new Date('2028-02-29T10:00:00Z')))).toBe(1); // new year, new grant
    expect(await withStore(STORE, (tx) => grantBirthdayBonuses(tx, STORE, new Date('2027-07-04T10:00:00Z')))).toBe(0); // unverified
    expect((await ledger()).filter((r) => r.kind === 'bonus').map((r) => r.sourceRef)).toEqual([`bonus:birthday:${CUSTOMER}:2027`, `bonus:birthday:${CUSTOMER}:2028`]);
    expect(await emails('points_earned')).toHaveLength(2);
  });

  it('customer can save a birthday once; invalid dates are rejected', async () => {
    const put = (body: unknown, auth: string | null = token) => call('PUT', '/v1/shop/account/birthday', body, auth);
    expect((await put({ month: 2, day: 30 })).status).toBe(400);
    expect((await put({ month: 6, day: 15 }, null)).status).toBe(401);
    expect((await put({ month: 6, day: 15 })).status).toBe(200);
    expect((await put({ month: 7, day: 1 })).status).toBe(409);
    const view = await (await call('GET', '/v1/shop/account/loyalty', undefined, token)).json() as any;
    expect(view.birthday).toEqual({ month: 6, day: 15 });
  });

  it('bonus rows are reversible once by an admin; the trigger cannot re-grant; shortfall is recorded', async () => {
    const o = await paidOrder(CUSTOMER);
    const sub = await (await submit('rp', GOOD)).json() as any;
    await call('POST', `/v1/admin/reviews/${sub.id}/approve`);
    const bonus = (await ledger()).find((r) => r.kind === 'bonus')!;
    // The shopper spends 30 of the 50 first, so only 20 is recoverable.
    await withStore(STORE, (tx) => tx.insert(s.loyaltyLedger).values({ storeId: STORE, customerId: CUSTOMER, kind: 'redeem', points: -30, sourceRef: `redeem:${o.id}`, orderId: o.id }));
    const rev = await call('POST', `/v1/admin/loyalty/ledger/${bonus.id}/reverse`, { reason: 'review farming' });
    expect(rev.status).toBe(200);
    expect(await rev.json()).toEqual({ reversed: 20, shortfall: 30 });
    expect((await balanceOf()).balance).toBe(0);
    expect((await call('POST', `/v1/admin/loyalty/ledger/${bonus.id}/reverse`, { reason: 'again' })).status).toBe(409);
    // Replaying the trigger does not re-grant.
    expect(await withStore(STORE, (tx) => grantReviewBonus(tx, STORE, sub.id))).toMatchObject({ points: 0 });
    // Non-bonus rows are not reversible through this path.
    const adj = await withStore(STORE, (tx) => adjustPoints(tx, { storeId: STORE, customerId: CUSTOMER, points: 10, reason: 'manual', actor: 't' }));
    await expect(withStore(STORE, (tx) => reverseBonus(tx, { storeId: STORE, ledgerId: adj.id!, actor: 't', reason: 'x' }))).rejects.toBeInstanceOf(BonusReverseError);
    const view = await (await call('GET', `/v1/admin/customers/${CUSTOMER}/loyalty`)).json() as any;
    expect(view.ledger.find((r: any) => r.id === bonus.id)).toMatchObject({ rule: 'review', reversible: false });
  });
});

describe('product multiplier', () => {
  it('raises the earn snapshot at checkout and the cart preview for chosen products only', async () => {
    await seed({ ...PROGRAM, productMultipliers: [{ productId: PRODUCT, multiplier: 3 }] });
    const est = await call('POST', '/v1/shop/cart/estimate', { items: [{ sku: 'RW-1', quantity: 1 }, { sku: 'RW-2', quantity: 1 }] }, null);
    // $200: base 200 points, +2x extra on the $100 multiplied line = +200.
    expect((await est.json() as any).pointsToEarn).toBe(400);
    const res = await call('POST', '/v1/shop/checkout', { items: [{ sku: 'RW-1', quantity: 1 }] }, token, { 'idempotency-key': `mult-${Date.now()}` });
    expect(res.status).toBe(200);
    const code = (await res.json() as any).code;
    const [o] = await withStore(STORE, (tx) => tx.select().from(s.order).where(eq(s.order.code, code)));
    expect((o!.metadata as any).loyalty.earnPoints).toBe(300);
  });
});

describe('reviews', () => {
  it('guests need the setting AND an order code + matching email; verified-buyer is proven server-side', async () => {
    const o = await paidOrder(null, VARIANT, 'guest@example.net');
    const body = { ...GOOD, name: 'Gus', email: 'guest@example.net', orderCode: o.code };
    expect((await submit('rp', body, null)).status).toBe(401); // allowGuests off by default
    await seed(PROGRAM, { allowGuests: true });
    const o2 = await paidOrder(null, VARIANT, 'guest@example.net');
    expect((await submit('rp', { ...GOOD, email: 'guest@example.net', orderCode: 'NOPE00' }, null)).status).toBe(403);
    expect((await submit('rp', { ...GOOD, email: 'wrong@example.net', orderCode: o2.code }, null)).status).toBe(403);
    expect((await submit('rp2', { ...GOOD, email: 'guest@example.net', orderCode: o2.code }, null)).status).toBe(403); // order lacks that product
    const ok = await submit('rp', { ...GOOD, name: 'Gus', email: 'guest@example.net', orderCode: o2.code }, null);
    expect(ok.status).toBe(201);
    expect((await ok.json() as any).verifiedBuyer).toBe(true);
    // Guest review: approved, but no customer → no bonus.
    const [row] = await withStore(STORE, (tx) => tx.select().from(s.productReview));
    expect((await (await call('POST', `/v1/admin/reviews/${row!.id}/approve`)).json() as any).bonusPoints).toBe(0);
    expect((await ledger())).toHaveLength(0);
  });

  it('one review per product per reviewer; validation bounds; honeypot; unpublished states hidden', async () => {
    expect((await submit('rp', GOOD)).status).toBe(201);
    expect((await submit('rp', GOOD)).status).toBe(409);
    expect((await submit('rp', { ...GOOD, rating: 6 })).status).toBe(400);
    expect((await submit('rp', { ...GOOD, rating: 0 })).status).toBe(400);
    expect((await submit('rp2', { ...GOOD, body: 'short' })).status).toBe(400);
    expect((await submit('nope', GOOD)).status).toBe(404);
    expect((await submit('rp2', { ...GOOD, honeypot: 'bot' })).status).toBe(201);
    expect(await withStore(STORE, (tx) => tx.select().from(s.productReview))).toHaveLength(1); // honeypot stored nothing
    // Pending reviews are invisible publicly.
    const list = await (await call('GET', '/v1/shop/catalog/products/rp/reviews', undefined, null)).json() as any;
    expect(list).toMatchObject({ count: 0, average: 0, reviews: [] });
  });

  it('throttles review submissions per IP', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call('POST', '/v1/shop/catalog/products/rp2/reviews', GOOD, token, { 'x-real-ip': '10.8.8.8' })).status;
    expect(last).toBe(429);
  });

  it('requirePurchase and disabled switches are enforced; unverified email cannot review', async () => {
    await seed(PROGRAM, { requirePurchase: true });
    expect((await submit('rp', GOOD)).status).toBe(403);
    await paidOrder(CUSTOMER);
    expect((await submit('rp', GOOD)).status).toBe(201);
    await seed(PROGRAM, { enabled: false });
    expect((await submit('rp', GOOD)).status).toBe(403);
    await seed(PROGRAM);
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE customer SET email_verified = false WHERE id = ${CUSTOMER}`));
    expect((await submit('rp', GOOD)).status).toBe(403);
  });

  it('autoApprove publishes immediately and still pays the bonus exactly once', async () => {
    await seed(PROGRAM, { autoApprove: true });
    await paidOrder(CUSTOMER);
    const r = await (await submit('rp', GOOD)).json() as any;
    expect(r.status).toBe('approved');
    expect((await balanceOf()).balance).toBe(50);
    expect(((await (await call('GET', '/v1/shop/catalog/products/rp/reviews', undefined, null)).json()) as any).count).toBe(1);
    await call('POST', `/v1/admin/reviews/${r.id}/approve`);
    expect((await balanceOf()).balance).toBe(50);
  });

  it('moderation queue, aggregate, distribution, reply, reject and delete', async () => {
    await paidOrder(CUSTOMER); await paidOrder(BUYER2, VARIANT, 'other@example.com');
    const a = await (await submit('rp', { ...GOOD, rating: 5 }, token)).json() as any;
    const b = await (await submit('rp', { ...GOOD, rating: 2, title: 'Meh' }, token2)).json() as any;
    const queue = await (await call('GET', '/v1/admin/reviews?status=pending')).json() as any;
    expect(queue.total).toBe(2);
    expect(queue.counts).toEqual({ pending: 2, approved: 0, rejected: 0 });
    expect(queue.items[0]).toMatchObject({ productSlug: 'rp', authorEmail: expect.any(String) });

    await call('POST', `/v1/admin/reviews/${a.id}/approve`);
    await call('POST', `/v1/admin/reviews/${b.id}/approve`);
    const agg = await withStore(STORE, (tx) => aggregateForProduct(tx, STORE, PRODUCT));
    expect(agg).toMatchObject({ count: 2, average: 3.5, distribution: { '2': 1, '5': 1 } });

    expect((await call('PUT', `/v1/admin/reviews/${a.id}/reply`, { reply: 'Thanks for the kind words.' })).status).toBe(200);
    const pub = await (await call('GET', '/v1/shop/catalog/products/rp/reviews?sort=lowest', undefined, null)).json() as any;
    expect(pub).toMatchObject({ count: 2, average: 3.5, bonusPoints: 50 });
    expect(pub.reviews[0]).toMatchObject({ rating: 2 });
    expect(pub.reviews.find((r: any) => r.id === a.id).reply).toBe('Thanks for the kind words.');
    expect(JSON.stringify(pub)).not.toContain('example.com'); // emails never public

    await call('POST', `/v1/admin/reviews/${b.id}/reject`);
    expect((await withStore(STORE, (tx) => aggregateForProduct(tx, STORE, PRODUCT))).count).toBe(1);
    expect((await call('DELETE', `/v1/admin/reviews/${a.id}`)).status).toBe(200);
    expect((await withStore(STORE, (tx) => aggregateForProduct(tx, STORE, PRODUCT))).count).toBe(0);
    expect((await call('POST', `/v1/admin/reviews/${a.id}/approve`)).status).toBe(404);
    const audits = await withStore(STORE, (tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.entity, 'review')));
    expect(audits.map((x) => x.action)).toEqual(expect.arrayContaining(['review_approve', 'review_reject', 'review_delete', 'review_reply']));
  });

  it('staff without write access cannot moderate; settings round-trip', async () => {
    const res = await call('PUT', '/v1/admin/reviews-settings', { enabled: true, allowGuests: true, autoApprove: false, requirePurchase: true });
    expect(await res.json()).toEqual({ enabled: true, allowGuests: true, autoApprove: false, requirePurchase: true });
    expect(await (await call('GET', '/v1/admin/reviews-settings')).json()).toMatchObject({ allowGuests: true, requirePurchase: true });
    expect((await call('GET', '/v1/admin/reviews', undefined, null)).status).toBe(401);
  });

  it('manifest entries carry the approved rating only when reviews exist', async () => {
    await paidOrder(CUSTOMER);
    const a = await (await submit('rp', GOOD)).json() as any;
    let entries = await manifestEntries();
    expect(entries.detailsV2.find((d) => d.slug === 'rp')!.rating).toBeUndefined();
    await call('POST', `/v1/admin/reviews/${a.id}/approve`);
    entries = await manifestEntries();
    expect(entries.detailsV2.find((d) => d.slug === 'rp')!.rating).toEqual({ average: 5, count: 1 });
    expect(entries.manifestProducts.find((d) => d.slug === 'rp')).toMatchObject({ rating: { average: 5, count: 1 } });
    expect(entries.detailsV1.find((d) => d.slug === 'rp')).toMatchObject({ rating: { average: 5, count: 1 } }); // what the storefront PDP reads
    expect(entries.detailsV2.find((d) => d.slug === 'rp2')!.rating).toBeUndefined();
  });
});

describe('summary dashboard', () => {
  it('reports issued / redeemed / outstanding and liability in dollars', async () => {
    await withStore(STORE, async (tx) => {
      await adjustPoints(tx, { storeId: STORE, customerId: CUSTOMER, points: 1000, reason: 'seed', actor: 't' });
      await tx.insert(s.loyaltyLedger).values({ storeId: STORE, customerId: CUSTOMER, kind: 'bonus', points: 500, sourceRef: 'bonus:test:1', reason: 'bonus_review', metadata: { rule: 'review' } });
      await tx.insert(s.loyaltyLedger).values({ storeId: STORE, customerId: CUSTOMER, kind: 'redeem', points: -300, sourceRef: 'redeem:test:1' });
      await tx.insert(s.loyaltyLedger).values({ storeId: STORE, customerId: BUYER2, kind: 'earn', points: 200, sourceRef: 'earn:test:1' });
    });
    const sum = await (await call('GET', '/v1/admin/loyalty/summary')).json() as any;
    expect(sum).toMatchObject({ enabled: true, issued: 1700, redeemed: 300, outstanding: 1400, customersWithBalance: 2, pointsPerDollarOff: 10, last30Days: { issued: 1700, redeemed: 300 } });
    expect(sum.liabilityCents).toBe(14000); // 1400 points at 10 points = $1 → $140.00
    expect(sum.byKind.find((k: any) => k.kind === 'bonus')).toMatchObject({ points: 500, entries: 1 });
  });
});

describe('RLS', () => {
  it('isolates product_review per store and rejects cross-store writes', async () => {
    const sub = await submit('rp', GOOD);
    expect(sub.status).toBe(201);
    await withStore(OTHER, (tx) => tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${OTHER}, 'rewards-other', 'Other')`));
    const mine = await withStoreApp(STORE, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM product_review`));
    const theirs = await withStoreApp(OTHER, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM product_review`));
    expect((mine.rows[0] as { n: number }).n).toBe(1);
    expect((theirs.rows[0] as { n: number }).n).toBe(0);
    await expectRlsRejection(withStoreApp(OTHER, (tx) => tx.execute(sql`INSERT INTO product_review (store_id, product_id, author_name, author_email, rating, body)
      VALUES (${STORE}, ${PRODUCT}, 'x', 'x@x.x', 5, 'cross-store write attempt')`)));
  });

  it('approveReview is a no-op for another store\'s review id', async () => {
    const sub = await (await submit('rp', GOOD)).json() as any;
    await withStore(OTHER, (tx) => tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${OTHER}, 'rewards-other', 'Other')`));
    const out = await withStore(OTHER, (tx) => approveReview(tx, { storeId: OTHER, reviewId: sub.id, actor: 'x', store: { name: 'o', currency: 'USD', config: {} } }));
    expect(out).toBeNull();
  });
});
