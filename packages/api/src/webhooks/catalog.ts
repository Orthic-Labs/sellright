import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { afterCommit } from '../db/after-commit.js';
import * as s from '../db/schema.js';
import { emitEvent } from './emit.js';
import { onCatalogCacheChanged } from '../cache/purge-hook.js';
import { productPath, seoConfigFromStore } from '../seo/config.js';

/**
 * Runs inside the catalog mutation transaction, including soft deletion.
 * Enqueues the webhook event atomically with the mutation, then fires the
 * cache-purge hook for this product's PDP + shop/sitemaps only after commit.
 * Rolled-back mutations discard the purge alongside the event.
 */
export async function emitProductChanged(tx: Tx, storeId: string, productId: string): Promise<void> {
  const [product] = await tx.select({ id: s.product.id, slug: s.product.slug, storeSlug: s.store.slug, storeName: s.store.name, storeConfig: s.store.config })
    .from(s.product).innerJoin(s.store, eq(s.store.id, s.product.storeId))
    .where(and(eq(s.product.id, productId), eq(s.product.storeId, storeId))).limit(1);
  if (product) {
    await emitEvent(tx, storeId, 'catalog.product_changed', { storeId, productId: product.id, slug: product.slug });
    afterCommit(tx, () => {
      onCatalogCacheChanged(product.storeSlug, { productPath: productPath(seoConfigFromStore({ name: product.storeName, config: product.storeConfig }), product.slug) });
    });
  }
}

export async function emitVariantProductChanged(tx: Tx, storeId: string, variantId: string): Promise<void> {
  const [variant] = await tx.select({ productId: s.productVariant.productId })
    .from(s.productVariant).where(and(eq(s.productVariant.id, variantId), eq(s.productVariant.storeId, storeId))).limit(1);
  if (variant) await emitProductChanged(tx, storeId, variant.productId);
}
