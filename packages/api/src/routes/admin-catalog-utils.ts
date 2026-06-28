import { eq, isNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { productMatchesRules, parseRules } from '../catalog/collection-rules.js';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';

export async function smartCollectionProducts(tx: Tx, rules: unknown) {
  const parsed = parseRules(rules);
  if (!parsed) return [];
  const rows = await tx
    .select({
      id: s.product.id, name: s.product.name, status: s.product.status, vendor: s.product.vendor,
      productType: s.product.productType, tags: s.product.tags,
      minPrice: sql<number | null>`(select min(price) from product_variant pv where pv.product_id = ${s.product.id} and pv.deleted_at is null)`,
    })
    .from(s.product)
    .where(isNull(s.product.deletedAt));
  return rows
    .filter((r) => productMatchesRules({ name: r.name, vendor: r.vendor, productType: r.productType, tags: r.tags, minPrice: r.minPrice }, parsed))
    .map((r) => ({ id: r.id, name: r.name, status: r.status, position: 0 }));
}

export async function uniqueSlug(tx: { select: Function }, table: typeof s.product | typeof s.collection, base: string): Promise<string> {
  let slug = base;
  for (let i = 0; i < 5; i++) {
    const [hit] = await (tx as any).select({ id: table.id }).from(table).where(eq(table.slug, slug)).limit(1);
    if (!hit) return slug;
    slug = `${base}-${randomBytes(2).toString('hex')}`;
  }
  return `${base}-${randomBytes(4).toString('hex')}`;
}
