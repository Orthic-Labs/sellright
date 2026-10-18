/** Synthetic disposable DB fixtures; root integration owns execution. */
import { beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { requireDisposablePostgresUrl } from '../db/test-database-url.js';
import * as s from '../db/schema.js';
import { invalidateStoreCache } from '../store-context.js';
import { seedImportedCartSeams } from '../import/cart-stack.testkit.js';
import { issue } from '../account-credit/service.js';
import { cart } from './cart.js';
import { shopExtra } from './shop-extra.js';

requireDisposablePostgresUrl(process.env.DATABASE_URL ?? env.DATABASE_URL, 'cart-stack-seams.db.test.ts');
const STORE = 'cccccccc-abcd-4000-8000-000000000001';
const PRODUCT = 'cccccccc-abcd-4000-8000-000000000002';
const VARIANT = 'cccccccc-abcd-4000-8000-000000000003';
const CUSTOMER = 'cccccccc-abcd-4000-8000-000000000004';
const app = new OpenAPIHono(); app.route('/', cart); app.route('/', shopExtra);
const headers = { 'content-type': 'application/json', 'x-store-slug': 'synthetic-cart-seams' };
const items = [{ sku: 'SYNTHETIC', quantity: 1 }];
let sessionToken: string;
beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  sessionToken = await seedImportedCartSeams(STORE, PRODUCT, VARIANT, CUSTOMER);
  invalidateStoreCache();
});
const post = (path: string, body: unknown, auth = false) => app.request(path, { method: 'POST',
  headers: { ...headers, ...(auth ? { authorization: `Bearer ${sessionToken}` } : {}) }, body: JSON.stringify(body) });
const patch = (token: string, body: unknown) => app.request(`/v1/shop/cart/${token}/lines`, { method: 'PATCH', headers, body: JSON.stringify(body) });
const transfer = (claimId: string, extra: Record<string, unknown>) => post('/v1/shop/cart/legacy-migration', {
  claimId, items: [{ variantId: '17', quantity: 1 }], ...extra,
});

