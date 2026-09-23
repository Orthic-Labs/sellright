/**
 * SEO-1: read-only queries shared by the sitemap/robots/JSON-LD/cache-version
 * routes. Every query runs inside `withStore(...)` (RLS-scoped) like
 * catalog.ts, but every query here ALSO filters explicitly on store_id: RLS
 * is a defense-in-depth backstop, not the only tenant boundary — the test
 * database lane (and any script/job that legitimately connects as the
 * unscoped/owner Postgres role) is superuser and BYPASSES row level security
 * entirely, so a query that relied on RLS alone would silently leak rows
 * across stores whenever it ran privileged. Explicit store_id predicates make
 * isolation hold regardless of which role executes the query.
 *
 * Nothing here is cached. `latestUpdatedAt` and `productAvailability` are the
 * two functions the org's "never cache stock" invariant applies to hardest —
 * both hit Postgres on every call, matching the pattern already established
 * by catalog.ts's productInStock() / feeds.ts.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { selectUnitPrice, variantPriceRuleFromConfig, type VariantPriceRule } from '../money/pricing.js';

export interface SitemapEntry {
  slug: string;
  /** ISO-8601, or null when the row predates the updated_at backfill (unlikely — migration 0068 defaults it to now()). */
  lastmod: string | null;
}

const toIso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Active, non-deleted products — mirrors catalog.ts's product-list WHERE. */
export async function listProductSitemapEntries(tx: Tx, storeId: string): Promise<SitemapEntry[]> {
  const rows = await tx
    .select({ slug: s.product.slug, updatedAt: s.product.updatedAt })
    .from(s.product)
    .where(and(eq(s.product.storeId, storeId), eq(s.product.status, 'active'), isNull(s.product.deletedAt)))
    .orderBy(asc(s.product.slug));
  return rows.map((r) => ({ slug: r.slug, lastmod: toIso(r.updatedAt) }));
}

/** Published collections only — never advertise an unpublished collection URL. */
export async function listCollectionSitemapEntries(tx: Tx, storeId: string): Promise<SitemapEntry[]> {
  const rows = await tx
    .select({ slug: s.collection.slug, updatedAt: s.collection.updatedAt })
    .from(s.collection)
    .where(and(eq(s.collection.storeId, storeId), eq(s.collection.published, true)))
    .orderBy(asc(s.collection.slug));
  return rows.map((r) => ({ slug: r.slug, lastmod: toIso(r.updatedAt) }));
}

/** Published blog posts (publishDate null-or-past) — same visibility rule as
 *  GET /v1/shop/blog in shop-extra.ts. */
export async function listBlogSitemapEntries(tx: Tx, storeId: string): Promise<SitemapEntry[]> {
  const visible = and(
    eq(s.blogPost.storeId, storeId),
    eq(s.blogPost.isPublished, true),
    sql`(${s.blogPost.publishDate} is null or ${s.blogPost.publishDate} <= now())`,
  );
  const rows = await tx
    .select({ slug: s.blogPost.slug, updatedAt: s.blogPost.updatedAt })
    .from(s.blogPost)
    .where(visible)
    .orderBy(asc(s.blogPost.slug));
  return rows.map((r) => ({ slug: r.slug, lastmod: toIso(r.updatedAt) }));
}

/**
 * Store-wide "did anything change" signal for the cache-version endpoint.
 * GREATEST across every table whose mutation should invalidate a
 * storefront's cache: catalog content (product, product_variant, collection,
 * blog_post) AND live availability (stock) — a sellout is a cache-relevant
 * change even when no catalog row changed. Falls back to the store row's own
 * timestamps so a brand-new, empty store still returns a real value instead
 * of the Postgres epoch.
 *
 * Monotonic as long as the DB clock doesn't move backwards (it won't in
 * practice) — this is a MAX(), so it can only advance or (worst case) repeat
 * the same instant twice, never regress a version a client already observed.
 */
