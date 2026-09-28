/**
 * Reads the native catalog and publishes one complete, store-marked generation.
 * Consumers pin current, validate its marker, and fall back to REST when stale.
 *
 * SELLRIGHT-ISSUES P1 — "Full catalog regeneration on individual stock
 * changes": every stock write used to re-query and re-serialize the ENTIRE
 * active catalog, so publish cost grew with total catalog size instead of
 * the changed product — not defensible at large catalog scale. `variantIds`
 * scopes the DB work to just the affected products; unaffected products'
 * manifest/detail entries are reused from the CURRENT published generation
 * (publish.ts::readCurrentGeneration) instead of being recomputed, while
 * `publishGeneration` still always writes one COMPLETE new generation (the
 * atomic full-snapshot invariant is unchanged — a reader pinning `current`
 * still always sees a consistent whole catalog, never a half-updated one).
 * No `variantIds` (or no usable current generation to reuse from — first
 * publish, corrupted state) falls back to a full scan, exactly as before.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import { resolveStore, type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { selectUnitPrice, variantPriceRuleFromConfig, type VariantPriceRule } from '../money/pricing.js';
import { publishGeneration, readCurrentGeneration } from './publish.js';

const assetUrl = (path: string | null | undefined) => !path ? null : (/^(https?:\/\/|\/)/.test(path) ? path : `/assets/${path}`);
const selectPrice = (v: { price: number; salePrice: number | null; isPreOrder: boolean; preOrderPrice: number | null }, rule: VariantPriceRule) =>
  selectUnitPrice(v, rule);

function group<T, K>(arr: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = key(x);
    (m.get(k) ?? m.set(k, []).get(k)!).push(x);
  }
  return m;
}

type ManifestProductEntry = Awaited<ReturnType<typeof buildEntries>>['manifestProducts'][number];
type ProductDetailEntry = Awaited<ReturnType<typeof buildEntries>>['details'][number];

/**
 * Compute manifest + detail entries for exactly the given products (or every
 * active product when `productFilter` is omitted). Pure DB read + transform
 * — no filesystem I/O — so both the full-scan and scoped paths share one
 * implementation.
 */
async function buildEntries(tx: Tx, store: StoreCtx, priceRule: VariantPriceRule, productFilter?: string[]) {
  const now = new Date().toISOString();
  const baseWhere = and(eq(s.product.storeId, store.id), eq(s.product.status, 'active'), isNull(s.product.deletedAt));
  const where = productFilter ? and(baseWhere, inArray(s.product.id, productFilter)) : baseWhere;
  const products = await tx.select().from(s.product).where(where).orderBy(asc(s.product.name));
  if (!products.length) return { manifestProducts: [], details: [] };

  const productIds = products.map((p) => p.id);
  const assetById = new Map((await tx.select({ id: s.asset.id, path: s.asset.path }).from(s.asset).where(eq(s.asset.storeId, store.id))).map((a) => [a.id, a.path]));
  const variants = await tx.select().from(s.productVariant)
    .where(and(inArray(s.productVariant.productId, productIds), isNull(s.productVariant.deletedAt), eq(s.productVariant.enabled, true)))
    .orderBy(asc(s.productVariant.sku));
  const variantsByProduct = group(variants, (v) => v.productId);
  const variantIds = variants.map((v) => v.id);
  const stockByVariant = new Map(
    variantIds.length
      ? (await tx.select().from(s.stock).where(and(eq(s.stock.storeId, store.id), inArray(s.stock.variantId, variantIds)))).map((st) => [st.variantId, st.onHand - st.allocated])
      : [],
  );
  const vo = variantIds.length
    ? await tx.select({ variantId: s.variantOption.variantId, optionId: s.productOption.id, groupId: s.productOptionGroup.id, value: s.productOption.value, groupName: s.productOptionGroup.name })
      .from(s.variantOption)
      .innerJoin(s.productOption, eq(s.productOption.id, s.variantOption.optionId))
      .innerJoin(s.productOptionGroup, eq(s.productOptionGroup.id, s.productOption.groupId))
      .where(and(eq(s.variantOption.storeId, store.id), inArray(s.variantOption.variantId, variantIds)))
    : [];
  const optsByVariant = group(vo, (x) => x.variantId);
  const pa = await tx.select({ productId: s.productAsset.productId, path: s.asset.path, position: s.productAsset.position })
    .from(s.productAsset).innerJoin(s.asset, eq(s.asset.id, s.productAsset.assetId))
    .where(and(eq(s.productAsset.storeId, store.id), inArray(s.productAsset.productId, productIds)))
    .orderBy(asc(s.productAsset.position));
  const assetsByProduct = group(pa, (x) => x.productId);

  const manifestProducts = [];
  const details = [];
  for (const p of products) {
    const vs = variantsByProduct.get(p.id) ?? [];
    const prices = vs.map((v) => selectPrice(v, priceRule));
    const min = prices.length ? Math.min(...prices) : 0;
    const max = prices.length ? Math.max(...prices) : 0;
    const inStock = vs.some((v) => v.fulfillmentType !== 'physical' || v.isPreOrder || (stockByVariant.get(v.id) ?? 0) > 0);
    const featured = assetUrl(p.featuredAssetId ? assetById.get(p.featuredAssetId) : null);
    const v0 = [...vs].sort((a, b) => selectPrice(a, priceRule) - selectPrice(b, priceRule))[0];
    const cf = { salePrice: v0?.salePrice ?? null, preOrderPrice: v0?.preOrderPrice ?? null, shipDate: v0?.shipDate ?? null, isPreOrder: v0?.isPreOrder ?? false };
    manifestProducts.push({
      id: p.slug, name: p.name, slug: p.slug,
      featuredAsset: featured ? { preview: featured } : null,
      priceRange: { min, max }, inStock, facetValues: (p.tags ?? []).map(name => ({ name, facetName: 'Tags' })), hasMultiplePrices: min !== max, customFields: cf,
    });
    details.push({
      lastUpdated: now, id: p.slug, name: p.name, slug: p.slug, description: p.description,
      featuredAsset: featured ? { preview: featured } : null,
      assets: (assetsByProduct.get(p.id) ?? []).map((a) => ({ preview: assetUrl(a.path) })),
      priceRange: { min, max }, facetValues: (p.tags ?? []).map(name => ({ name, facetName: 'Tags' })), hasMultiplePrices: min !== max, hasVariantAssets: false,
      variants: vs.map((v) => ({
        id: v.sku, name: v.name, sku: v.sku, priceWithTax: selectPrice(v, priceRule),
        options: (optsByVariant.get(v.id) ?? []).map((o) => ({ group: o.groupName, groupId: o.groupId, code: o.optionId, name: o.value })),
        assets: [],
        customFields: { salePrice: v.salePrice, preOrderPrice: v.preOrderPrice, shipDate: v.shipDate, isPreOrder: v.isPreOrder },
      })),
    });
  }
  return { manifestProducts, details };
}

