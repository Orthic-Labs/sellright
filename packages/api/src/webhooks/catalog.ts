import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { afterCommit } from '../db/after-commit.js';
import * as s from '../db/schema.js';
import { emitEvent } from './emit.js';
import { onCatalogContentChanged } from '../manifest/stock-hook.js';
import { productPath, seoConfigFromStore } from '../seo/config.js';
import { collectionSlugsForProducts } from '../catalog/product-collections.js';

/**
 * Runs inside the catalog mutation transaction, including soft deletion.
 * Enqueues the webhook event atomically with the mutation. After commit it
 * schedules a scoped content publication for this product (V60 / #357: an
 * edit used to purge without regenerating the snapshot); the purge of this
 * product's page, /, /shop/, its collection pages and sitemaps follows that publication (N9), or runs at
 * once where this deployment publishes no catalog. Rolled-back mutations
 * discard both alongside the event.
 */
export async function emitProductChanged(tx: Tx, storeId: string, productId: string): Promise<void> {
  const [product] = await tx.select({ id: s.product.id, slug: s.product.slug, storeSlug: s.store.slug, storeName: s.store.name, storeConfig: s.store.config })
    .from(s.product).innerJoin(s.store, eq(s.store.id, s.product.storeId))
    .where(and(eq(s.product.id, productId), eq(s.product.storeId, storeId))).limit(1);
  if (product) {
    await emitEvent(tx, storeId, 'catalog.product_changed', { storeId, productId: product.id, slug: product.slug });
    // ADR-0001 I-4: the collection pages listing this product, read in the mutation's own transaction (used for the
    // immediate purge where no catalog is published; the publisher resolves its own set after publication).
    const collectionSlugs = await collectionSlugsForProducts(tx, storeId, [product.id]);
    afterCommit(tx, () => {
      onCatalogContentChanged(product.storeSlug, [product.id], { productPath: productPath(seoConfigFromStore({ name: product.storeName, config: product.storeConfig }), product.slug), collectionSlugs });
    });
  }
}

export async function emitVariantProductChanged(tx: Tx, storeId: string, variantId: string): Promise<void> {
  const [variant] = await tx.select({ productId: s.productVariant.productId })
    .from(s.productVariant).where(and(eq(s.productVariant.id, variantId), eq(s.productVariant.storeId, storeId))).limit(1);
  if (variant) await emitProductChanged(tx, storeId, variant.productId);
}
