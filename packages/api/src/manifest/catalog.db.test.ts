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

      // SR-CLIENT-1 — v2 (native): stable UUID ids (not slug/sku), tags as a
      // plain array, prices as { amount, currency, taxInclusive }, and
      // compareAt/sale/preorder as independent native fields (never a
      // Vendure-flavored customFields grab-bag).
      const manifestV2 = JSON.parse(await readFile(join(outDir, 'current/shop-catalog.v2.json'), 'utf8'));
      expect(manifestV2.products).toHaveLength(1);
      expect(manifestV2.products[0]).toMatchObject({
        id: product, slug: 'fixture', tags: ['edc'], inStock: true,
        priceRange: { min: { amount: 3000, currency: 'USD', taxInclusive: false }, max: { amount: 3000, currency: 'USD', taxInclusive: false } },
        images: [{ url: '/assets/fixture/product.webp', position: 0 }],
        hasSale: true, hasPreOrder: true, // sale 2000 < base 5000; variant flagged pre-order
      });
      const detailV2 = JSON.parse(await readFile(join(outDir, 'current/products-v2/fixture.json'), 'utf8'));
      expect(detailV2.id).toBe(product);
      expect(detailV2.tags).toEqual(['edc']);
      expect(detailV2.variants).toHaveLength(1);
      expect(detailV2.variants[0]).toMatchObject({
        id: variant, sku: 'FIXTURE',
        price: { amount: 3000, currency: 'USD', taxInclusive: false }, // preorder rule active, preOrderPrice wins
        compareAtPrice: { amount: 5000, currency: 'USD', taxInclusive: false }, // base price, since 3000 < 5000
        salePrice: { amount: 2000, currency: 'USD', taxInclusive: false }, // exposed independently of which rule is active
        preOrderPrice: { amount: 3000, currency: 'USD', taxInclusive: false },
        isPreOrder: true,
        options: [{ code: option, groupId: group, group: 'Color', name: 'Red' }],
      });

      await withStore(store, async tx => { await tx.execute(sql`UPDATE product_variant SET enabled = false WHERE id = ${variant}`); });
      await publishCatalogManifest({ outDir, storeSlug: slug });
      expect(JSON.parse(await readFile(join(outDir, 'current/products/fixture.json'), 'utf8')).variants).toEqual([]);
      expect(JSON.parse(await readFile(join(outDir, 'current/products-v2/fixture.json'), 'utf8')).variants).toEqual([]);
      // With the only variant disabled, the grid badges must clear too.
      expect(JSON.parse(await readFile(join(outDir, 'current/shop-catalog.v2.json'), 'utf8')).products[0]).toMatchObject({ hasSale: false, hasPreOrder: false, inStock: false });
      await withStore(store, async tx => { await tx.execute(sql`UPDATE product SET deleted_at = now() WHERE id = ${product}`); });
      expect((await publishCatalogManifest({ outDir, storeSlug: slug })).products).toBe(0);
      await expect(readFile(join(outDir, 'current/products/fixture.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(outDir, 'current/products-v2/fixture.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await pool.query('SELECT 1 AS ready')).rows[0].ready).toBe(1);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  // Migration 0080: option groups/values are ordered by merchant-set
  // `position` (id as a stable tiebreak), never alphabetically. 'Zebra' /
  // 'Apple' and 'Large' / 'Small' are chosen so an alphabetical bug would be
  // immediately visible as a swap in both v1 and v2 output.
  it('orders option groups and values by position, not name, in both v1 and v2', async () => {
    const store = randomUUID(), product = randomUUID(), variant = randomUUID();
    const zebraGroup = randomUUID(), appleGroup = randomUUID();
    const large = randomUUID(), small = randomUUID(), red = randomUUID(), blue = randomUUID();
    const slug = `manifest-position-${store}`;
    const outDir = await mkdtemp(join(tmpdir(), 'sr-manifest-position-db-'));
    try {
      await withStore(store, async tx => {
        await tx.execute(sql`INSERT INTO store (id, slug, name, currency) VALUES (${store}, ${slug}, 'Fixture', 'USD')`);
        await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${product}, ${store}, 'fixture', 'Fixture', 'active')`);
        await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${variant}, ${store}, ${product}, 'FIXTURE', 'V', 1000)`);
        // Zebra Color (position 0) placed BEFORE Apple Size (position 1) —
        // the opposite of alphabetical order.
        await tx.execute(sql`INSERT INTO product_option_group (id, store_id, product_id, name, position) VALUES (${zebraGroup}, ${store}, ${product}, 'Zebra Color', 0), (${appleGroup}, ${store}, ${product}, 'Apple Size', 1)`);
        // Within Zebra Color: Blue (0) before Red (1) — opposite of alphabetical.
        await tx.execute(sql`INSERT INTO product_option (id, store_id, group_id, value, position) VALUES (${blue}, ${store}, ${zebraGroup}, 'Blue', 0), (${red}, ${store}, ${zebraGroup}, 'Red', 1)`);
        // Within Apple Size: Large (0) before Small (1) — matches alphabetical
        // here, so the group-order assertion is the one actually proving the fix.
        await tx.execute(sql`INSERT INTO product_option (id, store_id, group_id, value, position) VALUES (${large}, ${store}, ${appleGroup}, 'Large', 0), (${small}, ${store}, ${appleGroup}, 'Small', 1)`);
        await tx.execute(sql`INSERT INTO variant_option (store_id, variant_id, option_id) VALUES (${store}, ${variant}, ${blue}), (${store}, ${variant}, ${red}), (${store}, ${variant}, ${large}), (${store}, ${variant}, ${small})`);
      });
      await publishCatalogManifest({ outDir, storeSlug: slug });
      const expectedOrder = [
        { group: 'Zebra Color', name: 'Blue' },
        { group: 'Zebra Color', name: 'Red' },
        { group: 'Apple Size', name: 'Large' },
        { group: 'Apple Size', name: 'Small' },
      ];
      const detail = JSON.parse(await readFile(join(outDir, 'current/products/fixture.json'), 'utf8'));
      expect(detail.variants[0].options.map((o: { group: string; name: string }) => ({ group: o.group, name: o.name }))).toEqual(expectedOrder);
      const detailV2 = JSON.parse(await readFile(join(outDir, 'current/products-v2/fixture.json'), 'utf8'));
      expect(detailV2.variants[0].options.map((o: { group: string; name: string }) => ({ group: o.group, name: o.name }))).toEqual(expectedOrder);
      // groupPosition/position are carried onto every option entry too, so a
      // consumer that re-groups client-side (rather than trusting array
      // order) still sorts correctly.
      expect(detailV2.variants[0].options[0]).toMatchObject({ groupPosition: 0, position: 0 });
      expect(detailV2.variants[0].options[2]).toMatchObject({ groupPosition: 1, position: 0 });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  // SELLRIGHT-ISSUES P1: per-product regeneration. `variantIds` must reuse
  // the unaffected product's entry from the current generation untouched,
  // recompute only the affected one, and still publish one COMPLETE new
  // generation (both products present) — never a partial/half-updated one.
  it('scopes a regeneration to the affected product, reusing the rest of the current generation untouched', async () => {
    const store = randomUUID();
    const productA = randomUUID(), variantA = randomUUID();
    const productB = randomUUID(), variantB = randomUUID();
    const slug = `manifest-scoped-${store}`;
    const outDir = await mkdtemp(join(tmpdir(), 'sr-manifest-scoped-db-'));
    try {
      await withStore(store, async tx => {
        await tx.execute(sql`INSERT INTO store (id, slug, name, currency) VALUES (${store}, ${slug}, 'Fixture', 'USD')`);
        await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${productA}, ${store}, 'prod-a', 'Product A', 'active')`);
        await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${variantA}, ${store}, ${productA}, 'A1', 'A1', 1000)`);
        await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${variantA}, ${store}, 5, 0)`);
        await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${productB}, ${store}, 'prod-b', 'Product B', 'active')`);
        await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${variantB}, ${store}, ${productB}, 'B1', 'B1', 2000)`);
        await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${variantB}, ${store}, 3, 0)`);
      });
      const first = await publishCatalogManifest({ outDir, storeSlug: slug });
      expect(first.products).toBe(2);
      const firstGenB = JSON.parse(await readFile(join(outDir, 'current/products/prod-b.json'), 'utf8'));

      // Only A's stock changes — B's entry must be byte-for-byte reused.
      await withStore(store, async tx => { await tx.execute(sql`UPDATE stock SET on_hand = 0 WHERE variant_id = ${variantA}`); });
      const scoped = await publishCatalogManifest({ outDir, storeSlug: slug, variantIds: [variantA] });
      expect(scoped.products).toBe(2); // still a COMPLETE generation, not just the one changed product

      const manifest = JSON.parse(await readFile(join(outDir, 'current/shop-catalog.json'), 'utf8'));
      const a = manifest.products.find((p: { slug: string }) => p.slug === 'prod-a');
      const b = manifest.products.find((p: { slug: string }) => p.slug === 'prod-b');
      expect(a.inStock).toBe(false); // recomputed
      expect(b.inStock).toBe(true); // reused, unaffected

      const detailB = JSON.parse(await readFile(join(outDir, 'current/products/prod-b.json'), 'utf8'));
      expect(detailB).toEqual(firstGenB); // reused verbatim — proves it was NOT re-queried/re-serialized

      // v2 doesn't share v1's incremental-reuse optimization (always a full
      // scan — see catalog.ts's buildEntries doc comment), so a SCOPED v1
      // publish must still produce a CORRECT, COMPLETE v2 for both products,
      // stock included, not just the explicitly-scoped one.
      const manifestV2 = JSON.parse(await readFile(join(outDir, 'current/shop-catalog.v2.json'), 'utf8'));
      expect(manifestV2.products).toHaveLength(2);
      const av2 = manifestV2.products.find((p: { slug: string }) => p.slug === 'prod-a');
      const bv2 = manifestV2.products.find((p: { slug: string }) => p.slug === 'prod-b');
      expect(av2.inStock).toBe(false);
      expect(bv2.inStock).toBe(true);

      // Archiving the affected product's owner must DROP its entry, not
      // leave a stale one behind, even on the scoped path.
      await withStore(store, async tx => { await tx.execute(sql`UPDATE product SET deleted_at = now() WHERE id = ${productA}`); });
      const afterDelete = await publishCatalogManifest({ outDir, storeSlug: slug, variantIds: [variantA] });
      expect(afterDelete.products).toBe(1);
      await expect(readFile(join(outDir, 'current/products/prod-a.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('falls back to a full scan when there is no current generation to reuse from yet', async () => {
    const store = randomUUID();
    const product = randomUUID(), variant = randomUUID();
    const slug = `manifest-firstpub-${store}`;
    const outDir = await mkdtemp(join(tmpdir(), 'sr-manifest-firstpub-db-'));
    try {
      await withStore(store, async tx => {
        await tx.execute(sql`INSERT INTO store (id, slug, name, currency) VALUES (${store}, ${slug}, 'Fixture', 'USD')`);
        await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${product}, ${store}, 'only-product', 'Only', 'active')`);
        await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${variant}, ${store}, ${product}, 'O1', 'O1', 500)`);
      });
      // variantIds passed on the VERY FIRST publish — no current generation
      // exists to reuse from, so this must still produce a complete manifest.
      const result = await publishCatalogManifest({ outDir, storeSlug: slug, variantIds: [variant] });
      expect(result.products).toBe(1);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