/** Product ids owning ANY of `variantIds`, regardless of the variant's or the
 *  product's current enabled/active/deleted state — a variant that just got
 *  disabled, or a product that just got archived, still needs its manifest
 *  entry RECOMPUTED (which will correctly drop it) or REMOVED, not skipped. */
async function productIdsForVariants(tx: Tx, storeId: string, variantIds: string[]): Promise<string[]> {
  if (!variantIds.length) return [];
  const rows = await tx.select({ productId: s.productVariant.productId }).from(s.productVariant)
    .where(and(eq(s.productVariant.storeId, storeId), inArray(s.productVariant.id, variantIds)));
  return [...new Set(rows.map((r) => r.productId))];
}

/** Slugs for a set of product ids, regardless of status/deleted — needed to
 *  find and drop a manifest entry for a product that no longer recomputes
 *  (archived/deleted since the last publish). */
async function slugsForProductIds(tx: Tx, storeId: string, productIds: string[]): Promise<string[]> {
  if (!productIds.length) return [];
  const rows = await tx.select({ slug: s.product.slug }).from(s.product)
    .where(and(eq(s.product.storeId, storeId), inArray(s.product.id, productIds)));
  return rows.map((r) => r.slug);
}

interface PublishPayload {
  manifest: { lastUpdated: string; totalItems: number; defaultSort: string; products: ManifestProductEntry[] };
  details: ProductDetailEntry[];
}

export async function publishCatalogManifest(args: { outDir: string; storeSlug: string; variantIds?: string[] }) {
  const now = new Date().toISOString();
  const store = await resolveStore(args.storeSlug);
  const priceRule = variantPriceRuleFromConfig(store.config);

  const scoped: PublishPayload | null = args.variantIds?.length
    ? await withStore(store.id, async (tx): Promise<PublishPayload | null> => {
        const current = await readCurrentGeneration(args.outDir, args.storeSlug);
        if (!current) return null; // no reusable snapshot — caller falls back to full scan
        const affectedProductIds = await productIdsForVariants(tx, store.id, args.variantIds!);
        if (!affectedProductIds.length) return null; // variant(s) resolved to nothing real — full scan is the safe default
        // Sequential, not Promise.all: these share one transaction/connection.
        const { manifestProducts: freshEntries, details: freshDetails } = await buildEntries(tx, store, priceRule, affectedProductIds);
        const possiblyStaleSlugs = await slugsForProductIds(tx, store.id, affectedProductIds);
        // Merge: start from the reused (unaffected) entries, drop every slug
        // that MIGHT need updating (possiblyStaleSlugs — the product's slug
        // as it exists right now for each affected id), then add back
        // whatever buildEntries freshly computed for the still-active ones.
        // A product that's no longer active/deleted correctly stays dropped.
        const productMap = new Map<string, ManifestProductEntry>(current.manifest.products.map((p) => [p.slug, p as unknown as ManifestProductEntry]));
        const detailMap = new Map<string, ProductDetailEntry>(current.details.map((d) => [d.slug, d as unknown as ProductDetailEntry]));
        for (const staleSlug of possiblyStaleSlugs) { productMap.delete(staleSlug); detailMap.delete(staleSlug); }
        for (const entry of freshEntries) productMap.set(entry.slug, entry as ManifestProductEntry);
        for (const entry of freshDetails) detailMap.set(entry.slug, entry as ProductDetailEntry);
        const manifestProducts = [...productMap.values()].sort((a, b) => (a.name as string).localeCompare(b.name as string));
        const details = manifestProducts.map((p) => detailMap.get(p.slug)!).filter(Boolean);
        return { manifest: { lastUpdated: now, totalItems: manifestProducts.length, defaultSort: 'name', products: manifestProducts }, details };
      })
    : null;

  const { manifest, details } = scoped ?? await withStore(store.id, async (tx): Promise<PublishPayload> => {
    const { manifestProducts, details } = await buildEntries(tx, store, priceRule);
    return { manifest: { lastUpdated: now, totalItems: manifestProducts.length, defaultSort: 'name', products: manifestProducts }, details };
  });

  return publishGeneration({ outDir: args.outDir, storeSlug: args.storeSlug, manifest, details });
}
