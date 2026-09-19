import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { emitEvent } from './emit.js';

/** Runs inside the catalog mutation transaction, including soft deletion. */
export async function emitProductChanged(tx: Tx, storeId: string, productId: string): Promise<void> {
  const [product] = await tx.select({ id: s.product.id, slug: s.product.slug })
    .from(s.product).where(and(eq(s.product.id, productId), eq(s.product.storeId, storeId))).limit(1);
  if (product) await emitEvent(tx, storeId, 'catalog.product_changed', { storeId, productId: product.id, slug: product.slug });
}

export async function emitVariantProductChanged(tx: Tx, storeId: string, variantId: string): Promise<void> {
  const [variant] = await tx.select({ productId: s.productVariant.productId })
    .from(s.productVariant).where(and(eq(s.productVariant.id, variantId), eq(s.productVariant.storeId, storeId))).limit(1);
  if (variant) await emitProductChanged(tx, storeId, variant.productId);
}
