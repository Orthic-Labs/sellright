/**
 * PERF-16 DB test (vs sellright_test ONLY — TRUNCATEs). Mirrors
 * store-context.db.test.ts / app.cors.db.test.ts conventions: _test-DB guard +
 * TRUNCATE store CASCADE wipe + seed under withStore(), drive the real Hono
 * app through GET /v1/shop/collections/{slug} via x-store-slug.
 *
 * Proves the smart-collection browse endpoint now filters via a compiled SQL
 * predicate (collection-rules-sql.ts) instead of loading all store products
 * into JS, and that page/pageSize pagination actually slices distinct pages.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { invalidateStoreCache } from '../store-context.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`catalog collection sql db test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE_ID = '11111111-2222-3333-4444-555555550001';
const SLUG = 'perf16-sql-collection-store';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seed() {
  await withStore(STORE_ID, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE_ID}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING`);

    // Smart collection: productType = 'EDC' (match: all)
    const COLLECTION_ID = '22222222-2222-2222-2222-222222220001';
    const rules = JSON.stringify({ match: 'all', conditions: [{ field: 'productType', op: 'equals', value: 'EDC' }] });
    await tx.execute(sql`INSERT INTO collection (id, store_id, slug, name, rules, published)
      VALUES (${COLLECTION_ID}, ${STORE_ID}, 'edc-smart', 'EDC Smart', ${rules}::jsonb, true)
      ON CONFLICT (id) DO NOTHING`);

    // Seed products: 5 matching (EDC, active), a few non-matching, so total=5
    // and page 1 / page 2 (pageSize=2) return disjoint slugs.
    for (let i = 0; i < 5; i++) {
      const pid = `33333333-3333-3333-3333-33333333000${i}`;
      const pslug = `edc-item-${i}`;
      await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status, product_type)
        VALUES (${pid}, ${STORE_ID}, ${pslug}, ${`EDC Item ${i}`}, 'active', 'EDC')
        ON CONFLICT (id) DO NOTHING`);
      const vid = `44444444-4444-4444-4444-44444444000${i}`;
      await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price)
        VALUES (${vid}, ${STORE_ID}, ${pid}, ${`SKU-${i}`}, ${`EDC Item ${i}`}, ${1000 + i * 100})
        ON CONFLICT (id) DO NOTHING`);
    }
    // Non-matching product (different productType) — must never appear.
    const otherId = '33333333-3333-3333-3333-333333339999';
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status, product_type)
      VALUES (${otherId}, ${STORE_ID}, 'not-edc', 'Not EDC', 'active', 'Apparel')
      ON CONFLICT (id) DO NOTHING`);
    // Inactive EDC product — must never appear (status filter).
    const inactiveId = '33333333-3333-3333-3333-333333338888';
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status, product_type)
      VALUES (${inactiveId}, ${STORE_ID}, 'edc-draft', 'EDC Draft', 'draft', 'EDC')
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

describe('smart collection browse — SQL-compiled rules + pagination (PERF-16)', () => {
  it('returns only products matching the rule via SQL, excluding inactive/non-matching', async () => {
    const app = createApp();
    const res = await app.request('/v1/shop/collections/edc-smart?pageSize=100', {
      headers: { 'x-store-slug': SLUG },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(5);
    const slugs = body.products.map((p: { slug: string }) => p.slug).sort();
    expect(slugs).toEqual(['edc-item-0', 'edc-item-1', 'edc-item-2', 'edc-item-3', 'edc-item-4']);
    expect(slugs).not.toContain('not-edc');
    expect(slugs).not.toContain('edc-draft');
  });

  it('paginates: page 1 and page 2 return distinct, non-overlapping slugs', async () => {
    const app = createApp();
    const page1 = await (await app.request('/v1/shop/collections/edc-smart?page=1&pageSize=2', { headers: { 'x-store-slug': SLUG } })).json();
    const page2 = await (await app.request('/v1/shop/collections/edc-smart?page=2&pageSize=2', { headers: { 'x-store-slug': SLUG } })).json();

    expect(page1.total).toBe(5);
    expect(page2.total).toBe(5);
    expect(page1.products).toHaveLength(2);
    expect(page2.products).toHaveLength(2);

    const s1 = page1.products.map((p: { slug: string }) => p.slug);
    const s2 = page2.products.map((p: { slug: string }) => p.slug);
    expect(s1).not.toEqual(s2);
    expect(new Set([...s1, ...s2]).size).toBe(4); // no overlap
  });

  it('404s for an unpublished or missing collection slug', async () => {
    const app = createApp();
    const res = await app.request('/v1/shop/collections/does-not-exist', { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(404);
  });
});
