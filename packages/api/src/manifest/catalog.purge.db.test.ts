/**
 * ADR-0001 I-4: what a catalog publication purges. A scoped (product content) publication hands purgeAfterPublish
 * the product page(s) + every collection page that can list them; a full rebuild (affected set unknown) hands it
 * null (host purge). purge:false (stock) never calls it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

const { purgeAfterPublish } = vi.hoisted(() => ({ purgeAfterPublish: vi.fn(async () => 'purged' as const) }));
vi.mock('../cache/purge-hook.js', () => ({ purgeAfterPublish }));

import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { publishCatalogManifest } from './catalog.js';
import { CatalogPurgeError } from './catalog.js';

if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Catalog fixture requires a *_test database');
afterAll(() => pool.end());
beforeEach(() => { purgeAfterPublish.mockClear(); purgeAfterPublish.mockImplementation(async () => 'purged'); });

async function fixture() {
  const store = randomUUID(), a = randomUUID(), b = randomUUID(), va = randomUUID(), vb = randomUUID();
  const summer = randomUUID(), other = randomUUID(), smart = randomUUID();
  const slug = `catalog-purge-${store}`;
  await withStore(store, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${store}, ${slug}, 'Fixture', 'USD', '{"seo":{"productUrlPattern":"/shop/{slug}/"}}')`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${a}, ${store}, 'alpha', 'Alpha', 'active'), (${b}, ${store}, 'beta', 'Beta', 'active')`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${va}, ${store}, ${a}, 'A', 'A', 1000), (${vb}, ${store}, ${b}, 'B', 'B', 1000)`);
    await tx.execute(sql`INSERT INTO collection (id, store_id, slug, name, published, rules) VALUES
      (${summer}, ${store}, 'summer', 'Summer', true, NULL), (${other}, ${store}, 'other', 'Other', true, NULL),
      (${smart}, ${store}, 'smart', 'Smart', true, '{"match":"all","conditions":[{"field":"price","op":"lt","value":5000}]}'::jsonb)`);
    await tx.execute(sql`INSERT INTO collection_product (store_id, collection_id, product_id) VALUES (${store}, ${summer}, ${a}), (${store}, ${other}, ${b})`);
  });
  return { slug, a, va };
}

describe('publishCatalogManifest purge scope (ADR-0001 I-4)', () => {
  it('a product content publication purges its page and exactly the collections that can list it', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'sr-catalog-purge-'));
    try {
      const { slug, a } = await fixture();
      await publishCatalogManifest({ outDir, storeSlug: slug, purge: false });
      expect(purgeAfterPublish).not.toHaveBeenCalled();
      await publishCatalogManifest({ outDir, storeSlug: slug, productIds: [a] });
      expect(purgeAfterPublish).toHaveBeenCalledExactlyOnceWith(slug, { productPaths: ['/shop/alpha/'], collectionSlugs: ['smart', 'summer'] });
    } finally { await rm(outDir, { recursive: true, force: true }); }
  });

  it('a full rebuild (affected set unknown) purges the whole host', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'sr-catalog-purge-'));
    try {
      const { slug, a } = await fixture();
      // No current generation to reuse: even a product-scoped trigger becomes a full rebuild.
      await publishCatalogManifest({ outDir, storeSlug: slug, productIds: [a] });
      expect(purgeAfterPublish).toHaveBeenCalledExactlyOnceWith(slug, null);
    } finally { await rm(outDir, { recursive: true, force: true }); }
  });

  it('a stock publication (purge:false) purges no HTML', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'sr-catalog-purge-'));
    try {
      const { slug, va } = await fixture();
      await publishCatalogManifest({ outDir, storeSlug: slug, purge: false });
      await publishCatalogManifest({ outDir, storeSlug: slug, variantIds: [va], purge: false });
      expect(purgeAfterPublish).not.toHaveBeenCalled();
    } finally { await rm(outDir, { recursive: true, force: true }); }
  });

  it('a failed purge after publication throws CatalogPurgeError (durable retry kept)', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'sr-catalog-purge-'));
    try {
      const { slug, a } = await fixture();
      await publishCatalogManifest({ outDir, storeSlug: slug, purge: false });
      purgeAfterPublish.mockImplementation(async () => 'failed' as never);
      await expect(publishCatalogManifest({ outDir, storeSlug: slug, productIds: [a] })).rejects.toBeInstanceOf(CatalogPurgeError);
    } finally { await rm(outDir, { recursive: true, force: true }); }
  });
});
