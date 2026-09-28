/**
 * Product/search provider for the catalog area (shop grid, search, PDP,
 * collections). Talks to the SellRight API exclusively through
 * `~/sellright/catalog` (native types, built on `~/sellright/client`).
 *
 * Two kinds of exports live here:
 *  - NATIVE (getProductDetail, getProductStock, listProducts, searchProducts):
 *    used by this conversion's own owned call sites (shop, search,
 *    collections, PDP). Slug/sku identity, flat
 *    price/salePrice/preOrderPrice/isPreOrder fields, boolean stock.
 *  - LEGACY (search, searchQueryWithTerm, getProductBySlug,
 *    getProductStockLevelsOnly): kept byte-for-byte shape-compatible with
 *    their previous output because the homepage (routes/index.tsx) and
 *    routes/api/validate-cart still depend on that exact shape. They're
 *    implemented against the native client below; only their *output shape*
 *    is legacy.
 */
import { fetchProductDetail, fetchProductDetailWithStock, fetchProductStock, fetchProductList, searchCatalog } from '~/sellright/catalog';
import { effectiveVariantPrice, type CatalogListResponse, type CatalogProduct } from '~/sellright/types/catalog';

// ─────────────────────────────────────────────────────────────────────────────
// Native — used by this conversion's own routes/components
// ─────────────────────────────────────────────────────────────────────────────

export { fetchProductStock as getProductStock };

/** Product detail shell, fail-closed stock (LOCKED rule: never block a
 *  routeLoader$ on a stock query) — the manifest-miss fallback path for the
 *  PDP. The client hydrates real availability afterwards via `getProductStock`. */
export async function getProductDetail(slug: string): Promise<CatalogProduct | null> {
  return fetchProductDetail(slug);
}

/** Plain paginated product list (no search term). */
export async function listProducts(params: { limit?: number; offset?: number; collectionSlug?: string } = {}): Promise<CatalogListResponse> {
  return fetchProductList(params);
}

/** Native search — term/collection/in-stock filtered. SellRight has no facet
 *  filtering; callers that need it fall back to client-side tag filtering
 *  against `CatalogListItem.tags`. */
export async function searchProducts(params: {
  term?: string;
  collectionSlug?: string;
  take?: number;
  skip?: number;
  inStock?: boolean;
} = {}): Promise<CatalogListResponse> {
  return searchCatalog(params);
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy compatibility shims — DO NOT change these output shapes without
// updating every out-of-scope consumer listed in the file header first.
// ─────────────────────────────────────────────────────────────────────────────

const LEGACY_IN_STOCK = '999';
const LEGACY_OUT_OF_STOCK = '0';

/** Minimal local stand-in for the legacy `SearchInput` type —
 *  only the fields the old provider ever read. Avoids importing generated
 *  external types into this file; callers pass plain object literals either way. */
interface LegacySearchInput {
  term?: string | null;
  collectionSlug?: string | null;
  skip?: number | null;
  take?: number | null;
  inStock?: boolean | null;
}

interface LegacySearchItem {
  productId: string;
  productName: string;
  slug: string;
  productVariantId: string;
  productAsset: { id: string; preview: string } | null;
  priceWithTax: { min: number; max: number };
  inStock: boolean;
  currencyCode: string;
  facetValues: { name: string }[];
}

interface LegacySearchResponse {
  totalItems: number;
  items: LegacySearchItem[];
  facetValues: never[];
  collections: never[];
  itemCustomFields: { productVariantId: string; salePrice: number | null; preOrderPrice: number | null; isPreOrder: boolean; shipDate: string | null }[];
}

function toLegacySearchResponse(res: CatalogListResponse): LegacySearchResponse {
  return {
    totalItems: res.total,
    items: res.items.map((p) => ({
      productId: p.slug,
      productName: p.name,
      slug: p.slug,
      productVariantId: p.pricingVariant?.sku ?? p.slug,
      productAsset: p.image ? { id: p.slug, preview: p.image } : null,
      priceWithTax: { min: p.pricingVariant?.price ?? p.minPrice ?? 0, max: p.pricingVariant?.price ?? p.minPrice ?? 0 },
      inStock: p.inStock === true,
      currencyCode: 'USD',
      facetValues: (p.tags ?? []).map((name) => ({ name })),
    })),
    facetValues: [],
    collections: [],
    itemCustomFields: res.items.flatMap((p) =>
      p.pricingVariant
        ? [{ productVariantId: p.pricingVariant.sku, salePrice: p.pricingVariant.salePrice, preOrderPrice: p.pricingVariant.preOrderPrice, isPreOrder: p.pricingVariant.isPreOrder, shipDate: p.pricingVariant.shipDate }]
        : [],
    ),
  };
}

/** Legacy search — kept for the homepage's `search({ take: 4 })` call. */
export const search = async (searchInput: LegacySearchInput): Promise<LegacySearchResponse> => {
  const res = await searchCatalog({
    term: searchInput.term ?? undefined,
    collectionSlug: searchInput.collectionSlug ?? undefined,
    skip: searchInput.skip ?? undefined,
    take: searchInput.take ?? undefined,
    inStock: searchInput.inStock ?? undefined,
  });
  return toLegacySearchResponse(res);
};

/** Legacy search-by-term — kept for `routes/search` callers still on the old
 *  contract during this rollout, and for `routes/index.tsx` (homepage). The
 *  `_facetValueIds` param was already unused server-side (SellRight has no
 *  facet filtering) prior to this conversion. */
export const searchQueryWithTerm = async (
  collectionSlug: string,
  term: string,
  _facetValueIds: string[],
  skip = 0,
  take = 10,
  inStock: boolean | undefined = undefined,
) => search({ collectionSlug, term, skip, take, inStock });

interface LegacyVariant {
  id: string;
  name: string;
  sku: string;
  price: number;
  priceWithTax: number;
  currencyCode: string;
  stockLevel: string;
  options: { id: string; code: string; name: string; group: { id: string; code: string; name: string }; groupId: string }[];
  assets: { id: string; preview: string }[];
  featuredAsset: { id: string; preview: string } | null;
  customFields: { salePrice: number | null; preOrderPrice: number | null; isPreOrder: boolean; shipDate: string | null };
}

interface LegacyProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  featuredAsset: { id: string; preview: string } | null;
  assets: { id: string; preview: string }[];
  variants: LegacyVariant[];
  facetValues: { id: string; name: string; code: string; facet: { id: string; name: string; code: string } }[];
  customFields: Record<string, never>;
  hasVariantAssets: boolean;
}

