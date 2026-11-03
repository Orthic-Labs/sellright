/**
 * GET /v1/shop/catalog/search also matches variant names ("Yokai / Black G10"), so a shopper who searches a colour or
 * material finds the product that has it. A disabled or deleted variant must not match. DB test (vs sellright_test ONLY).
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { invalidateStoreCache } from '../store-context.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'catalog-search-variant-names.db.test.ts');

const STORE_ID = '11111111-2222-3333-4444-555555550012';
const SLUG = 'search-variant-store';
const P1 = '33333333-3333-3333-3333-333333331001';
const P2 = '33333333-3333-3333-3333-333333331002';

beforeEach(async () => {
  invalidateStoreCache();
  await pool.query('TRUNCATE store CASCADE');
  await withStore(STORE_ID, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE_ID}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb)`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${P1}, ${STORE_ID}, 'pocket-blade', 'Pocket Blade', 'active'), (${P2}, ${STORE_ID}, 'other-blade', 'Other Blade', 'active')`);
    await tx.execute(sql`INSERT INTO product_variant (store_id, product_id, sku, name, price, enabled, deleted_at) VALUES
      (${STORE_ID}, ${P1}, 'PB-1', 'Yokai / Black G10', 4000, true, NULL),
      (${STORE_ID}, ${P2}, 'OB-1', 'Yokai / Grey', 4000, false, NULL),
      (${STORE_ID}, ${P2}, 'OB-2', 'Yokai / Green', 4000, true, now())`);
  });
});

afterAll(async () => { await pool.end(); });

describe('GET /v1/shop/catalog/search — variant names', () => {
  it('finds a product by an option name only a variant carries; ignores disabled and deleted variants', async () => {
    const res = await createApp().request('/v1/shop/catalog/search?term=yokai', { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { slug: string }[]; total: number };
    expect(body.items.map((i) => i.slug)).toEqual(['pocket-blade']);
    expect(body.total).toBe(1);
  });
});
