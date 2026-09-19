import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { publishCatalogManifest } from './catalog.js';

if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Catalog fixture requires a *_test database');
afterAll(() => pool.end());

describe('native catalog generation', () => {
  it('publishes native prices, options, assets and current enabled products without closing the shared pool', async () => {
    const store = randomUUID(), product = randomUUID(), variant = randomUUID(), group = randomUUID(), option = randomUUID(), asset = randomUUID();
    const slug = `manifest-${store}`;
    const outDir = await mkdtemp(join(tmpdir(), 'sr-manifest-db-'));
    try {
      await withStore(store, async tx => {
        await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${store}, ${slug}, 'Fixture', 'USD', '{"pricing":{"variantRule":"preorder"}}')`);
        await tx.execute(sql`INSERT INTO asset (id, store_id, type, path) VALUES (${asset}, ${store}, 'image', 'fixture/product.webp')`);
        await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status, featured_asset_id, tags) VALUES (${product}, ${store}, 'fixture', 'Fixture', 'active', ${asset}, ARRAY['edc'])`);
        await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, sale_price, is_pre_order, pre_order_price) VALUES (${variant}, ${store}, ${product}, 'FIXTURE', 'Red', 5000, 2000, true, 3000)`);
        await tx.execute(sql`INSERT INTO product_option_group (id, store_id, product_id, name) VALUES (${group}, ${store}, ${product}, 'Color')`);
        await tx.execute(sql`INSERT INTO product_option (id, store_id, group_id, value) VALUES (${option}, ${store}, ${group}, 'Red')`);
        await tx.execute(sql`INSERT INTO variant_option (store_id, variant_id, option_id) VALUES (${store}, ${variant}, ${option})`);
      });
      const first = await publishCatalogManifest({ outDir, storeSlug: slug });
      expect(first.products).toBe(1);
      const manifest = JSON.parse(await readFile(join(outDir, 'current/shop-catalog.json'), 'utf8'));
      expect(manifest.products).toHaveLength(1);
      expect(manifest.products[0]).toMatchObject({ priceRange: { min: 3000, max: 3000 }, inStock: true, featuredAsset: { preview: '/assets/fixture/product.webp' }, facetValues: [{ name: 'edc' }] });
      const detail = JSON.parse(await readFile(join(outDir, 'current/products/fixture.json'), 'utf8'));
      expect(detail.facetValues).toEqual([{ name: 'edc', facetName: 'Tags' }]);
      expect(detail.variants[0]).toMatchObject({ id: 'FIXTURE', priceWithTax: 3000, options: [{ code: option, groupId: group, group: 'Color', name: 'Red' }] });
      await withStore(store, async tx => { await tx.execute(sql`UPDATE product_variant SET enabled = false WHERE id = ${variant}`); });
      await publishCatalogManifest({ outDir, storeSlug: slug });
      expect(JSON.parse(await readFile(join(outDir, 'current/products/fixture.json'), 'utf8')).variants).toEqual([]);
      await withStore(store, async tx => { await tx.execute(sql`UPDATE product SET deleted_at = now() WHERE id = ${product}`); });
      expect((await publishCatalogManifest({ outDir, storeSlug: slug })).products).toBe(0);
      await expect(readFile(join(outDir, 'current/products/fixture.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await pool.query('SELECT 1 AS ready')).rows[0].ready).toBe(1);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
