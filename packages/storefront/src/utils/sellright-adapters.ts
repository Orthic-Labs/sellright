/**
 * Adapters: SellRight REST shapes → the Vendure-ish shapes the Qwik storefront
 * components already consume. This is the strangler seam — the providers call
 * these so the consuming components (PDP, shop grid, search, cart) need no
 * shape changes. See packages/api/src/routes/catalog.ts for the source shapes.
 *
 * Money: SellRight returns integer minor units (cents); the storefront's
 * formatPrice / Price divide by 100, so prices pass straight through.
 *
 * Variant identity: SellRight catalog variants are keyed by SKU (no numeric id).
 * We use the SKU as the stable `id` everywhere a variant id is expected.
 *
 * Stock: the catalog detail endpoint carries no stock; callers hydrate it from
 * /stock (srProductStock) on the client. Until then variants default to '0'
 * (disabled) — matching the manifest-first SSR convention already in the PDP.
 */
import type {
  SrProductDetail,
  SrSearchResult,
  SrStockResult,
  SrCollection,
  SrCollectionsResult,
} from './sellright';

const IN_STOCK = '999';
const OUT_OF_STOCK = '0';

/** A search item shaped like the storefront's `SearchResponse.items[]`. */
export interface AdaptedSearchItem {
  productId: string;
  productName: string;
  slug: string;
  productVariantId: string;
  productAsset: { id: string; preview: string } | null;
  priceWithTax: { min: number; max: number };
  inStock: boolean;
  currencyCode: string;
}

/** Shaped like the storefront's `SearchResponse` (+ itemCustomFields used by the shop grid). */
export interface AdaptedSearchResponse {
  totalItems: number;
  items: AdaptedSearchItem[];
  facetValues: never[];
  collections: never[];
  itemCustomFields: never[];
}

/**
 * GET /catalog/search → SearchResponse-ish. SellRight search has no facets or
 * per-item custom fields, so those are empty (the search route's facet UI and
 * the shop grid's custom-field map both degrade gracefully on empty input).
 * `inStock` is true for every returned item: the search query already filters
 * to active products, and when the caller asks `inStock=true` the server only
 * returns in-stock rows.
 */
export function adaptSearch(res: SrSearchResult): AdaptedSearchResponse {
  return {
    totalItems: res.total,
    items: res.items.map((p) => ({
      productId: p.slug, // no numeric id server-side; slug is the stable key
      productName: p.name,
      slug: p.slug,
      productVariantId: p.slug,
      productAsset: p.image ? { id: p.slug, preview: p.image } : null,
      priceWithTax: { min: p.minPrice ?? 0, max: p.minPrice ?? 0 },
      inStock: p.status === 'active',
      currencyCode: 'USD',
    })),
    facetValues: [],
    collections: [],
    itemCustomFields: [],
  };
}

/** A product shaped like the storefront's `Product` (the subset the PDP reads). */
export interface AdaptedVariant {
  id: string;
  name: string;
  sku: string;
  price: number;
  priceWithTax: number;
  currencyCode: string;
  stockLevel: string;
  options: never[];
  assets: { id: string; preview: string }[];
  featuredAsset: { id: string; preview: string } | null;
  customFields: {
    salePrice: number | null;
    preOrderPrice: number | null;
    isPreOrder: boolean;
    shipDate: string | null;
  };
}

export interface AdaptedProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  featuredAsset: { id: string; preview: string } | null;
  assets: { id: string; preview: string }[];
  variants: AdaptedVariant[];
  facetValues: never[];
  customFields: Record<string, never>;
  hasVariantAssets: boolean;
}

/**
 * GET /catalog/products/{slug} → Product-ish. SellRight catalog has no option
 * groups, so `options: []` → the PDP's single-variant selector path resolves to
 * `variants[0]`. Stock is '0' until hydrated client-side via applyStock().
 */
export function adaptProduct(res: SrProductDetail): AdaptedProduct {
  const featuredAsset = res.images[0] ? { id: `${res.slug}-0`, preview: res.images[0] } : null;
  const assets = res.images.map((preview, i) => ({ id: `${res.slug}-${i}`, preview }));
  return {
    id: res.slug,
    name: res.name,
    slug: res.slug,
    description: res.description,
    seoTitle: res.seoTitle,
    seoDescription: res.seoDescription,
    featuredAsset,
    assets,
    variants: res.variants.map((v) => ({
      id: v.sku,
      name: v.name,
      sku: v.sku,
      price: v.price,
      priceWithTax: v.salePrice ?? v.price,
      currencyCode: res.currency,
      stockLevel: v.enabled ? IN_STOCK : OUT_OF_STOCK,
      options: [],
      assets: [],
      featuredAsset,
      customFields: {
        salePrice: v.salePrice,
        preOrderPrice: null, // not exposed by the catalog detail variant schema
        isPreOrder: v.isPreOrder,
        shipDate: null,
      },
    })),
    facetValues: [],
    customFields: {},
    hasVariantAssets: false,
  };
}

/** Merge live per-variant stock (from /stock) into an adapted product, by SKU. */
export function applyStock(product: AdaptedProduct, stock: SrStockResult): AdaptedProduct {
  const bySku = new Map(stock.variants.map((v) => [v.sku, v.inStock]));
  product.variants = product.variants.map((v) => ({
    ...v,
    stockLevel: bySku.get(v.sku) ? IN_STOCK : OUT_OF_STOCK,
  }));
  return product;
}

/** GET /catalog/products/{slug}/stock → the shape `getProductStockLevelsOnly` returns. */
export function adaptStockOnly(slug: string, stock: SrStockResult) {
  return {
    product: {
      id: slug,
      variants: stock.variants.map((v) => ({ id: v.sku, stockLevel: v.inStock ? IN_STOCK : OUT_OF_STOCK })),
    },
  };
}

/** A collection shaped like the storefront's `Collection` (the subset consumers read). */
export interface AdaptedCollection {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  featuredAsset: { id: string; preview: string } | null;
  children: never[];
  breadcrumbs: never[];
  parent: { name: '__root_collection__' };
  productVariants: { items: never[]; totalItems: number };
  products: Array<{ slug: string; name: string; minPrice: number | null }>;
}

export function adaptCollection(res: SrCollection): AdaptedCollection {
  return {
    id: res.slug,
    slug: res.slug,
    name: res.name,
    description: res.description,
    seoTitle: res.seoTitle,
    seoDescription: res.seoDescription,
    featuredAsset: null,
    children: [],
    breadcrumbs: [],
    parent: { name: '__root_collection__' },
    productVariants: { items: [], totalItems: 0 },
    products: res.products,
  };
}

export function adaptCollections(res: SrCollectionsResult): AdaptedCollection[] {
  return res.items.map((c) =>
    adaptCollection({
      slug: c.slug,
      name: c.name,
      description: null,
      seoTitle: null,
      seoDescription: null,
      products: [],
    }),
  );
}
