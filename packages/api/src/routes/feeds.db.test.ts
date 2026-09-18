/**
 * PAR-02 route-level tests (DB-required — .db.test.ts runs under the `db`
 * vitest project only). Exercises GET /v1/shop/feeds/{channel} end to end:
 * store scoping via x-store-slug, live stock/availability, csv suffix.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { env } from '../env.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'feeds.db.test.ts');

const STORE_A = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STORE_B = 'bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const app = createApp();
const get = (path: string, slug = 'feed-a') => app.request(path, { headers: { 'x-store-slug': slug } });

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

async function seedStore(id: string, slug: string, currency = 'USD'): Promise<void> {
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, $3, $4, '{}'::jsonb)`, [id, slug, `${slug} store`, currency]);
}

/** One active product + enabled physical variant + stock row + featured image. */
async function seedCatalog(storeId: string, sku: string, onHand = 5): Promise<string> {
  return withStore(storeId, async (tx) => {
    const a = await tx.execute(sql`INSERT INTO asset (id, store_id, path) VALUES (gen_random_uuid(), ${storeId}, 'img.png') RETURNING id`);
    const assetId = (a.rows[0] as { id: string }).id;
    const p = await tx.execute(sql`
      INSERT INTO product (id, store_id, slug, name, description, status, featured_asset_id, vendor, product_type)
      VALUES (gen_random_uuid(), ${storeId}, ${'tee-' + sku.toLowerCase()}, ${'Tee ' + sku}, 'Comfy', 'active', ${assetId}, 'VendorX', 'Shirts')
      RETURNING id`);
    const productId = (p.rows[0] as { id: string }).id;
    const v = await tx.execute(sql`
      INSERT INTO product_variant (id, store_id, product_id, sku, name, price, enabled)
      VALUES (gen_random_uuid(), ${storeId}, ${productId}, ${sku}, 'Standard', 1999, true) RETURNING id`);
    const variantId = (v.rows[0] as { id: string }).id;
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${variantId}, ${storeId}, ${onHand}, 0)`);
    return variantId;
  });
}

describe('GET /v1/shop/feeds/{channel}', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('google feed: header + live variant row, store-scoped, correct currency', async () => {
    await seedStore(STORE_A, 'feed-a', 'EUR');
    await seedStore(STORE_B, 'feed-b');
    await seedCatalog(STORE_A, 'SKU-A1');
    await seedCatalog(STORE_B, 'SKU-B1');

    const res = await get('/v1/shop/feeds/google');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const body = await res.text();
    const lines = body.trim().split('\n');
    expect(lines[0]).toContain('id,title,description,link');
    expect(body).toContain('SKU-A1');
    expect(body).toContain('19.99 EUR'); // store currency, not USD
    expect(body).toContain('in stock');
    expect(body).not.toContain('SKU-B1'); // cross-store isolation
  });

  it('live availability: zero stock flips to out of stock on the next request', async () => {
    await seedStore(STORE_A, 'feed-a');
    const variantId = await seedCatalog(STORE_A, 'SKU-A2', 0);
    let body = await (await get('/v1/shop/feeds/google.csv')).text(); // .csv suffix tolerated
    expect(body).toContain('SKU-A2');
    expect(body).toContain('out of stock');

    await withStore(STORE_A, (tx) => tx.execute(sql`UPDATE stock SET on_hand = 3 WHERE variant_id = ${variantId}`));
    body = await (await get('/v1/shop/feeds/google')).text();
    expect(body).toContain('in stock');
  });

  it('disabled variants and non-active products never appear', async () => {
    await seedStore(STORE_A, 'feed-a');
    await withStore(STORE_A, async (tx) => {
      const p = await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE_A}, 'draft-p', 'Drafty', 'draft') RETURNING id`);
      const pid = (p.rows[0] as { id: string }).id;
      await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, enabled) VALUES (gen_random_uuid(), ${STORE_A}, ${pid}, 'DRAFT-SKU', 'D', 100, true)`);
      const p2 = await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE_A}, 'live-p', 'Live', 'active') RETURNING id`);
      const pid2 = (p2.rows[0] as { id: string }).id;
      await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, enabled) VALUES (gen_random_uuid(), ${STORE_A}, ${pid2}, 'OFF-SKU', 'Off', 100, false)`);
    });
    const body = await (await get('/v1/shop/feeds/facebook')).text();
    expect(body).not.toContain('DRAFT-SKU');
    expect(body).not.toContain('OFF-SKU');
    expect(body.trim().split('\n')).toHaveLength(1); // header only
  });

  it('pinterest channel renders; unknown channel 400s via the enum', async () => {
    await seedStore(STORE_A, 'feed-a');
    await seedCatalog(STORE_A, 'SKU-P1');
    const res = await get('/v1/shop/feeds/pinterest');
    expect(res.status).toBe(200);
    expect((await res.text())).toContain('custom_label_0');
    expect((await get('/v1/shop/feeds/rss')).status).toBe(400);
  });
});
