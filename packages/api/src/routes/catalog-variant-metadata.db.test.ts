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
