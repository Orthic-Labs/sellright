/** Disposable *_test database only. Covers capability adoption & exactly-once cart effects. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import * as s from '../db/schema.js';
import { invalidateStoreCache } from '../store-context.js';
import { resolveCustomer } from '../auth/session.js';
import { auth } from './auth.js';
import { cart } from './cart.js';
import { account } from './account.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'legacy session/cart fixtures');
const STORE = 'a1000000-0000-4000-8000-000000000001';
const OTHER = 'a1000000-0000-4000-8000-000000000002';
const CUSTOMER = 'a1000000-0000-4000-8000-000000000003';
const PRODUCT = 'a1000000-0000-4000-8000-000000000004';
const VARIANT = 'a1000000-0000-4000-8000-000000000005';
const SESSION = 'a1000000-0000-4000-8000-000000000006';
const GRANT = 'a1000000-0000-4000-8000-000000000007';
const CART = 'a1000000-0000-4000-8000-000000000008';
const TOKEN = 'valid_frozen_source_proof';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const app = new OpenAPIHono();
app.route('/', auth); app.route('/', cart); app.route('/', account);
const headers = (extra: Record<string, string> = {}) => ({ 'x-store-slug': 'legacy-migration-test', 'content-type': 'application/json', ...extra });
const transfer = (items: Array<{ variantId: string; quantity: number }> | null, over: Record<string, unknown> = {}, credential = `sr_cust=${TOKEN}`) =>
  app.request('/v1/shop/cart/legacy-migration', { method: 'POST', headers: headers({ cookie: credential }),
    body: JSON.stringify({ claimId: randomUUID(), items, ...over }) });
async function seed(guest = false) {
  await withStore(STORE, async tx => {
    await tx.insert(s.store).values([{ id: STORE, slug: 'legacy-migration-test', name: 'Legacy', config: { auth: { renewable: true, sessionTtlDays: 365 } } },
      { id: OTHER, slug: 'legacy-other-test', name: 'Other' }]);
    await tx.insert(s.customer).values({ id: CUSTOMER, storeId: STORE, email: 'buyer@example.com', emailVerified: true });
    await tx.insert(s.product).values({ id: PRODUCT, storeId: STORE, slug: 'widget', name: 'Widget', status: 'active' });
    await tx.insert(s.productVariant).values({ id: VARIANT, storeId: STORE, productId: PRODUCT, sku: 'WIDGET', name: 'Widget', price: 1000, metafields: { vendureId: 17 } });
    await tx.insert(s.stock).values({ variantId: VARIANT, storeId: STORE, onHand: 3, allocated: 0 });
    const expiresAt = new Date(Date.now() + 3600000);
    if (!guest) await tx.insert(s.session).values({ id: SESSION, storeId: STORE, customerId: CUSTOMER, tokenHash: hash(TOKEN), expiresAt, legacyExpiresAt: expiresAt });
    await tx.insert(s.cart).values({ id: CART, storeId: STORE, token: 'target-cart-capability', customerId: guest ? null : CUSTOMER, expiresAt });
    await tx.insert(s.cartLine).values({ storeId: STORE, cartId: CART, variantId: VARIANT, sku: 'WIDGET', quantity: 2 });
    await tx.insert(s.legacySessionGrant).values({ id: GRANT, storeId: STORE, sourceKey: 'vendure:test', sourceSessionId: '101',
      sourceUserId: guest ? null : '11', sourceCustomerId: guest ? null : '12', sourceEmail: guest ? null : 'buyer@example.com',
      tokenHash: hash(TOKEN), authenticated: !guest, customerId: guest ? null : CUSTOMER, sessionId: guest ? null : SESSION,
      cartId: CART, expiresAt });
  });
  invalidateStoreCache();
}
async function wipe() { await pool.query('TRUNCATE store CASCADE'); await pool.query('DELETE FROM session'); }
beforeEach(async () => { await wipe(); await seed(); });
afterAll(async () => { await wipe(); await pool.end(); });

describe('legacy customer bootstrap', () => {
  it('adopts exact imported token into HttpOnly cookie, keeps original expiry & clears readable bearer', async () => {
    const before = await withStore(STORE, tx => tx.select().from(s.session).where(eq(s.session.id, SESSION)));
    const response = await app.request('/v1/shop/auth/me', { headers: headers({ cookie: `authToken=${TOKEN}`, 'x-forwarded-proto': 'https' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: CUSTOMER });
    const cookies = response.headers.get('set-cookie')!;
    expect(cookies).toContain(`sr_cust=${TOKEN}; HttpOnly;`);
    expect(cookies).toContain('sr_cust_csrf=');
    expect(cookies).toContain('authToken=;');
    expect(cookies).not.toContain('__vendure_session=');
    await withStore(STORE, tx => resolveCustomer(tx, TOKEN, true));
    const after = await withStore(STORE, tx => tx.select().from(s.session).where(eq(s.session.id, SESSION)));
    expect(after[0]!.expiresAt).toEqual(before[0]!.expiresAt);
  });
  it('cannot recreate a revoked target session or trust tenant/customer JSON metadata', async () => {
    await withStore(STORE, tx => tx.delete(s.session).where(eq(s.session.id, SESSION)));
    const wrapped = Buffer.from(JSON.stringify({ token: TOKEN, customerId: CUSTOMER, authenticated: true })).toString('base64');
    const response = await app.request('/v1/shop/auth/me', { headers: headers({ cookie: `__vendure_session=${encodeURIComponent(wrapped)}` }) });
    expect(response.status).toBe(401);
    expect(await withStore(STORE, tx => tx.select().from(s.session))).toHaveLength(0);
  });
  it('erases customer, source-email grant & receipt without resurrecting legacy authority', async () => {
    expect((await transfer(null)).status).toBe(200);
    expect((await transfer([{ variantId: '17', quantity: 1 }])).status).toBe(200);
    const erased = await app.request('/v1/shop/account', { method: 'DELETE', headers: headers({ authorization: `Bearer ${TOKEN}` }) });
    expect(erased.status).toBe(200);
    const rows = await withStore(STORE, async tx => ({ customers: await tx.select().from(s.customer),
      grants: await tx.select().from(s.legacySessionGrant), claims: await tx.select().from(s.legacyCartClaim), sessions: await tx.select().from(s.session) }));
    expect(rows).toEqual({ customers: [], grants: [], claims: [], sessions: [] });
    const wrapped = Buffer.from(JSON.stringify({ token: TOKEN })).toString('base64');
    expect((await app.request('/v1/shop/auth/me', { headers: headers({ cookie: `__vendure_session=${wrapped}` }) })).status).toBe(401);
    expect((await (await transfer(null, {}, `__vendure_session=${wrapped}`)).json()).cart).toBeNull();
  });
  it('rejects expired grants, guest grants & cross-tenant carriers', async () => {
    await withStore(STORE, tx => tx.update(s.legacySessionGrant).set({ expiresAt: new Date(0) }).where(eq(s.legacySessionGrant.id, GRANT)));
    expect((await app.request('/v1/shop/auth/me', { headers: headers({ cookie: `authToken=${TOKEN}` }) })).status).toBe(401);
    expect((await app.request('/v1/shop/auth/me', { headers: { ...headers({ cookie: `authToken=${TOKEN}` }), 'x-store-slug': 'legacy-other-test' } })).status).toBe(401);
    await wipe(); await seed(true);
    expect((await app.request('/v1/shop/auth/me', { headers: headers({ cookie: `authToken=${TOKEN}` }) })).status).toBe(401);
  });
});

describe('atomic legacy cart reconciliation', () => {
  it('adopts source-only cart without rebuilding it', async () => {
    const response = await transfer(null);
    expect(response.status).toBe(200);
    expect((await response.json()).cart).toMatchObject({ token: 'target-cart-capability', revision: 0, lines: [{ sku: 'WIDGET', quantity: 2 }] });
    expect(await withStore(STORE, tx => tx.select().from(s.legacyCartClaim))).toEqual([expect.objectContaining({ sourceOnly: true, cartId: CART, retiredAt: null })]);
  });
  it('durably replays source-only lost responses & consumes adoption across different tab claims', async () => {
    const claimId = randomUUID();
    const results = await Promise.all([transfer(null, { claimId }), transfer(null, { claimId })]);
    for (const result of results) expect((await result.json()).cart.token).toBe('target-cart-capability');
    expect((await (await transfer(null)).json()).cart).toBeNull();
    expect(await withStore(STORE, tx => tx.select().from(s.legacyCartClaim))).toHaveLength(1);
    // A late browser snapshot still replaces the same untouched source cart once.
    expect((await (await transfer([{ variantId: '17', quantity: 3 }])).json()).cart).toMatchObject({ token: 'target-cart-capability', lines: [{ quantity: 3 }] });
  });
  it.each(['converted', 'merged'])('never re-adopts a %s cart on original receipt or fresh reload', async status => {
    const claimId = randomUUID();
    expect((await transfer(null, { claimId })).status).toBe(200);
    await withStore(STORE, tx => tx.update(s.cart).set({ status }).where(eq(s.cart.id, CART)));
    expect((await (await transfer(null, { claimId })).json()).cart).toBeNull();
    expect((await (await transfer(null)).json()).cart).toBeNull();
    expect(await withStore(STORE, tx => tx.select().from(s.legacyCartClaim))).toEqual([expect.objectContaining({ cartId: null, retiredAt: expect.any(Date) })]);
  });
  it('records retirement when source cart finished before first adoption & never returns a terminal local receipt', async () => {
    await withStore(STORE, tx => tx.update(s.cart).set({ status: 'converted' }).where(eq(s.cart.id, CART)));
    expect((await (await transfer(null)).json()).cart).toBeNull();
    expect((await transfer([{ variantId: '17', quantity: 3 }])).status).toBe(409);
    await withStore(STORE, tx => tx.update(s.cart).set({ status: 'active' }).where(eq(s.cart.id, CART)));
    const claimId = randomUUID();
    expect((await transfer([{ variantId: '17', quantity: 1 }], { claimId })).status).toBe(200);
    await withStore(STORE, tx => tx.update(s.cart).set({ status: 'converted' }).where(eq(s.cart.id, CART)));
    expect((await (await transfer([{ variantId: '17', quantity: 1 }], { claimId })).json()).cart).toBeNull();
  });
  it('replaces source snapshot with numeric local IDs, revalidates coupon/country & preserves unavailable lines', async () => {
    const response = await transfer([{ variantId: '17', quantity: 4 }, { variantId: '999', quantity: 1 }], { couponCode: 'INVALID', countryCode: 'CA' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cart.lines).toEqual(expect.arrayContaining([expect.objectContaining({ sku: 'WIDGET', quantity: 4, available: false }),
      expect.objectContaining({ sku: 'vendure-unresolved:999', quantity: 1, available: false })]));
    expect(body.cart.coupon).toMatchObject({ code: 'INVALID', applied: false });
    expect(body.unresolved).toEqual([{ variantId: '999', quantity: 1 }]);
    const effects = await withStore(STORE, async tx => ({ stock: await tx.select().from(s.stock), orders: await tx.select().from(s.order),
      payments: await tx.select().from(s.payment), usage: await tx.select().from(s.promotionUsage) }));
    expect(effects.stock[0]).toMatchObject({ onHand: 3, allocated: 0 });
    expect(effects.orders).toHaveLength(0); expect(effects.payments).toHaveLength(0); expect(effects.usage).toHaveLength(0);
  });
  it('replays lost-response & concurrent retries without adding quantities twice', async () => {
    const claimId = randomUUID();
    const responses = await Promise.all([transfer([{ variantId: '17', quantity: 3 }], { claimId }), transfer([{ variantId: '17', quantity: 3 }], { claimId })]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    expect((await (await transfer([{ variantId: '17', quantity: 3 }], { claimId })).json()).cart.lines[0].quantity).toBe(3);
    expect((await transfer([{ variantId: '17', quantity: 4 }], { claimId })).status).toBe(409);
    expect(await withStore(STORE, tx => tx.select().from(s.legacyCartClaim))).toHaveLength(1);
  });
  it('cannot use a stored receipt to recover a revoked authenticated capability', async () => {
    const claimId = randomUUID();
    expect((await transfer([{ variantId: '17', quantity: 1 }], { claimId })).status).toBe(200);
    await withStore(STORE, tx => tx.delete(s.session).where(eq(s.session.id, SESSION)));
    expect((await transfer([{ variantId: '17', quantity: 1 }], { claimId })).status).toBe(409);
    expect((await transfer([{ variantId: '17', quantity: 1 }], { claimId }, '')).status).toBe(409);
  });
  it('rejects a second claim for a grant that initially had no source cart', async () => {
    await withStore(STORE, tx => tx.update(s.legacySessionGrant).set({ cartId: null }).where(eq(s.legacySessionGrant.id, GRANT)));
    const responses = await Promise.all([transfer([{ variantId: '17', quantity: 1 }]), transfer([{ variantId: '17', quantity: 3 }])]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  });
  it('attaches a local-only snapshot to an already authenticated native customer', async () => {
    await withStore(STORE, tx => tx.delete(s.legacySessionGrant).where(eq(s.legacySessionGrant.id, GRANT)));
    expect((await (await transfer([{ variantId: '17', quantity: 1 }])).json()).cart.customerId).toBe(CUSTOMER);
  });
  it('serializes different claims for one source cart & refuses stale replacement', async () => {
    const responses = await Promise.all([transfer([{ variantId: '17', quantity: 1 }]), transfer([{ variantId: '17', quantity: 3 }])]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  });
  it('preserves an authoritative empty local snapshot rather than retaining source lines', async () => {
    expect((await (await transfer([])).json()).cart.lines).toEqual([]);
  });
  it('requires source token proof for guest source carts; email is never a capability', async () => {
    await wipe(); await seed(true);
    expect((await (await transfer(null, {}, `__vendure_session=${Buffer.from(JSON.stringify({ token: TOKEN })).toString('base64')}`)).json()).cart.lines[0].quantity).toBe(2);
    expect((await (await transfer(null, {}, '')).json()).cart).toBeNull();
    expect((await transfer(null, { email: 'buyer@example.com' }, '')).status).toBe(400);
  });
  it('creates & receipts a local-only guest snapshot with tenant-owned variant mapping', async () => {
    const body = await (await transfer([{ variantId: '17', quantity: 1 }], {}, '')).json();
    expect(body.cart.customerId).toBeNull();
    expect(body.cart.token).not.toBe('target-cart-capability');
    expect(body.cart.lines[0]).toMatchObject({ sku: 'WIDGET', quantity: 1, unitPrice: 1000 });
  });
});
