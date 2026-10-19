/** Synthetic disposable fixtures; root integration owns execution. */
import { beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { requireDisposablePostgresUrl } from '../db/test-database-url.js';
import * as s from '../db/schema.js';
import { _setRateLimitBackendForTest, createMemoryRateLimitBackend } from '../auth/rate-limit-backend.js';
import { invalidateStoreCache } from '../store-context.js';
import { seedImportedCartSeams } from '../import/cart-stack.testkit.js';
import { cart } from './cart.js';
import { checkout } from './checkout.js';

requireDisposablePostgresUrl(process.env.DATABASE_URL ?? env.DATABASE_URL, 'cart-resource-bounds.db.test.ts');
const STORE = 'cccccccc-abce-4000-8000-000000000001';
const PRODUCT = 'cccccccc-abce-4000-8000-000000000002';
const VARIANT = 'cccccccc-abce-4000-8000-000000000003';
const CUSTOMER = 'cccccccc-abce-4000-8000-000000000004';
const app = new OpenAPIHono(); app.route('/', cart); app.route('/', checkout);
const headers = { 'content-type': 'application/json', 'x-store-slug': 'synthetic-cart-seams' };
let auth: string;
beforeEach(async () => {
  _setRateLimitBackendForTest(createMemoryRateLimitBackend());
  await pool.query('TRUNCATE store CASCADE');
  auth = await seedImportedCartSeams(STORE, PRODUCT, VARIANT, CUSTOMER);
  invalidateStoreCache();
});
const lines = (count: number, start = 0) => Array.from({ length: count }, (_, index) => ({ sku: 'UNKNOWN-' + (index + start), quantity: 1 }));
const request = (path: string, body: unknown, method = 'POST', authenticated = false) => app.request(path, {
  method, headers: { ...headers, ...(authenticated ? { authorization: 'Bearer ' + auth } : {}) }, body: JSON.stringify(body),
});
async function create(items: Array<{ sku: string; quantity: number }>) {
  const response = await request('/v1/shop/cart', { items });
  expect(response.status).toBe(200);
  return await response.json() as { token: string; revision: number; lines: Array<{ sku: string; quantity: number; available: boolean }> };
}
const patch = (token: string, body: unknown) => request('/v1/shop/cart/' + token + '/lines', body, 'PATCH');
async function stored(token: string) {
  return withStore(STORE, async tx => {
    const [row] = await tx.select().from(s.cart).where(eq(s.cart.token, token));
    const items = await tx.select().from(s.cartLine).where(eq(s.cartLine.cartId, row!.id));
    return { row: row!, items };
  });
}
async function historical(count: number, owner = false) {
  return withStore(STORE, async tx => {
    const token = randomUUID();
    const [row] = await tx.insert(s.cart).values({ storeId: STORE, token, customerId: owner ? CUSTOMER : null, expiresAt: new Date(Date.now() + 60_000) }).returning();
    if (count) await tx.insert(s.cartLine).values(lines(count).map(line => ({ ...line, cartId: row!.id, storeId: STORE })));
    return { token, revision: row!.revision };
  });
}
const merge = (target: { token: string; revision: number }) => app.request('/v1/shop/cart/' + target.token + '/merge?expectedRevision=' + target.revision,
  { method: 'POST', headers: { ...headers, authorization: 'Bearer ' + auth } });

describe('public cart resource bounds', () => {
  it('admits exactly 60 root creates and shares that budget with child routes', async () => {
    let token = '';
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await request('/v1/shop/cart', { items: [] });
      expect(response.status).toBe(200);
      token = (await response.json() as { token: string }).token;
    }
    const blocked = await request('/v1/shop/cart', { items: [] });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    const child = await app.request('/v1/shop/cart/' + token, { headers });
    expect(child.status).toBe(429);
    await withStore(STORE, async tx => expect(await tx.select().from(s.cart)).toHaveLength(60));
  });
  it('rejects oversized raw arrays even when every SKU is duplicated', async () => {
    const duplicates = Array(201).fill({ sku: 'SYNTHETIC', quantity: 1 });
    expect((await request('/v1/shop/cart/estimate', { items: duplicates })).status).toBe(400);
    expect((await request('/v1/shop/cart', { items: duplicates })).status).toBe(400);
    const target = await create([]);
    expect((await patch(target.token, { lines: duplicates })).status).toBe(400);
    expect((await stored(target.token)).items).toHaveLength(0);
  });
  it('counts unknown SKUs, refuses gradual append atomically, and preserves metadata', async () => {
    const target = await create(lines(199));
    expect(target.lines.every(line => !line.available)).toBe(true);
    expect((await patch(target.token, { lines: lines(1, 199) })).status).toBe(200);
    const before = await stored(target.token);
    const overflow = await patch(target.token, { lines: lines(1, 200), expectedRevision: before.row.revision, couponCodes: ['UNCHANGED'] });
    expect(overflow.status).toBe(409);
    expect(await overflow.json()).toMatchObject({ error: { code: 'CART_TOO_LARGE' }, status: 'active', revision: before.row.revision });
    expect(await stored(target.token)).toEqual(before);
  });
  it('serializes concurrent final-slot appends, accepting exactly one', async () => {
    const target = await create(lines(199));
    const results = await Promise.all([patch(target.token, { lines: lines(1, 199) }), patch(target.token, { lines: lines(1, 200) })]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect((await stored(target.token)).items).toHaveLength(200);
  });
  it('keeps seed filtering, duplicate set/remove and additive duplicate semantics', async () => {
    const target = await create([{ sku: 'SYNTHETIC', quantity: 2 }, { sku: 'SYNTHETIC', quantity: 0 }]);
    expect(target.lines[0]!.quantity).toBe(2);
    const increment = await patch(target.token, { lines: [{ sku: 'SYNTHETIC', quantity: 2 }, { sku: 'SYNTHETIC', quantity: 3 }] });
    const incremented = await increment.json() as { revision: number; lines: Array<{ quantity: number }> };
    expect(incremented.lines[0]!.quantity).toBe(7);
    expect((await patch(target.token, { expectedRevision: incremented.revision, lines: [{ sku: 'SYNTHETIC', quantity: 4 }, { sku: 'SYNTHETIC', quantity: 0 }] })).status).toBe(200);
    expect((await stored(target.token)).items).toHaveLength(0);
  });
  it('rejects historical overflow without snapshots or orders, then allows bounded revision-checked removal', async () => {
    const target = await historical(201);
    const before = await stored(target.token);
    const fetched = await app.request('/v1/shop/cart/' + target.token, { headers });
    expect(fetched.status).toBe(409);
    expect(await fetched.json()).not.toHaveProperty('cart');
    const checked = await request('/v1/shop/checkout', { items: [{ sku: 'SYNTHETIC', quantity: 1 }], cartToken: target.token, expectedRevision: target.revision });
    expect(checked.status).toBe(409);
    expect(await checked.json()).toMatchObject({ error: { code: 'CART_TOO_LARGE' }, revision: target.revision });
    expect(await stored(target.token)).toEqual(before);
    await withStore(STORE, async tx => expect(await tx.select().from(s.order)).toHaveLength(0));
    const stale = await patch(target.token, { expectedRevision: target.revision + 1, lines: [] });
    expect(await stale.json()).toMatchObject({ error: { code: 'CART_TOO_LARGE' }, code: 'stale', revision: target.revision });
    expect((await patch(target.token, { expectedRevision: target.revision, lines: [{ sku: 'UNKNOWN-200', quantity: 0 }] })).status).toBe(200);
    expect((await stored(target.token)).items).toHaveLength(200);
  });
  it('preserves terminal reason on oversized mutation refusals', async () => {
    const target = await historical(201);
    await withStore(STORE, async tx => tx.update(s.cart).set({ status: 'converted' }).where(eq(s.cart.token, target.token)));
    const before = await stored(target.token);
    const response = await patch(target.token, { expectedRevision: target.revision + 1, lines: [] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'CART_TOO_LARGE' }, code: 'converted', status: 'converted', revision: target.revision });
    expect(await stored(target.token)).toEqual(before);
  });
  it.each(['reassigned', 'deleted', 'unavailable'] as const)('merge retains target variantId for a %s SKU', async state => {
    const target = await create([{ sku: 'SYNTHETIC', quantity: 2 }]);
    const sku = state === 'unavailable' ? 'NO-SUCH-SKU' : 'SYNTHETIC';
    const original = await stored(target.token);
    await withStore(STORE, async tx => {
      if (state === 'reassigned') {
        await tx.update(s.productVariant).set({ sku: 'RETIRED-SYNTHETIC' }).where(eq(s.productVariant.id, VARIANT));
        await tx.insert(s.productVariant).values({ id: randomUUID(), storeId: STORE, productId: PRODUCT,
          sku, name: 'Replacement', price: 1000, fulfillmentType: 'digital_download' });
      } else if (state === 'deleted') {
        await tx.update(s.productVariant).set({ deletedAt: new Date() }).where(eq(s.productVariant.id, VARIANT));
      } else {
        // Imported historical SKU with a retained foreign-key association.
        await tx.update(s.cartLine).set({ sku }).where(eq(s.cartLine.cartId, original.row.id));
      }
    });
    const response = await request('/v1/shop/cart', { items: [{ sku, quantity: 3 }] }, 'POST', true);
    expect(response.status).toBe(200);
    const donor = await response.json() as { token: string };
    const donorBefore = await stored(donor.token);
    expect(donorBefore.items[0]!.variantId).not.toBe(VARIANT);
    expect((await merge(target)).status).toBe(200);
    const merged = await stored(target.token);
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]).toMatchObject({ sku, quantity: 5, variantId: VARIANT });
    const retired = await stored(donor.token);
    expect(retired.row.status).toBe('merged');
    expect(retired.items).toHaveLength(0);
  });
  it('rejects oversized union before changing target or retiring donors', async () => {
    const target = await create(lines(200));
    const donor = await historical(0, true);
    const saved = await stored(donor.token);
    await withStore(STORE, async tx => {
      await tx.insert(s.cartLine).values({ storeId: STORE, cartId: saved.row.id, sku: 'NEW-DONOR', quantity: 1 });
    });
    const beforeTarget = await stored(target.token); const beforeDonor = await stored(donor.token);
    expect((await merge(target)).status).toBe(409);
    expect(await stored(target.token)).toEqual(beforeTarget); expect(await stored(donor.token)).toEqual(beforeDonor);
  });
  it('rejects donor overflow before changing either cart', async () => {
    const target = await create([]); const donor = await historical(201, true);
    const beforeTarget = await stored(target.token); const beforeDonor = await stored(donor.token);
    const response = await merge(target);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'CART_TOO_LARGE' }, revision: target.revision });
    expect(await stored(target.token)).toEqual(beforeTarget); expect(await stored(donor.token)).toEqual(beforeDonor);
  });
  it('rejects 201 candidate carts instead of merging a prefix', async () => {
    const target = await create([]);
    await withStore(STORE, async tx => tx.insert(s.cart).values(Array.from({ length: 200 }, () => ({ storeId: STORE, token: randomUUID(), customerId: CUSTOMER }))));
    expect((await merge(target)).status).toBe(409);
    expect((await stored(target.token)).row.customerId).toBeNull();
    await withStore(STORE, async tx => expect((await tx.select().from(s.cart)).every(row => row.status === 'active' && row.revision === 0)).toBe(true));
  });
});