describe('cart stack protocol seams', () => {
  it('returns authoritative concurrent codes on stale PATCH, retaining checkout quote context for retry', async () => {
    const created = await post('/v1/shop/cart', { items, couponCodes: ['KEEP'] });
    const original = await created.json() as { token: string; revision: number };
    expect((await patch(original.token, { lines: [], couponCodes: ['KEEP', 'OTHER'], expectedRevision: original.revision })).status).toBe(200);
    const stale = await patch(original.token, { lines: [], couponCodes: ['KEEP', 'NEW'], expectedRevision: original.revision,
      pricingIntent: 'checkout', shippingMethodCode: 'threshold', shipCountry: 'US' });
    expect(stale.status).toBe(409);
    const conflict = await stale.json() as { revision: number; cart: { couponCodes: string[]; pricingIntent: string; shippingMethodCode: string } };
    expect(conflict.cart).toMatchObject({ couponCodes: ['KEEP', 'OTHER'], pricingIntent: 'checkout', shippingMethodCode: 'threshold' });
    const retried = await patch(original.token, { lines: [], couponCodes: [...conflict.cart.couponCodes, 'NEW'], expectedRevision: conflict.revision });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ couponCodes: ['KEEP', 'OTHER', 'NEW'] });
  });

  it.each([
    { input: { couponCode: 'OLD', couponCodes: ['FIRST', 'SECOND'] }, expected: ['FIRST', 'SECOND'] },
    { input: { couponCode: 'OLD', couponCodes: [] }, expected: [] },
    { input: { couponCode: 'OLD' }, expected: ['OLD'] },
  ])('persists validated legacy coupon intent with array precedence: $expected', async ({ input, expected }) => {
    const claimId = randomUUID(); const response = await transfer(claimId, input);
    expect(response.status).toBe(200);
    const migrated = await response.json() as { cart: { token: string; couponCodes: string[] } };
    expect(migrated.cart.couponCodes).toEqual(expected);
    const read = await app.request(`/v1/shop/cart/${migrated.cart.token}`, { headers });
    expect(await read.json()).toMatchObject({ couponCodes: expected });
    expect((await transfer(claimId, input)).status).toBe(200);
  });

  it('binds legacy arrays to replay payload while replaying live cart codes after later edits', async () => {
    const claimId = randomUUID(); const input = { couponCodes: ['FIRST', 'SECOND'] };
    const response = await transfer(claimId, input);
    const migrated = await response.json() as { cart: { token: string; revision: number } };
    expect((await transfer(claimId, { couponCodes: ['FIRST'] })).status).toBe(409);
    expect((await patch(migrated.cart.token, { lines: [], couponCodes: ['CURRENT'], expectedRevision: migrated.cart.revision })).status).toBe(200);
    expect(await (await transfer(claimId, input)).json()).toMatchObject({ cart: { couponCodes: ['CURRENT'] } });
    expect((await transfer(randomUUID(), { couponCodes: Array(101).fill('X') })).status).toBe(400);
    expect((await transfer(randomUUID(), { couponCodes: ['X'], grandTotal: 1 })).status).toBe(400);
  });

  it('adopts complete imported source stack without replacing it with legacy singleton alias', async () => {
    const sourceToken = 'synthetic-guest-source'; const cartId = randomUUID();
    await withStore(STORE, async tx => {
      await tx.insert(s.cart).values({ id: cartId, storeId: STORE, token: 'synthetic-source-cart', couponCodes: ['ONE', 'TWO'], expiresAt: new Date(Date.now() + 60_000) });
      await tx.insert(s.cartLine).values({ storeId: STORE, cartId, variantId: VARIANT, sku: 'SYNTHETIC', quantity: 1 });
      await tx.insert(s.legacySessionGrant).values({ id: randomUUID(), storeId: STORE, sourceKey: 'synthetic', sourceSessionId: '1',
        tokenHash: createHash('sha256').update(sourceToken).digest('hex'), authenticated: false, cartId,
        couponCode: 'ONE', expiresAt: new Date(Date.now() + 60_000) });
    });
    const response = await app.request('/v1/shop/cart/legacy-migration', { method: 'POST',
      headers: { ...headers, cookie: `authToken=${sourceToken}` },
      body: JSON.stringify({ claimId: randomUUID(), items: null, couponCodes: ['ATTEMPT'] }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cart: { couponCodes: ['ONE', 'TWO'] } });
    await withStore(STORE, async tx => expect((await tx.select().from(s.cart).where(eq(s.cart.id, cartId)))[0]?.couponCodes).toEqual(['ONE', 'TWO']));
  });

  it('returns typed credit refusal from shipping discovery without financial writes', async () => {
    await withStore(STORE, async tx => {
      const credit = await issue(tx, { storeId: STORE, email: 'synthetic@example.invalid', issuanceKey: 'zero-credit', code: 'CREDIT', amount: 1 });
      await tx.update(s.accountCredit).set({ balance: 0 }).where(eq(s.accountCredit.id, credit.account.id));
    });
    const response = await post('/v1/shop/shipping-methods', { country: 'US', items, couponCodes: ['CREDIT'] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'CREDIT_AMOUNT_CHANGED' } });
    await withStore(STORE, async tx => {
      expect(await tx.select().from(s.order)).toHaveLength(0);
      expect(await tx.select().from(s.payment)).toHaveLength(0);
      expect((await tx.select().from(s.accountCreditTransaction)).filter(row => row.kind === 'RESERVE')).toHaveLength(0);
    });
  });

  it('uses prepoints merchandise for shipping threshold, matching checkout eligibility basis', async () => {
    const estimate = await post('/v1/shop/cart/estimate', { items, shipCountry: 'US', redeemPoints: 50, pricingIntent: 'checkout' }, true);
    expect(await estimate.json()).toMatchObject({ pointsDiscount: 500, grandTotal: 500 });
    const response = await post('/v1/shop/shipping-methods', { country: 'US', items, redeemPoints: 50 }, true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ methods: [{ code: 'threshold', rate: 100 }] });
    await withStore(STORE, async tx => expect(await tx.select().from(s.loyaltyLedger)).toHaveLength(1));
  });
});
