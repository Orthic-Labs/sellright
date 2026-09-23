/**
 * SellRight storefront-port follow-up: GET /v1/shop/collections/{slug} used to
 * return slug/name/minPrice only — no image or inStock — unlike every other
 * listing endpoint (catalog/products, catalog/search). That forced the
 * collection page to render a bare text tile instead of a full ProductCard.
 * This proves the collection route now computes image + inStock live (same
 * productImage()/productInStock() subqueries as catalog/products), and that
 * catalog/products accepts a collectionSlug filter with the same semantics
 * as catalog/search's.
 *
 * DB test (vs sellright_test ONLY — TRUNCATEs). Same conventions as
 * catalog-collection-sql.db.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { invalidateStoreCache } from '../store-context.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`catalog collection parity db test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE_ID = '11111111-2222-3333-4444-555555550002';
const SLUG = 'parity-collection-store';
const COLLECTION_ID = '22222222-2222-2222-2222-222222220002';
const ASSET_ID = '55555555-5555-5555-5555-555555550001';
const IN_STOCK_PRODUCT_ID = '33333333-3333-3333-3333-333333330001';
const OOS_PRODUCT_ID = '33333333-3333-3333-3333-333333330002';
const OUTSIDE_PRODUCT_ID = '33333333-3333-3333-3333-333333330003';
const IN_STOCK_VARIANT_ID = '44444444-4444-4444-4444-444444440001';
const OOS_VARIANT_ID = '44444444-4444-4444-4444-444444440002';
const OUTSIDE_VARIANT_ID = '44444444-4444-4444-4444-444444440003';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seed() {
  await withStore(STORE_ID, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE_ID}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING`);

    await tx.execute(sql`INSERT INTO asset (id, store_id, type, path)
      VALUES (${ASSET_ID}, ${STORE_ID}, 'image', 'products/parity-a.jpg')
      ON CONFLICT (id) DO NOTHING`);

    // Manual collection (rules NULL) with two members: one live-in-stock, one
    // out of stock (no stock row at all — physical + not pre-order = OOS).
    await tx.execute(sql`INSERT INTO collection (id, store_id, slug, name, rules, published)
      VALUES (${COLLECTION_ID}, ${STORE_ID}, 'parity-collection', 'Parity Collection', NULL, true)
      ON CONFLICT (id) DO NOTHING`);

    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status, featured_asset_id)
      VALUES (${IN_STOCK_PRODUCT_ID}, ${STORE_ID}, 'parity-in-stock', 'Parity In Stock', 'active', ${ASSET_ID})
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price)
      VALUES (${IN_STOCK_VARIANT_ID}, ${STORE_ID}, ${IN_STOCK_PRODUCT_ID}, 'PARITY-IN', 'Parity In Stock', 1500)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated)
      VALUES (${IN_STOCK_VARIANT_ID}, ${STORE_ID}, 5, 0)
      ON CONFLICT (variant_id) DO NOTHING`);

    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status)
      VALUES (${OOS_PRODUCT_ID}, ${STORE_ID}, 'parity-oos', 'Parity OOS', 'active')
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price)
      VALUES (${OOS_VARIANT_ID}, ${STORE_ID}, ${OOS_PRODUCT_ID}, 'PARITY-OOS', 'Parity OOS', 2000)
      ON CONFLICT (id) DO NOTHING`);
    // No stock row for OOS variant — on_hand/allocated both default-absent => OOS.

    await tx.execute(sql`INSERT INTO collection_product (store_id, collection_id, product_id, position)
      VALUES (${STORE_ID}, ${COLLECTION_ID}, ${IN_STOCK_PRODUCT_ID}, 0), (${STORE_ID}, ${COLLECTION_ID}, ${OOS_PRODUCT_ID}, 1)
      ON CONFLICT DO NOTHING`);

    // Outside product: active, NOT in the collection — must be excluded by collectionSlug filter.
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status)
      VALUES (${OUTSIDE_PRODUCT_ID}, ${STORE_ID}, 'parity-outside', 'Parity Outside', 'active')
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price)
      VALUES (${OUTSIDE_VARIANT_ID}, ${STORE_ID}, ${OUTSIDE_PRODUCT_ID}, 'PARITY-OUT', 'Parity Outside', 1000)
      ON CONFLICT (id) DO NOTHING`);
  });
}

beforeEach(async () => {
  invalidateStoreCache();
  await wipe();
  await seed();
});

afterAll(async () => {
  await pool.end();
});

describe('GET /v1/shop/collections/{slug} — image + inStock parity with catalog/search', () => {
  it('returns live image + inStock per product, no cache', async () => {
    const app = createApp();
    const res = await app.request('/v1/shop/collections/parity-collection', { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: { slug: string; image: string | null; inStock: boolean }[] };
    const bySlug = Object.fromEntries(body.products.map((p) => [p.slug, p]));
    expect(bySlug['parity-in-stock']).toMatchObject({ image: 'products/parity-a.jpg', inStock: true });
    expect(bySlug['parity-oos']).toMatchObject({ image: null, inStock: false });
  });
});

describe('GET /v1/shop/catalog/products?collectionSlug — collection filter', () => {
  it('scopes the product list to collection members only', async () => {
    const app = createApp();
    const res = await app.request('/v1/shop/catalog/products?collectionSlug=parity-collection', { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { slug: string }[]; total: number };
    const slugs = body.items.map((i) => i.slug).sort();
    expect(slugs).toEqual(['parity-in-stock', 'parity-oos']);
    expect(body.total).toBe(2);
  });

  it('with no collectionSlug, includes products outside every collection', async () => {
    const app = createApp();
    const res = await app.request('/v1/shop/catalog/products', { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { slug: string }[] };
    expect(body.items.map((i) => i.slug)).toContain('parity-outside');
  });
});
