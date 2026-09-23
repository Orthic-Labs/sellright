/**
 * SEO-1 / cache-version DB tests. Confirms the version is derived live from
 * MAX(updated_at) across product/collection/blog_post/stock (migration 0068's
 * triggers), advances on each of those tables' writes, and stays isolated
 * per store — never a cross-tenant leak, never a debounced/cached value.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { env } from '../env.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'cache-version.db.test.ts');

const STORE_A = 'ccccccc3-3333-3333-3333-333333333333';
const STORE_B = 'ddddddd4-4444-4444-4444-444444444444';
const app = createApp();
const version = async (slug = 'cv-a') => ((await (await app.request('/v1/shop/cache-version', { headers: { 'x-store-slug': slug } })).json()) as { version: string }).version;
const toMs = (v: string) => parseInt(v, 36);
const tick = () => new Promise((r) => setTimeout(r, 10));

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }
async function seedStore(id: string, slug: string): Promise<void> {
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, $3, 'USD', '{}'::jsonb)`, [id, slug, `${slug} store`]);
}

describe('GET /v1/shop/cache-version', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('is never cached: same request twice with no writes returns the same value, no Cache-Control caching header', async () => {
    await seedStore(STORE_A, 'cv-a');
    const res = await app.request('/v1/shop/cache-version', { headers: { 'x-store-slug': 'cv-a' } });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const v1 = await version();
    const v2 = await version();
    expect(v1).toBe(v2);
  });

  it('advances when a product is inserted', async () => {
    await seedStore(STORE_A, 'cv-a');
    const v1 = await version();
    await tick();
    await withStore(STORE_A, (tx) => tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE_A}, 'p1', 'P1', 'active')`));
    const v2 = await version();
    expect(toMs(v2)).toBeGreaterThan(toMs(v1));
  });

  it('advances when a collection row is updated (the set_updated_at trigger fires)', async () => {
    await seedStore(STORE_A, 'cv-a');
    await withStore(STORE_A, (tx) => tx.execute(sql`INSERT INTO collection (id, store_id, slug, name) VALUES ('11111111-0000-0000-0000-000000000001', ${STORE_A}, 'c1', 'C1')`));
    const v1 = await version();
    await tick();
    await withStore(STORE_A, (tx) => tx.execute(sql`UPDATE collection SET name = 'C1 renamed' WHERE id = '11111111-0000-0000-0000-000000000001'`));
    const v2 = await version();
    expect(toMs(v2)).toBeGreaterThan(toMs(v1));
  });

  it('advances on a bare stock availability change even when no catalog row changes', async () => {
    await seedStore(STORE_A, 'cv-a');
    const variantId = await withStore(STORE_A, async (tx) => {
      const p = await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE_A}, 'p2', 'P2', 'active') RETURNING id`);
      const productId = (p.rows[0] as { id: string }).id;
      const v = await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, enabled) VALUES (gen_random_uuid(), ${STORE_A}, ${productId}, 'SKU-P2', 'Std', 1000, true) RETURNING id`);
      const vid = (v.rows[0] as { id: string }).id;
      await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${vid}, ${STORE_A}, 0, 0)`);
      return vid;
    });
    const v1 = await version();
    await tick();
    await withStore(STORE_A, (tx) => tx.execute(sql`UPDATE stock SET on_hand = 10 WHERE variant_id = ${variantId}`));
    const v2 = await version();
    expect(toMs(v2)).toBeGreaterThan(toMs(v1));
  });

  it('is isolated per store: mutating store B never changes store A\'s version', async () => {
    await seedStore(STORE_A, 'cv-a');
    await seedStore(STORE_B, 'cv-b');
    const aBefore = await version('cv-a');
    await tick();
    await withStore(STORE_B, (tx) => tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE_B}, 'b1', 'B1', 'active')`));
    const aAfter = await version('cv-a');
    expect(aAfter).toBe(aBefore);
  });
});
