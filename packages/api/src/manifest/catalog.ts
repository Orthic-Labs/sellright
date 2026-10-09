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
import { aggregatesForProducts } from '../reviews/reviews.js';

const assetUrl = (path: string | null | undefined) => !path ? null : (/^(https?:\/\/|\/)/.test(path) ? path : `/assets/${path}`);
const selectPrice = (v: { price: number; salePrice: number | null; isPreOrder: boolean; preOrderPrice: number | null }, rule: VariantPriceRule) =>
  selectUnitPrice(v, rule);

// ─────────────────────────────────────────────────────────────────────────────
// Manifest v2 — SR-CLIENT-1 (storefront-client audit).
//
// v1 above is the original storefront manifest format — a flat integer-cents
// shape (variant `id`=sku, product `id`=slug, plain `price`/`tags`/
// `featuredImage`/`assets[].url`, sale/preorder fields flattened onto each
// entry). It once mirrored Vendure's field names for reader parity during
// the migration; those names are gone — only the file layout remains "v1".
//
// v2 is the native shape: stable ids (the real product/variant UUID, not
// slug/sku), sku kept as its own field, tags as a plain string array, every
// price as an explicit `{ amount, currency, taxInclusive }` (no more a bare
// int that LOOKS tax-inclusive-flavored but isn't), compareAt/sale/preorder
// as their own native fields instead of a Vendure-flavored `customFields`
// grab-bag, images as `{ url, alt, position }[]`, and `inStock` as the ONLY
// availability signal — never a raw stock number (the zero-cache-stock rule
// applies here exactly as everywhere else: this manifest is regenerated on
// every StockMovementEvent with no debounce, and a client must re-check live
// stock at cart/checkout regardless of what `inStock` said at manifest time).
//
// v1 is kept, unmodified, until the storefront migrates onto the generated
// client; v2 is additive (a second file per generation, see publish.ts).
// @deprecated v1's shape is Vendure-parity scaffolding, not the native
// contract — new consumers (the storefront-client package) should read v2.

export interface NativeMoney {
  amount: number;
  currency: string;
  taxInclusive: boolean;
}

export interface NativeImage {
  url: string;
  alt: string | null;
  position: number;
}

export interface NativeVariantV2 {
  id: string;
  sku: string;
  name: string;
  /** The effective selling price (same selection rule as v1: store's
   *  configured sale/preorder precedence). */
  price: NativeMoney;
  /** The original price to show crossed out, ONLY when a sale/preorder
   *  override is actually in effect (i.e. `price.amount < basePrice`).
   *  Null when nothing is overriding the base price — never a duplicate of
   *  `price`. */
  compareAtPrice: NativeMoney | null;
  salePrice: NativeMoney | null;
  preOrderPrice: NativeMoney | null;
  isPreOrder: boolean;
  shipDate: string | null;
  // position: merchant-controlled order (migration 0080) — groupPosition
  // orders the groups, position orders values within that group. This array
  // arrives pre-sorted by both (see buildEntries' `vo` query); position is
  // carried through anyway so a consumer that re-groups client-side (rather
  // than trusting array order) still sorts correctly.
  options: Array<{ group: string; groupId: string; groupPosition: number; code: string; name: string; position: number }>;
  images: NativeImage[];
}

export interface NativeProductManifestEntryV2 {
  id: string;
  slug: string;
  name: string;
  tags: string[];
  priceRange: { min: NativeMoney; max: NativeMoney };
  /** Opt-in display range including disabled choices; never a purchase quote. */
  displayPriceRange?: { min: NativeMoney; max: NativeMoney };
  hasMultiplePrices: boolean;
  /** Availability only — see the file-level note above. Never a quantity. */
  inStock: boolean;
  /** Any enabled variant has a sale price actually below its base price —
   *  shop grids need only this flag for a SALE badge; the amounts live on
   *  the variant detail entries. */
  hasSale: boolean;
  /** Any enabled variant is a pre-order — for a PRE-ORDER badge on grids. */
  hasPreOrder: boolean;
  images: NativeImage[];
  /** Approved-review aggregate (REWARDS-1) — present only when the product has reviews. Feeds schema.org AggregateRating. */
  rating?: { average: number; count: number };
}

