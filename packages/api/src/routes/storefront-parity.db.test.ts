import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { invalidateStoreCache } from '../store-context.js';
import { createAdminSession } from '../auth/admin-session.js';
import { clearLoginAttempts } from '../auth/rate-limit.js';
import { verifyTurnstileToken } from '../security/turnstile.js';
import { shopExtra } from './shop-extra.js';
import { adminContent } from './admin-content.js';
import { adminProducts } from './admin-products.js';
import { adminCatalog } from './admin-catalog.js';
import { auth } from './auth.js';
import { clearTrackingAttempts } from './shop-extra.tracking-limit.js';
import { emitProductChanged } from '../webhooks/catalog.js';

vi.mock('../security/turnstile.js', () => ({ verifyTurnstileToken: vi.fn(async ({ token }) => token === 'valid-token') }));
const dbName = decodeURIComponent(new URL(process.env.DATABASE_URL ?? '').pathname.slice(1));
if (!dbName.endsWith('_test')) throw new Error('Storefront parity tests require a *_test database');
const STORE = 'abcdabcd-1111-4111-8111-111111111111';
const OTHER = 'abcdabcd-2222-4222-8222-222222222222';
const ADMIN = 'abcdabcd-3333-4333-8333-333333333333';
const SLUG = 'storefront-parity';
const EMAIL = 'buyer@parity.test';
const app = new OpenAPIHono();
app.route('/', shopExtra);
app.route('/', adminContent);
app.route('/', adminProducts);
app.route('/', adminCatalog);
app.route('/', auth);
const headers = { 'x-store-slug': SLUG, 'content-type': 'application/json' };
let token: string;
let assetId: string;
let foreignAssetId: string;

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
  await pool.query('INSERT INTO store (id, slug, name) VALUES ($1, $2, $2), ($3, $4, $4)', [STORE, SLUG, OTHER, 'other-parity']);
  await withStore(STORE, async tx => {
    const [asset] = await tx.insert(s.asset).values({ storeId: STORE, path: '/assets/blog.jpg' }).returning();
    assetId = asset!.id;
    await tx.insert(s.customer).values({ storeId: STORE, email: EMAIL });
    await tx.insert(s.order).values({ storeId: STORE, code: 'IMPORTED-123', metadata: { contact: { email: EMAIL } } });
  });
  await withStore(OTHER, async tx => {
    const [asset] = await tx.insert(s.asset).values({ storeId: OTHER, path: '/assets/other.jpg' }).returning();
    foreignAssetId = asset!.id;
  });
  await pool.query('INSERT INTO admin_user (id, email) VALUES ($1, $2)', [ADMIN, 'owner@parity.test']);
  await pool.query('INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, $3)', [ADMIN, STORE, 'owner']);
  token = await createAdminSession(ADMIN);
  invalidateStoreCache();
  clearLoginAttempts('unknown', 'checkemail:unknown');
  clearTrackingAttempts(JSON.stringify([STORE, 'unknown', EMAIL]));
  vi.mocked(verifyTurnstileToken).mockClear();
});
afterAll(() => pool.end());

