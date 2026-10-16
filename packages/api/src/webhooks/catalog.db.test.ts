import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { pool, withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';

vi.mock('../cache/purge-hook.js', () => ({ onCatalogCacheChanged: vi.fn() }));

import { onCatalogCacheChanged } from '../cache/purge-hook.js';
import { emitProductChanged, emitVariantProductChanged } from './catalog.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'catalog.db.test.ts');

const STORE = 'caca0000-0000-0000-0000-000000000001';
const PRODUCT = 'caca0000-0000-0000-0000-000000000002';
const VARIANT = 'caca0000-0000-0000-0000-000000000003';
const STORE_SLUG = 'catalog-purge-test';
const PRODUCT_SLUG = 'catalog-product';
const payload = { storeId: STORE, productId: PRODUCT, slug: PRODUCT_SLUG };

const helpers = [
  { kind: 'product', notify: (tx: Tx) => emitProductChanged(tx, STORE, PRODUCT) },
  { kind: 'variant', notify: (tx: Tx) => emitVariantProductChanged(tx, STORE, VARIANT) },
];

function deliveries(tx: Tx) {
  return tx.select({ topic: s.webhookDelivery.topic, payload: s.webhookDelivery.payload })
    .from(s.webhookDelivery).where(eq(s.webhookDelivery.storeId, STORE));
}

beforeEach(async () => {
  vi.clearAllMocks();
  await pool.query('TRUNCATE store CASCADE');
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, config)
      VALUES (${STORE}, ${STORE_SLUG}, 'Catalog Purge Test', ${JSON.stringify({ seo: { productUrlPattern: '/shop/{slug}/' } })}::jsonb)`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status)
      VALUES (${PRODUCT}, ${STORE}, ${PRODUCT_SLUG}, 'Original', 'active')`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price)
      VALUES (${VARIANT}, ${STORE}, ${PRODUCT}, 'CATALOG-PURGE', 'Variant', 1000)`);
    await tx.execute(sql`INSERT INTO webhook_endpoint (store_id, url, topics, secret)
      VALUES (${STORE}, 'https://example.com/catalog-hook', ARRAY['catalog.product_changed'], 'test-secret')`);
  });
});

afterAll(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await pool.end();
});

describe('catalog cache purge transaction boundary', () => {
  it.each(helpers)('purges $kind changes after commit with store-specific product path', async ({ notify }) => {
    await withStore(STORE, async (tx) => {
      await tx.update(s.product).set({ name: 'Committed' }).where(eq(s.product.id, PRODUCT));
      await notify(tx);

      expect(await deliveries(tx)).toEqual([{ topic: 'catalog.product_changed', payload }]);
      expect(onCatalogCacheChanged).not.toHaveBeenCalled();
    });

    expect(onCatalogCacheChanged).toHaveBeenCalledExactlyOnceWith(STORE_SLUG, { productPath: '/shop/catalog-product/' });
    await withStore(STORE, async (tx) => {
      expect(await deliveries(tx)).toEqual([{ topic: 'catalog.product_changed', payload }]);
      const [product] = await tx.select({ name: s.product.name }).from(s.product).where(eq(s.product.id, PRODUCT));
      expect(product?.name).toBe('Committed');
    });
  });

  it.each(helpers)('discards $kind purge & webhook event on rollback', async ({ notify }) => {
    const rollback = new Error('cancel catalog mutation');
    await expect(withStore(STORE, async (tx) => {
      await tx.update(s.product).set({ name: 'Uncommitted' }).where(eq(s.product.id, PRODUCT));
      await notify(tx);
      expect(await deliveries(tx)).toHaveLength(1);
      expect(onCatalogCacheChanged).not.toHaveBeenCalled();
      throw rollback;
    })).rejects.toBe(rollback);

    expect(onCatalogCacheChanged).not.toHaveBeenCalled();
    await withStore(STORE, async (tx) => {
      expect(await deliveries(tx)).toEqual([]);
      const [product] = await tx.select({ name: s.product.name }).from(s.product).where(eq(s.product.id, PRODUCT));
      expect(product?.name).toBe('Original');
    });
  });

  it('retains soft-deleted product slug & default product path after commit', async () => {
    await withStore(STORE, async (tx) => {
      await tx.update(s.store).set({ config: {} }).where(eq(s.store.id, STORE));
      await tx.update(s.product).set({ deletedAt: new Date(), status: 'draft' }).where(eq(s.product.id, PRODUCT));
      await emitProductChanged(tx, STORE, PRODUCT);
      expect(onCatalogCacheChanged).not.toHaveBeenCalled();
    });

    expect(onCatalogCacheChanged).toHaveBeenCalledExactlyOnceWith(STORE_SLUG, { productPath: '/products/catalog-product/' });
    expect(await withStore(STORE, deliveries)).toEqual([{ topic: 'catalog.product_changed', payload }]);
  });
});