export interface NativeProductDetailV2 extends NativeProductManifestEntryV2 {
  lastUpdated: string;
  description: string | null;
  variants: NativeVariantV2[];
  /** Opt-in disabled choices for crossed-out display only. Never purchasable. */
  displayOnlyVariants?: NativeVariantV2[];
}

function nativeMoney(amount: number, store: Pick<StoreCtx, 'currency' | 'taxInclusive'>): NativeMoney {
  return { amount, currency: store.currency, taxInclusive: store.taxInclusive };
}

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
  if (!products.length) return { manifestProducts: [], details: [], manifestProductsV2: [], detailsV2: [] };

  const productIds = products.map((p) => p.id);
  const ratingByProduct = await aggregatesForProducts(tx, store.id, productIds);
  const assetById = new Map((await tx.select({ id: s.asset.id, path: s.asset.path }).from(s.asset).where(eq(s.asset.storeId, store.id))).map((a) => [a.id, a.path]));
  const showDisabledVariants = (store.config as { catalog?: { showDisabledVariants?: boolean } } | null)?.catalog?.showDisabledVariants === true;
  const catalogVariants = await tx.select().from(s.productVariant)
    .where(and(inArray(s.productVariant.productId, productIds), isNull(s.productVariant.deletedAt), showDisabledVariants ? undefined : eq(s.productVariant.enabled, true)))
    .orderBy(asc(s.productVariant.sku));
  const variants = catalogVariants.filter((v) => v.enabled);
  const variantsByProduct = group(variants, (v) => v.productId);
  const displayByProduct = group(catalogVariants.filter((v) => !v.enabled), (v) => v.productId);
  const variantIds = catalogVariants.map((v) => v.id);
  const enabledVariantIds = variants.map((v) => v.id);
  const stockByVariant = new Map(
    enabledVariantIds.length
      ? (await tx.select().from(s.stock).where(and(eq(s.stock.storeId, store.id), inArray(s.stock.variantId, enabledVariantIds)))).map((st) => [st.variantId, st.onHand - st.allocated])
      : [],
  );
  const vo = variantIds.length
    ? await tx.select({
        variantId: s.variantOption.variantId, optionId: s.productOption.id, groupId: s.productOptionGroup.id,
        value: s.productOption.value, groupName: s.productOptionGroup.name,
        position: s.productOption.position, groupPosition: s.productOptionGroup.position,
      })
      .from(s.variantOption)
      .innerJoin(s.productOption, eq(s.productOption.id, s.variantOption.optionId))
      .innerJoin(s.productOptionGroup, eq(s.productOptionGroup.id, s.productOption.groupId))
      .where(and(eq(s.variantOption.storeId, store.id), inArray(s.variantOption.variantId, variantIds)))
      // Merchant-controlled order (migration 0080), id as a stable tiebreak —
      // both manifest v1 and v2 below read this pre-sorted array as-is.
      .orderBy(asc(s.productOptionGroup.position), asc(s.productOptionGroup.id), asc(s.productOption.position), asc(s.productOption.id))
    : [];
  const optsByVariant = group(vo, (x) => x.variantId);
  const pa = await tx.select({ productId: s.productAsset.productId, path: s.asset.path, position: s.productAsset.position })
    .from(s.productAsset).innerJoin(s.asset, eq(s.asset.id, s.productAsset.assetId))
    .where(and(eq(s.productAsset.storeId, store.id), inArray(s.productAsset.productId, productIds)))
    .orderBy(asc(s.productAsset.position));
  const assetsByProduct = group(pa, (x) => x.productId);
  const va = variantIds.length
    ? await tx.select({ variantId: s.variantAsset.variantId, path: s.asset.path, position: s.variantAsset.position })
      .from(s.variantAsset).innerJoin(s.asset, eq(s.asset.id, s.variantAsset.assetId))
      .where(and(eq(s.variantAsset.storeId, store.id), inArray(s.variantAsset.variantId, variantIds)))
      .orderBy(asc(s.variantAsset.position), asc(s.variantAsset.assetId))
    : [];
  const assetsByVariant = group(va, (x) => x.variantId);

  const manifestProducts = [];
  const details = [];
  const manifestProductsV2: NativeProductManifestEntryV2[] = [];
  const detailsV2: NativeProductDetailV2[] = [];
  for (const p of products) {
    const vs = variantsByProduct.get(p.id) ?? [];
    const prices = vs.map((v) => selectPrice(v, priceRule));
    const min = prices.length ? Math.min(...prices) : 0;
    const max = prices.length ? Math.max(...prices) : 0;
    const inStock = vs.some((v) => v.fulfillmentType !== 'physical' || v.isPreOrder || (stockByVariant.get(v.id) ?? 0) > 0);
    const featured = assetUrl(p.featuredAssetId ? assetById.get(p.featuredAssetId) : null);
    const v0 = [...vs].sort((a, b) => selectPrice(a, priceRule) - selectPrice(b, priceRule))[0];
    const agg = ratingByProduct.get(p.id);
    const ratingField = agg && agg.count > 0 ? { rating: { average: agg.average, count: agg.count } } : {};
    const cf = { salePrice: v0?.salePrice ?? null, preOrderPrice: v0?.preOrderPrice ?? null, shipDate: v0?.shipDate ?? null, isPreOrder: v0?.isPreOrder ?? false };
    manifestProducts.push({
      id: p.slug, name: p.name, slug: p.slug,
      featuredImage: featured ? { url: featured } : null,
      priceRange: { min, max }, inStock, tags: p.tags ?? [], hasMultiplePrices: min !== max,
      salePrice: cf.salePrice, preOrderPrice: cf.preOrderPrice, shipDate: cf.shipDate, isPreOrder: cf.isPreOrder,
      ...ratingField,
    });
    details.push({
      lastUpdated: now, id: p.slug, productId: p.id, name: p.name, slug: p.slug, description: p.description,
      featuredImage: featured ? { url: featured } : null,
      assets: (assetsByProduct.get(p.id) ?? []).map((a) => ({ preview: assetUrl(a.path) })),
      priceRange: { min, max }, tags: p.tags ?? [], hasMultiplePrices: min !== max,
      hasVariantAssets: vs.some((v) => (assetsByVariant.get(v.id)?.length ?? 0) > 0),
      ...ratingField,
      variants: vs.map((v) => ({
        id: v.sku, name: v.name, sku: v.sku, price: selectPrice(v, priceRule),
        options: (optsByVariant.get(v.id) ?? []).map((o) => ({ group: o.groupName, groupId: o.groupId, groupPosition: o.groupPosition, code: o.optionId, name: o.value, position: o.position })),
        assets: (assetsByVariant.get(v.id) ?? []).map((a) => ({ preview: assetUrl(a.path) })),
        salePrice: v.salePrice, preOrderPrice: v.preOrderPrice, shipDate: v.shipDate, isPreOrder: v.isPreOrder,
      })),
    });

    // ── v2 (native) — same data, native shapes; see the file-level note above. ──
    const productImages: NativeImage[] = (assetsByProduct.get(p.id) ?? [])
      .map((a, i): NativeImage | null => { const url = assetUrl(a.path); return url ? { url, alt: null, position: i } : null; })
      .filter((x): x is NativeImage => x !== null);
    const manifestImages: NativeImage[] = featured ? [{ url: featured, alt: null, position: 0 }] : [];
    const toNativeVariant = (v: typeof catalogVariants[number]): NativeVariantV2 => {
      const effective = selectPrice(v, priceRule);
      return {
        id: v.id,
        sku: v.sku,
        name: v.name,
        price: nativeMoney(effective, store),
        compareAtPrice: effective < v.price ? nativeMoney(v.price, store) : null,
        salePrice: v.salePrice != null ? nativeMoney(v.salePrice, store) : null,
        preOrderPrice: v.preOrderPrice != null ? nativeMoney(v.preOrderPrice, store) : null,
        isPreOrder: v.isPreOrder,
        shipDate: v.shipDate ? v.shipDate.toISOString() : null,
        options: (optsByVariant.get(v.id) ?? []).map((o) => ({ group: o.groupName, groupId: o.groupId, groupPosition: o.groupPosition, code: o.optionId, name: o.value, position: o.position })),
        images: (assetsByVariant.get(v.id) ?? [])
          .map((a, i): NativeImage | null => { const url = assetUrl(a.path); return url ? { url, alt: null, position: i } : null; })
          .filter((image): image is NativeImage => image !== null),
      };
    };
    const variantsV2 = vs.map(toNativeVariant);
    const displayOnlyVariants = (displayByProduct.get(p.id) ?? []).map(toNativeVariant);
    const displayPrices = [...vs, ...(displayByProduct.get(p.id) ?? [])].map((v) => selectPrice(v, priceRule));
    const displayMetadata = showDisabledVariants && displayPrices.length ? { displayPriceRange: {
      min: nativeMoney(Math.min(...displayPrices), store),
      max: nativeMoney(Math.max(...displayPrices), store),
    } } : {};
    manifestProductsV2.push({
      ...displayMetadata,
      id: p.id, slug: p.slug, name: p.name, tags: p.tags ?? [],
      priceRange: { min: nativeMoney(min, store), max: nativeMoney(max, store) },
      hasMultiplePrices: min !== max, inStock, images: manifestImages,
      hasSale: vs.some((v) => v.salePrice != null && v.salePrice < v.price),
      hasPreOrder: vs.some((v) => v.isPreOrder),
      ...ratingField,
    });
    detailsV2.push({
      ...displayMetadata,
      ...(showDisabledVariants ? { displayOnlyVariants } : {}),
      id: p.id, slug: p.slug, name: p.name, tags: p.tags ?? [],
      priceRange: { min: nativeMoney(min, store), max: nativeMoney(max, store) },
      hasMultiplePrices: min !== max, inStock, images: productImages,
      hasSale: vs.some((v) => v.salePrice != null && v.salePrice < v.price),
      hasPreOrder: vs.some((v) => v.isPreOrder),
      lastUpdated: now, description: p.description, variants: variantsV2,
      ...ratingField,
    });
  }
  return { manifestProducts, details, manifestProductsV2, detailsV2 };
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
  manifestV2: { lastUpdated: string; totalItems: number; defaultSort: string; products: NativeProductManifestEntryV2[] };
  detailsV2: NativeProductDetailV2[];
}

