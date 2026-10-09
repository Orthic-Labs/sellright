/**
 * Native catalog domain types for the storefront's shop/search/collections/PDP
 * area, derived from `@sellright/storefront-client`'s generated OpenAPI
 * `paths` (re-exported by `../client`).
 *
 * The generated spec has no reusable `components.schemas` (every response is
 * inlined per path — `components['schemas']` is literally `never`), so these
 * are derived from the relevant `paths[...]['get']['responses'][200]` shapes
 * instead. That's the equivalent of "Schemas['...']" for this API.
 *
 * A fully native shape throughout: identity is the product `slug` / variant
 * `sku`, prices are plain integer-cents fields, stock is
 * `{ inStock: boolean; availableQuantity: number | null }` — no legacy
 * discriminated-union or string-stock-level fields anywhere in this module or
 * anything built on it.
 */
import type { paths } from '../client';
import { effectiveUnitPriceCents } from '~/utils/effective-price';

type Json<P extends keyof paths, M extends 'get'> =
  paths[P][M] extends { responses: { 200: { content: { 'application/json': infer T } } } } ? T : never;

// ─────────────────────────────────────────────────────────────────────────────
// Product list / search (GET /v1/shop/catalog/products, /catalog/search)
// ─────────────────────────────────────────────────────────────────────────────

export type CatalogListResponse = Json<'/v1/shop/catalog/products', 'get'>;
export type CatalogListItem = CatalogListResponse['items'][number];
export type CatalogPricingVariant = NonNullable<CatalogListItem['pricingVariant']>;

/** Same item + envelope shape as the products list (search shares the schema). */
export type CatalogSearchResponse = Json<'/v1/shop/catalog/search', 'get'>;

// ─────────────────────────────────────────────────────────────────────────────
// Product detail (GET /v1/shop/catalog/products/{slug})
// ─────────────────────────────────────────────────────────────────────────────

export type CatalogProduct = Json<'/v1/shop/catalog/products/{slug}', 'get'>;
export type CatalogVariant = CatalogProduct['variants'][number];
export type CatalogVariantOption = CatalogVariant['options'][number];

// ─────────────────────────────────────────────────────────────────────────────
// Stock (GET /v1/shop/catalog/products/{slug}/stock)
// ─────────────────────────────────────────────────────────────────────────────

export type CatalogStockResponse = Json<'/v1/shop/catalog/products/{slug}/stock', 'get'>;
export type CatalogVariantStock = CatalogStockResponse['variants'][number];

// ─────────────────────────────────────────────────────────────────────────────
// Collections (GET /v1/shop/catalog/collections, /v1/shop/collections/{slug})
// ─────────────────────────────────────────────────────────────────────────────

export type CatalogCollectionsResponse = Json<'/v1/shop/catalog/collections', 'get'>;
export type CatalogCollectionSummary = CatalogCollectionsResponse['items'][number];

