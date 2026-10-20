/** DB test: priced cart lines carry `image` (variant asset > product featured asset > null). Runs against a *_test database ONLY (TRUNCATEs). */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { invalidateStoreCache, resolveStore } from '../store-context.js';
import { priceCart } from './cart.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'cart-line-image.db.test.ts');

const STORE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01';
const SLUG = 'cart-line-image-test';
const PRODUCT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02';
const V_ASSET = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03';
const V_FEATURED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee04';
const A_FEATURED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee05';
const A_SECOND = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee06';
const A_FIRST = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee07';
const PRODUCT_BARE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee08';

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, tax_rate) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', 0)`);
    await tx.execute(sql`INSERT INTO asset (id, store_id, path) VALUES (${A_FEATURED}, ${STORE}, 'p/featured.webp'), (${A_SECOND}, ${STORE}, 'v/second.webp'), (${A_FIRST}, ${STORE}, 'v/first.webp')`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status, featured_asset_id) VALUES (${PRODUCT}, ${STORE}, 'img', 'Img', 'active', ${A_FEATURED}), (${PRODUCT_BARE}, ${STORE}, 'bare', 'Bare', 'active', NULL)`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${V_ASSET}, ${STORE}, ${PRODUCT}, 'WITH-VA', 'A', 1000), (${V_FEATURED}, ${STORE}, ${PRODUCT}, 'FEAT-ONLY', 'B', 1000), (gen_random_uuid(), ${STORE}, ${PRODUCT_BARE}, 'NONE', 'C', 1000)`);
    await tx.execute(sql`INSERT INTO variant_asset (store_id, variant_id, asset_id, position) VALUES (${STORE}, ${V_ASSET}, ${A_SECOND}, 1), (${STORE}, ${V_ASSET}, ${A_FIRST}, 0)`);
  });
  invalidateStoreCache();
});

afterAll(() => pool.end());

describe('priceCart line image', () => {
  it('uses first variant asset, else product featured asset, else null', async () => {
    const st = await resolveStore(SLUG);
    const priced = await withStore(STORE, (tx) => priceCart(tx, st, [
      { sku: 'WITH-VA', quantity: 1 }, { sku: 'FEAT-ONLY', quantity: 1 }, { sku: 'NONE', quantity: 1 },
    ]));
    expect(priced.lines.map((l) => [l.sku, l.image])).toEqual([
      ['WITH-VA', 'v/first.webp'], ['FEAT-ONLY', 'p/featured.webp'], ['NONE', null],
    ]);
  });
});