const v2Envelope = (now: string, manifestProductsV2: NativeProductManifestEntryV2[]) =>
  ({ lastUpdated: now, totalItems: manifestProductsV2.length, defaultSort: 'name', products: manifestProductsV2 });

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
        // v2 doesn't (yet) share v1's incremental-reuse optimization above —
        // it's new and not yet load-bearing, and correctness-via-full-scan
        // beats a second, separately-maintained merge algorithm for a
        // not-yet-relied-upon format. Reuses this same open transaction, so
        // it costs one more (uncached) query set, not another connection.
        const { manifestProductsV2, detailsV2 } = await buildEntries(tx, store, priceRule);
        return {
          manifest: { lastUpdated: now, totalItems: manifestProducts.length, defaultSort: 'name', products: manifestProducts }, details,
          manifestV2: v2Envelope(now, manifestProductsV2), detailsV2,
        };
      })
    : null;

  const { manifest, details, manifestV2, detailsV2 } = scoped ?? await withStore(store.id, async (tx): Promise<PublishPayload> => {
    const { manifestProducts, details, manifestProductsV2, detailsV2 } = await buildEntries(tx, store, priceRule);
    return {
      manifest: { lastUpdated: now, totalItems: manifestProducts.length, defaultSort: 'name', products: manifestProducts }, details,
      manifestV2: v2Envelope(now, manifestProductsV2), detailsV2,
    };
  });

  return publishGeneration({ outDir: args.outDir, storeSlug: args.storeSlug, manifest, details, manifestV2, detailsV2 });
}