export async function latestStoreUpdatedAt(tx: Tx, storeId: string): Promise<Date> {
  // Deliberately literal table/column identifiers (no interpolated Column/
  // Table objects) — but every subquery ALSO filters on store_id explicitly:
  // RLS confines app.current_store-scoped connections, but this query must
  // also stay correct when it runs on a privileged connection that bypasses
  // RLS (e.g. the test suite's superuser role) — see the file header. `stock`
  // carries its own store_id column directly (no join needed).
  // Matches the codebase's raw-SQL convention (see 0049_restock_notify.sql's
  // trigger function) of literal identifiers + parameterized values only.
  const result = await tx.execute(sql`
    select greatest(
      coalesce((select max(updated_at) from product where store_id = ${storeId}), 'epoch'::timestamptz),
      coalesce((select max(updated_at) from product_variant where store_id = ${storeId}), 'epoch'::timestamptz),
      coalesce((select max(updated_at) from collection where store_id = ${storeId}), 'epoch'::timestamptz),
      coalesce((select max(updated_at) from blog_post where store_id = ${storeId}), 'epoch'::timestamptz),
      coalesce((select max(updated_at) from stock where store_id = ${storeId}), 'epoch'::timestamptz),
      coalesce((select greatest(created_at, updated_at) from store where id = ${storeId}), 'epoch'::timestamptz)
    ) as latest
  `);
  const row = result.rows[0] as { latest: Date | string } | undefined;
  const latest = row?.latest;
  return latest instanceof Date ? latest : new Date(latest ?? 0);
}

export interface ProductAvailability {
  slug: string;
  name: string;
  description: string | null;
  images: string[];
  currency: string;
  /** Lowest-priced enabled variant's unit price, in cents — the same rule
   *  cart/checkout/catalog.ts use (money/pricing.ts::selectUnitPrice). */
  price: number | null;
  sku: string | null;
  inStock: boolean;
  updatedAt: string | null;
}

/**
 * Live product snapshot for the Product JSON-LD endpoint: price and
 * availability are computed from the current `stock` row on every call —
 * never persisted/cached, matching feeds.ts and catalog.ts.
 */
export async function productAvailability(
  tx: Tx,
  storeConfig: unknown,
  currency: string,
  slug: string,
  storeId: string,
): Promise<ProductAvailability | null> {
  const [p] = await tx
    .select()
    .from(s.product)
    .where(and(eq(s.product.storeId, storeId), eq(s.product.slug, slug), eq(s.product.status, 'active'), isNull(s.product.deletedAt)))
    .limit(1);
  if (!p) return null;

  const variants = await tx
    .select({
      sku: s.productVariant.sku,
      price: s.productVariant.price,
      salePrice: s.productVariant.salePrice,
      isPreOrder: s.productVariant.isPreOrder,
      preOrderPrice: s.productVariant.preOrderPrice,
      fulfillmentType: s.productVariant.fulfillmentType,
      onHand: s.stock.onHand,
      allocated: s.stock.allocated,
    })
    .from(s.productVariant)
    .leftJoin(s.stock, eq(s.stock.variantId, s.productVariant.id))
    .where(and(eq(s.productVariant.productId, p.id), eq(s.productVariant.enabled, true), isNull(s.productVariant.deletedAt)));

  const rule: VariantPriceRule = variantPriceRuleFromConfig(storeConfig);
  const available = (v: (typeof variants)[number]) =>
    v.fulfillmentType !== 'physical' || v.isPreOrder || ((v.onHand ?? 0) - (v.allocated ?? 0)) > 0;
  const inStock = variants.some(available);

  let cheapest: (typeof variants)[number] | null = null;
  let cheapestPrice = Number.POSITIVE_INFINITY;
  for (const v of variants) {
    const unit = selectUnitPrice(v, rule);
    if (unit < cheapestPrice) {
      cheapestPrice = unit;
      cheapest = v;
    }
  }

  const imgs = await tx
    .select({ path: s.asset.path })
    .from(s.productAsset)
    .innerJoin(s.asset, eq(s.asset.id, s.productAsset.assetId))
    .where(eq(s.productAsset.productId, p.id))
    .orderBy(asc(s.productAsset.position));

  return {
    slug: p.slug,
    name: p.name,
    description: p.description,
    images: imgs.map((i) => i.path),
    currency,
    price: cheapest ? cheapestPrice : null,
    sku: cheapest?.sku ?? null,
    inStock,
    updatedAt: toIso(p.updatedAt),
  };
}
