/**
 * DB test for GET /v1/shop/catalog/products/:slug — the storefront legal gate
 * needs `fulfillmentType` + `appKey` on every variant BEFORE checkout (the API
 * rejects a licensed order that arrives without an acceptance receipt), so the
 * product-detail payload must publish both.
 * Runs against a *_test database ONLY (TRUNCATEs).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { invalidateStoreCache } from '../store-context.js';
import { catalog } from './catalog.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`catalog test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';
const SLUG = 'catalog-meta-test';
const PRODUCT = 'dddddddd-dddd-dddd-dddd-ddddddddddd2';
const VARIANT = 'dddddddd-dddd-dddd-dddd-ddddddddddd3';

const app = new OpenAPIHono();
app.route('/', catalog);

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, tax_rate) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', 0) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PRODUCT}, ${STORE}, 'lic-app', 'Licensed App', 'active')`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type, app_key) VALUES (${VARIANT}, ${STORE}, ${PRODUCT}, 'LIC-1', 'Licensed App License', 4900, 'license', 'testapp')`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type) VALUES (gen_random_uuid(), ${STORE}, ${PRODUCT}, 'PHYS-1', 'Licensed App Box', 9900, 'physical')`);
  });
  invalidateStoreCache();
});

afterAll(() => pool.end());

describe('GET /v1/shop/catalog/products/:slug variant metadata', () => {
  it('reports purchasable stock and treats inStock=false as no stock filter', async () => {
    await withStore(STORE, async tx => {
      await tx.execute(sql`UPDATE product_variant SET fulfillment_type = 'physical', app_key = NULL WHERE product_id = ${PRODUCT}`);
    });
    for (const path of ['/v1/shop/catalog/products', '/v1/shop/catalog/search?term=Licensed&inStock=false']) {
      const res = await app.request(path, { headers: { 'x-store-slug': SLUG } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ total: 1, items: [{ inStock: false }] });
    }
    const onlyStock = () => app.request('/v1/shop/catalog/search?term=Licensed&inStock=true', { headers: { 'x-store-slug': SLUG } });
    expect(await (await onlyStock()).json()).toMatchObject({ total: 0 });
    await withStore(STORE, async tx => { await tx.execute(sql`UPDATE product_variant SET is_pre_order = true WHERE id = ${VARIANT}`); });
    expect(await (await onlyStock()).json()).toMatchObject({ total: 1, items: [{ inStock: true }] });
  });
  it('retains option identity and excludes unavailable variants and draft products', async () => {
    const group = 'dddddddd-dddd-dddd-dddd-ddddddddddd4';
    const option = 'dddddddd-dddd-dddd-dddd-ddddddddddd5';
    await withStore(STORE, async tx => {
      await tx.execute(sql`INSERT INTO product_option_group (id, store_id, product_id, name) VALUES (${group}, ${STORE}, ${PRODUCT}, 'Color')`);
      await tx.execute(sql`INSERT INTO product_option (id, store_id, group_id, value) VALUES (${option}, ${STORE}, ${group}, 'Red')`);
      await tx.execute(sql`INSERT INTO variant_option (store_id, variant_id, option_id) VALUES (${STORE}, ${VARIANT}, ${option})`);
      await tx.execute(sql`UPDATE product_variant SET enabled = false WHERE sku = 'PHYS-1'`);
    });
    const res = await app.request('/v1/shop/catalog/products/lic-app', { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(200);
    const body = await res.json() as { variants: unknown[] };
    expect(body.variants).toHaveLength(1);
    expect(body.variants[0]).toMatchObject({ sku: 'LIC-1', options: [{ id: option, code: option, name: 'Red', group: { id: group, code: group, name: 'Color' } }] });
    await withStore(STORE, async tx => { await tx.execute(sql`UPDATE product SET status = 'draft' WHERE id = ${PRODUCT}`); });
    expect((await app.request('/v1/shop/catalog/products/lic-app', { headers: { 'x-store-slug': SLUG } })).status).toBe(404);
  });
  it.each(['preorder', 'sale'])('uses the %s pricing rule on list and search without disabled variants', async rule => {
    await withStore(STORE, async tx => {
      await tx.execute(sql`UPDATE store SET config = ${JSON.stringify({ pricing: { variantRule: rule } })}::jsonb WHERE id = ${STORE}`);
      await tx.execute(sql`UPDATE product_variant SET is_pre_order = true, pre_order_price = 3000, sale_price = 2000 WHERE id = ${VARIANT}`);
      await tx.execute(sql`UPDATE product_variant SET enabled = false, price = 1 WHERE sku = 'PHYS-1'`);
    });
    invalidateStoreCache();
    for (const path of ['/v1/shop/catalog/products', '/v1/shop/catalog/search?term=Licensed']) {
      const res = await app.request(path, { headers: { 'x-store-slug': SLUG } });
      expect(res.status).toBe(200);
      const body = await res.json() as { items: { minPrice: number; pricingVariant: unknown }[] };
      expect(body.items[0]!.minPrice).toBe(rule === 'preorder' ? 3000 : 2000);
      expect(body.items[0]!.pricingVariant).toMatchObject({ sku: 'LIC-1', price: 4900, preOrderPrice: 3000, salePrice: 2000, isPreOrder: true });
    }
  });
  it('exposes preorder price and ship date, including currency conversion', async () => {
    await withStore(STORE, async tx => {
      await tx.execute(sql`UPDATE product_variant SET is_pre_order = true, pre_order_price = 3000, ship_date = '2027-01-01T00:00:00Z' WHERE id = ${VARIANT}`);
      await tx.execute(sql`INSERT INTO currency_rate (store_id, currency, rate) VALUES (${STORE}, 'EUR', 9000)`);
    });
    const res = await app.request('/v1/shop/catalog/products/lic-app?currency=EUR', { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(200);
    const body = await res.json() as { variants: { sku: string }[] };
    expect(body.variants.find((v: { sku: string }) => v.sku === 'LIC-1')).toMatchObject({ price: 4410, preOrderPrice: 2700, isPreOrder: true, shipDate: '2027-01-01T00:00:00.000Z' });
    expect(body.variants.find((v: { sku: string }) => v.sku === 'PHYS-1')).toMatchObject({ preOrderPrice: null, shipDate: null });
  });
  it('exposes fulfillmentType + appKey so the storefront can gate licensed checkout', async () => {
    const res = await app.request(`/v1/shop/catalog/products/${'lic-app'}`, {
      headers: { 'x-store-slug': SLUG },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { variants: Array<{ sku: string; fulfillmentType: string; appKey: string | null }> };
    const bySku = Object.fromEntries(body.variants.map((v) => [v.sku, v]));
    expect(bySku['LIC-1']).toMatchObject({ fulfillmentType: 'license', appKey: 'testapp' });
    expect(bySku['PHYS-1']).toMatchObject({ fulfillmentType: 'physical', appKey: null });
  });
});