function toLegacyProduct(detail: CatalogProduct): LegacyProduct {
  const featuredAsset = detail.images[0] ? { id: `${detail.slug}-0`, preview: detail.images[0] } : null;
  const assets = detail.images.map((preview, i) => ({ id: `${detail.slug}-${i}`, preview }));
  return {
    id: detail.slug,
    name: detail.name,
    slug: detail.slug,
    description: detail.description,
    seoTitle: detail.seoTitle,
    seoDescription: detail.seoDescription,
    featuredAsset,
    assets,
    variants: detail.variants.map((v) => ({
      id: v.sku,
      name: v.name,
      sku: v.sku,
      price: v.price,
      priceWithTax: effectiveVariantPrice(v),
      currencyCode: detail.currency,
      // LOCKED stock rule: fail closed. `getProductDetail`/`fetchProductDetailWithStock`
      // already merges live per-SKU stock (or leaves it fail-closed on error) — this
      // reads that merged boolean, never the variant's `enabled` flag as a stock proxy.
      stockLevel: v.inStock ? LEGACY_IN_STOCK : LEGACY_OUT_OF_STOCK,
      options: v.options.map((option) => ({ ...option, groupId: option.group.id })),
      assets: [],
      featuredAsset,
      customFields: {
        salePrice: v.salePrice,
        preOrderPrice: v.preOrderPrice ?? null,
        isPreOrder: v.isPreOrder,
        shipDate: v.shipDate ?? null,
      },
    })),
    facetValues: (detail.tags ?? []).map((name) => ({ id: name, name, code: name, facet: { id: 'tags', name: 'Tags', code: 'tags' } })),
    customFields: {},
    hasVariantAssets: false,
  };
}

/** Legacy product-by-slug — kept for routes/index.tsx (homepage),
 *  routes/api/validate-cart, and components/cart-contents/CartContents.tsx.
 *  Returns `null` on not-found (404) or any other transport error, exactly
 *  as the pre-conversion provider did, so those loaders' existing fail(404)
 *  handling needs no changes. */
export const getProductBySlug = async (slug: string): Promise<LegacyProduct | null> => {
  try {
    const detail = await fetchProductDetailWithStock(slug);
    return detail ? toLegacyProduct(detail) : null;
  } catch (error) {
    console.error('Failed to fetch product:', slug, error);
    return null;
  }
};
