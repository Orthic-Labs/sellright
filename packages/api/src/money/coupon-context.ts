/**
 * DB-backed resolution of the native coupon-matching facts (`money/coupon.ts`
 * stays pure/no-I/O). For a set of product ids, loads each product's tags
 * (native `product.tags`) and the collections it belongs to (native
 * `collection_product`) — the two native primitives that replaced the old
 * source-facet-based `metafields.facetValueIds` lookup. Runtime never
 * references facets; only the migration importer does (see `import/catalog.ts`).
 */
import { inArray } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';

export interface CouponMatchFacts {
  productId: string;
  tags: string[];
  collectionIds: string[];
}

export async function loadCouponMatchContext(tx: Tx, productIds: string[]): Promise<Map<string, CouponMatchFacts>> {
  const ids = [...new Set(productIds)];
  const out = new Map<string, CouponMatchFacts>();
  if (!ids.length) return out;
  const [products, memberships] = await Promise.all([
    tx.select({ id: s.product.id, tags: s.product.tags }).from(s.product).where(inArray(s.product.id, ids)),
    tx.select({ productId: s.collectionProduct.productId, collectionId: s.collectionProduct.collectionId })
      .from(s.collectionProduct).where(inArray(s.collectionProduct.productId, ids)),
  ]);
  const collectionsByProduct = new Map<string, string[]>();
  for (const m of memberships) {
    const list = collectionsByProduct.get(m.productId);
    if (list) list.push(m.collectionId); else collectionsByProduct.set(m.productId, [m.collectionId]);
  }
  for (const p of products) out.set(p.id, { productId: p.id, tags: p.tags ?? [], collectionIds: collectionsByProduct.get(p.id) ?? [] });
  return out;
}

/** Builds `CouponContext.items` for a set of cart/order lines given their
 *  variant's productId — the shared shape cart.ts/checkout.ts/admin-orders.ts
 *  all need to call `evaluateCoupon`/`selectAutomaticPromotion`. */
export function couponItemsFromFacts<T extends { quantity: number; productId: string | null }>(
  lines: T[],
  facts: Map<string, CouponMatchFacts>,
): Array<{ quantity: number; productId: string; tags: string[]; collectionIds: string[] }> {
  return lines
    .filter((l): l is T & { productId: string } => l.productId != null)
    .map((l) => {
      const f = facts.get(l.productId);
      return { quantity: l.quantity, productId: l.productId, tags: f?.tags ?? [], collectionIds: f?.collectionIds ?? [] };
    });
}