function admin(method: string, path: string, body: unknown) {
  return app.request(path, { method, headers: { ...headers, authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}

describe('native preorder administration', () => {
  it('creates, reads, updates and clears preorder values with audit evidence', async () => {
    const product = await admin('POST', '/v1/admin/products', { name: 'Preorder fixture', status: 'active' });
    const { id: productId } = await product.json() as { id: string };
    const created = await admin('POST', `/v1/admin/products/${productId}/variants`, { sku: 'PREORDER-FIXTURE', name: 'Fixture', price: 5000, isPreOrder: true, preOrderPrice: 3000, shipDate: '2027-01-01T00:00:00Z' });
    expect(created.status).toBe(200);
    const { id } = await created.json() as { id: string };
    const read = async () => (await (await app.request(`/v1/admin/products/${productId}`, { headers: { ...headers, authorization: `Bearer ${token}` } })).json()) as { variants: unknown[] };
    expect((await read()).variants[0]).toMatchObject({ isPreOrder: true, preOrderPrice: 3000, shipDate: '2027-01-01T00:00:00.000Z' });
    expect((await admin('PATCH', `/v1/admin/variants/${id}`, { preOrderPrice: 3500, shipDate: '2027-02-01T12:30:00+02:00' })).status).toBe(200);
    expect((await read()).variants[0]).toMatchObject({ isPreOrder: true, preOrderPrice: 3500, shipDate: '2027-02-01T10:30:00.000Z' });
    const clear = { isPreOrder: false, preOrderPrice: null, shipDate: null };
    expect((await admin('PATCH', `/v1/admin/variants/${id}`, clear)).status).toBe(200);
    expect((await read()).variants[0]).toMatchObject(clear);
    const audit = await withStore(STORE, tx => tx.select().from(s.auditLog).where(eq(s.auditLog.entityId, id)));
    expect(audit.map(row => row.data)).toContainEqual(clear);
    for (const invalid of [{ preOrderPrice: -1 }, { shipDate: 'not-a-date' }, { isPreOrder: 'true' }]) {
      expect((await admin('PATCH', `/v1/admin/variants/${id}`, invalid)).status).toBe(400);
      expect((await admin('POST', `/v1/admin/products/${productId}/variants`, { sku: 'INVALID', name: 'Invalid', price: 5000, ...invalid })).status).toBe(400);
    }
  });
});

describe('catalog change webhooks', () => {
  it('queues product and variant changes only for the subscribed store, atomically', async () => {
    for (const storeId of [STORE, OTHER]) await withStore(storeId, tx => tx.insert(s.webhookEndpoint).values({
      storeId, url: 'https://store.example/indexnow/', secret: 'fixture-only', topics: ['catalog.product_changed'],
    }));
    const created = await admin('POST', '/v1/admin/products', { name: 'Catalog event fixture', status: 'active' });
    const { id, slug } = await created.json() as { id: string; slug: string };
    const deliveries = () => pool.query<{ payload: unknown; store_id: string }>('SELECT payload, store_id FROM webhook_delivery ORDER BY created_at');
    expect((await deliveries()).rows).toEqual([{ store_id: STORE, payload: { storeId: STORE, productId: id, slug } }]);
    const variant = await admin('POST', `/v1/admin/products/${id}/variants`, { sku: 'EVENT-SKU', name: 'Variant', price: 1000 });
    const { id: variantId } = await variant.json() as { id: string };
    for (const [method, path, body] of [
      ['PATCH', `/v1/admin/products/${id}`, { description: 'Updated' }],
      ['PATCH', `/v1/admin/variants/${variantId}`, { price: 1200 }],
      ['PATCH', `/v1/admin/variants/${variantId}/stock`, { onHand: 5 }],
      ['POST', `/v1/admin/products/${id}/assets`, { assetId }],
      ['DELETE', `/v1/admin/products/${id}/assets/${assetId}`, {}],
      ['POST', `/v1/admin/products/${id}/option-groups`, { name: 'Size', values: ['Small'] }],
      ['PUT', `/v1/admin/variants/${variantId}/options`, { optionIds: [] }],
      ['DELETE', `/v1/admin/variants/${variantId}`, {}],
      ['DELETE', `/v1/admin/products/${id}`, {}],
    ] as const) {
      const before = (await deliveries()).rowCount!;
      expect((await admin(method, path, body)).status).toBe(200);
      expect((await deliveries()).rowCount).toBe(before + 1);
    }
    const before = (await deliveries()).rowCount;
    await expect(withStore(STORE, async tx => {
      await emitProductChanged(tx, STORE, id);
      throw new Error('rollback fixture');
    })).rejects.toThrow('rollback fixture');
    expect((await deliveries()).rowCount).toBe(before);
    expect((await deliveries()).rows.every(row => row.store_id === STORE)).toBe(true);
    expect((await deliveries()).rows.at(-1)?.payload).toEqual({ storeId: STORE, productId: id, slug });
  });
});

describe('blog parity', () => {
  it('hides scheduled posts, paginates visible posts, sorts null dates last and returns featured assets', async () => {
    await withStore(STORE, async tx => {
      await tx.insert(s.blogPost).values([
        { storeId: STORE, title: 'Past', slug: 'past', isPublished: true, publishDate: new Date('2020-01-01'), featuredAssetId: assetId },
        { storeId: STORE, title: 'Undated', slug: 'undated', isPublished: true },
        { storeId: STORE, title: 'Future', slug: 'future', isPublished: true, publishDate: new Date('2099-01-01') },
        { storeId: STORE, title: 'Draft', slug: 'draft', isPublished: false },
      ]);
    });
    const first = await (await app.request('/v1/shop/blog?take=1', { headers })).json() as { items: unknown[] };
    expect(first).toMatchObject({ totalItems: 2, items: [{ slug: 'past', featuredAsset: { id: assetId, path: '/assets/blog.jpg' } }] });
    expect(first.items).toHaveLength(1);
    const next = await (await app.request('/v1/shop/blog?take=1&skip=1', { headers })).json() as { items: unknown[] };
    expect(next.items[0]).toMatchObject({ slug: 'undated', featuredAsset: null });
    for (const slug of ['future', 'draft']) expect((await app.request(`/v1/shop/blog/${slug}`, { headers })).status).toBe(404);
    expect(await (await app.request('/v1/shop/blog/past', { headers })).json()).toMatchObject({ featuredAsset: { id: assetId } });
    expect((await app.request('/v1/shop/blog?take=101', { headers })).status).toBe(400);
  });

  it('creates and edits scheduled posts and images without bypassing tenant asset access', async () => {
    const created = await admin('POST', '/v1/admin/blog', { title: 'Scheduled', isPublished: true, publishDate: '2099-01-01T00:00:00.000Z', featuredAssetId: assetId, body: '<p>Safe</p><script>bad()</script>' });
    expect(created.status).toBe(200);
    const { id, slug } = await created.json() as { id: string; slug: string };
    expect((await app.request(`/v1/shop/blog/${slug}`, { headers })).status).toBe(404);
    const edit = await admin('PATCH', `/v1/admin/blog/${id}`, { publishDate: '2020-01-01T00:00:00.000Z' });
    expect(edit.status).toBe(200);
    const detail = await (await app.request(`/v1/shop/blog/${slug}`, { headers })).json() as { featuredAsset: { id: string }; bodyHtml: string };
    expect(detail.featuredAsset.id).toBe(assetId);
    expect(detail.bodyHtml).toBe('<p>Safe</p>');
    expect((await admin('POST', '/v1/admin/blog', { title: 'Foreign', featuredAssetId: foreignAssetId })).status).toBe(404);
    expect((await admin('PATCH', `/v1/admin/blog/${id}`, { featuredAssetId: foreignAssetId })).status).toBe(404);
    expect((await admin('PATCH', `/v1/admin/blog/${id}`, { featuredAssetId: null, publishDate: null })).status).toBe(200);
    expect(await (await app.request(`/v1/shop/blog/${slug}`, { headers })).json()).toMatchObject({ featuredAsset: null, publishDate: null });
  });
});

describe('guest tracking', () => {
  const track = (code: string, email = EMAIL) => app.request(`/v1/shop/track?${new URLSearchParams({ code, email })}`, { headers });
  it('returns the same error for an unknown code and a mismatched email', async () => {
    expect(await (await track('unknown')).json()).toEqual(await (await track('IMPORTED-123', 'wrong@parity.test')).json());
  });
  it('counts attempts before lookup, resets on success, and blocks after ten failures', async () => {
    for (let i = 0; i < 9; i++) expect((await track('unknown')).status).toBe(404);
    expect((await track('IMPORTED-123', EMAIL.toUpperCase())).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await track('unknown')).status).toBe(404);
    const limited = await track('IMPORTED-123');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('email probe bot protection', () => {
  it('returns neutral false for honeypot or invalid/missing token, while valid tokens resolve the customer', async () => {
    await withStore(STORE, tx => tx.update(s.store).set({ config: { turnstileSecretKey: 'fixture-only' } }).where(eq(s.store.id, STORE)));
    invalidateStoreCache();
    const check = (extra: Record<string, string>) => app.request(`/v1/shop/auth/check-email?${new URLSearchParams({ email: EMAIL, ...extra })}`, { headers });
    expect(await (await check({ honeypot: 'bot', turnstileToken: 'valid-token' })).json()).toEqual({ exists: false });
    expect(verifyTurnstileToken).not.toHaveBeenCalled();
    expect(await (await check({})).json()).toEqual({ exists: false });
    expect(await (await check({ turnstileToken: 'invalid' })).json()).toEqual({ exists: false });
    expect(await (await check({ turnstileToken: 'valid-token' })).json()).toEqual({ exists: true });
    expect(verifyTurnstileToken).toHaveBeenCalledWith({ secret: 'fixture-only', token: 'valid-token', remoteIp: 'unknown' });
  });
});