export type CatalogCollectionDetail = Json<'/v1/shop/collections/{slug}', 'get'>;
export type CatalogCollectionProduct = CatalogCollectionDetail['products'][number];

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested in catalog.test.ts) — no network, no legacy shapes
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve a raw asset path (as stored: relative name or already-absolute) to a
 *  usable URL. Idempotent — a path that's already absolute (`/...` or
 *  `http(s)://...`) passes through unchanged, so it's safe to apply to values
 *  that may have already been resolved upstream (e.g. the manifest, which
 *  stores pre-resolved paths) as well as raw API paths (which don't). */
export function resolveAssetPath(path: string | null | undefined): string | null {
  if (!path) return null;
  return /^(https?:\/\/|\/)/.test(path) ? path : `/assets/${path}`;
}

/** The effective unit price (cents) for a native catalog/PDP variant — sale
 *  price when not a pre-order and set, pre-order price when it is a
 *  pre-order and set, else the regular price. Thin wrapper over the shared
 *  `effectiveUnitPriceCents` so catalog code has one native-shaped entry point. */
export function effectiveVariantPrice(v: {
  price: number;
  salePrice: number | null;
  preOrderPrice: number | null;
  isPreOrder: boolean;
}): number {
  return effectiveUnitPriceCents(v.price, v);
}

/** LOCKED stock rule: a variant/product that hasn't been live-checked yet is
 *  unavailable, never in stock (fail closed) — never default to `true`. */
export const UNCHECKED_STOCK = { inStock: false, availableQuantity: 0 } as const;

/**
 * Raw shape written by the (out-of-scope, backend) manifest publisher
 * (packages/api/src/manifest/catalog.ts) into shop-catalog.json — the v1
 * on-disk serialization format (flat integer-cents, `id`=slug pseudo-id).
 * This is the ONLY place the raw file shape may appear in the catalog area:
 * every caller past this function only ever sees a `CatalogListItem`.
 */
export interface RawManifestListItem {
  id?: string;
  slug: string;
  name: string;
  featuredImage?: { url: string } | null;
  priceRange?: { min: number; max: number } | null;
  inStock?: boolean;
  tags?: string[] | null;
  salePrice?: number | null;
  preOrderPrice?: number | null;
  shipDate?: string | null;
  isPreOrder?: boolean | null;
}

/** Normalize one manifest list entry into the native `CatalogListItem` shape.
 *  The manifest has no real variant SKU at the tile level (only the cheapest
 *  variant's derived pricing survives publish) — the slug is used as a stable
 *  pseudo-SKU, consistent with how the rest of the catalog already treats the
 *  slug as the durable identity. */
export function normalizeManifestListItem(raw: RawManifestListItem): CatalogListItem {
  const min = raw.priceRange?.min ?? null;
  return {
    slug: raw.slug,
    name: raw.name,
    status: 'active',
    inStock: raw.inStock === true,
    tags: raw.tags ?? [],
    minPrice: min,
    pricingVariant: min == null ? null : {
      sku: raw.slug,
      price: min,
      salePrice: raw.salePrice ?? null,
      preOrderPrice: raw.preOrderPrice ?? null,
      isPreOrder: raw.isPreOrder ?? false,
      shipDate: raw.shipDate ?? null,
    },
    image: resolveAssetPath(raw.featuredImage?.url ?? null),
  };
}

/**
 * Raw shape written by the manifest publisher for `products/{slug}.json` —
 * same legacy-flavoured on-disk format as the list manifest. The detail
 * manifest carries no `enabled`/`fulfillmentType`/`appKey`/`compareAtPrice`/
 * stock fields (pre-existing backend limitation, out of scope here); this
 * normalizer fills the safe native defaults documented inline.
 */
export interface RawManifestProductDetail {
  /** Real product UUID (keys loyalty product multipliers). Absent on older snapshots. */
  productId?: string;
  /** Approved-review aggregate — present only when the product has reviews. */
  rating?: { average: number; count: number } | null;
  slug: string;
  name: string;
  description: string | null;
  featuredImage?: { url: string } | null;
  assets: Array<{ preview: string }>;
  tags?: string[] | null;
  variants: Array<{
    id: string; // sku
    name: string;
    sku: string;
    price: number; // pre-computed effective price (see note below)
    options: Array<{ code: string; name: string; groupId: string; group: string; position?: number; groupPosition?: number }>;
    assets: Array<{ preview: string }>;
    salePrice?: number | null;
    preOrderPrice?: number | null;
    shipDate?: string | null;
    isPreOrder?: boolean | null;
  }>;
}

/** Product-level facts the manifest carries that `CatalogProduct` (the live
 *  catalog-detail shape) has no field for: the product UUID (loyalty
 *  multipliers are keyed on it) and the approved-review aggregate (feeds the
 *  PDP rating link + schema.org AggregateRating). `rating` is null when the
 *  product is unreviewed — never an empty/zero rating. */
export interface ManifestProductMeta {
  productId: string | null;
  rating: { average: number; count: number } | null;
}

export function manifestProductMeta(raw: Pick<RawManifestProductDetail, 'productId' | 'rating'>): ManifestProductMeta {
  const r = raw.rating;
  return {
    productId: raw.productId ?? null,
    rating: r && r.count > 0 && r.average > 0 ? { average: r.average, count: r.count } : null,
  };
}

/** Normalize a manifest product-detail payload into the native `CatalogProduct`
 *  shell shape. Stock always ships fail-closed (never checked yet) — the PDP
 *  route merges live `/stock` data in after this.
 *
 *  Known manifest limitation: the manifest only stores each variant's
 *  pre-computed EFFECTIVE `price`, not its base `price`
 *  separately from `salePrice`/`preOrderPrice`. `price` below is set to that
 *  effective value as the best available approximation (same information the
 *  pre-conversion code displayed) — the live `/v1/shop/catalog/products/{slug}`
 *  endpoint (used on cache miss) has the real, separate fields. */
export function normalizeManifestProductDetail(raw: RawManifestProductDetail): CatalogProduct {
  const images = [
    ...(raw.featuredImage ? [raw.featuredImage.url] : []),
    ...raw.assets.map((a) => a.preview),
  ]
    .map((p) => resolveAssetPath(p))
    .filter((p): p is string => p != null);

  return {
    slug: raw.slug,
    name: raw.name,
    description: raw.description,
    tags: raw.tags ?? [],
    status: 'active',
    seoTitle: null,
    seoDescription: null,
    currency: 'USD',
    images,
    variants: raw.variants.map((v) => ({
      id: v.sku,
      sku: v.sku,
      name: v.name,
      price: v.price,
      salePrice: v.salePrice ?? null,
      preOrderPrice: v.preOrderPrice ?? null,
      shipDate: v.shipDate ?? null,
      compareAtPrice: null,
      isPreOrder: v.isPreOrder ?? false,
      enabled: true,
      options: v.options.map((o) => ({
        id: o.code,
        code: o.code,
        name: o.name,
        // Merchant order (migration 0080). Older snapshots may omit these —
        // forwarded as-is so getOptionGroups' absent-position fallback still
        // kicks in instead of sorting on a fabricated 0.
        position: o.position as number,
        group: { id: o.groupId, code: o.groupId, name: o.group, position: o.groupPosition as number },
      })),
      assets: v.assets.map((a) => ({ preview: resolveAssetPath(a.preview) ?? a.preview })),
      fulfillmentType: 'physical' as const,
      appKey: null,
      inStock: UNCHECKED_STOCK.inStock,
      availableQuantity: UNCHECKED_STOCK.availableQuantity,
    })),
  };
}

/** Merge live per-SKU stock into a product's variants. A SKU the stock
 *  response doesn't mention stays fail-closed (unavailable) rather than
 *  silently keeping whatever it had before. */
export function mergeProductStock(product: CatalogProduct, stock: CatalogStockResponse): CatalogProduct {
  const bySku = new Map(stock.variants.map((v) => [v.sku, v]));
  return {
    ...product,
    variants: product.variants.map((v) => {
      const s = bySku.get(v.sku);
      return {
        ...v,
        inStock: s?.inStock === true,
        availableQuantity: s ? s.availableQuantity : UNCHECKED_STOCK.availableQuantity,
      };
    }),
  };
}

/** Ship every variant fail-closed (unavailable) — the manifest-first,
 *  live-refresh-second convention: first paint never claims stock it hasn't
 *  actually checked. */
export function withUncheckedStock(product: CatalogProduct): CatalogProduct {
  return {
    ...product,
    variants: product.variants.map((v) => ({
      ...v,
      inStock: UNCHECKED_STOCK.inStock,
      availableQuantity: UNCHECKED_STOCK.availableQuantity,
    })),
  };
}
