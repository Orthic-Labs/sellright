import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';

/**
 * ADR-0001 I-4: slugs of the published collection pages that can render any of `productIds` — the manual collections
 * that list them, plus every smart (rules) collection, since a content edit (price, tags, status) can move a product
 * into or out of a rule's result and the old membership is not recoverable after commit. Sorted, de-duplicated.
 * Run inside a store-scoped transaction (RLS + explicit store filter).
 */
export async function collectionSlugsForProducts(tx: Tx, storeId: string, productIds: readonly string[]): Promise<string[]> {
  if (!productIds.length) return [];
  const manual = await tx.selectDistinct({ slug: s.collection.slug })
    .from(s.collectionProduct)
    .innerJoin(s.collection, eq(s.collection.id, s.collectionProduct.collectionId))
    .where(and(eq(s.collectionProduct.storeId, storeId), inArray(s.collectionProduct.productId, [...productIds]), eq(s.collection.storeId, storeId), eq(s.collection.published, true)));
  const smart = await tx.select({ slug: s.collection.slug }).from(s.collection)
    .where(and(eq(s.collection.storeId, storeId), isNotNull(s.collection.rules), eq(s.collection.published, true)));
  return [...new Set([...manual, ...smart].map((r) => r.slug))].sort();
}
