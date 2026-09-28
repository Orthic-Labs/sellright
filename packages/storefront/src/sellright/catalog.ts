/**
 * Native catalog I/O — the storefront's shop/search/collections/PDP area talks
 * to the SellRight API exclusively through this module (built on `./client`).
 *
 * Every export here returns a native type from `./types/catalog` — slug/sku
 * identity, flat price/salePrice/preOrderPrice/isPreOrder fields, boolean
 * stock — no legacy discriminated-union shapes anywhere.
 */
import { sellright, SellRightError } from './client';
import {
  resolveAssetPath,
  mergeProductStock,
  withUncheckedStock,
  type CatalogListItem,
  type CatalogListResponse,
  type CatalogSearchResponse,
  type CatalogProduct,
  type CatalogStockResponse,
  type CatalogCollectionSummary,
  type CatalogCollectionDetail,
  type CatalogCollectionProduct,
} from './types/catalog';

function isNotFound(e: unknown): boolean {
  return e instanceof SellRightError && e.status === 404;
}

/** Apply `resolveAssetPath` to a list item's `image` (raw API paths aren't
 *  pre-resolved the way the manifest's are — see `types/catalog.ts`). */
function withResolvedImage(item: CatalogListItem): CatalogListItem {
  return { ...item, image: resolveAssetPath(item.image) };
}

/** Same idea as `withResolvedImage`, for a collection's (narrower) per-product
 *  tile shape — it carries no `status`/`tags`, just enough for a ProductCard. */
function withResolvedCollectionProductImage(item: CatalogCollectionProduct): CatalogCollectionProduct {
  return { ...item, image: resolveAssetPath(item.image) };
}

function withResolvedProductImages(product: CatalogProduct): CatalogProduct {
  return {
    ...product,
    images: product.images.map((p) => resolveAssetPath(p) ?? p),
    variants: product.variants.map((v) => ({
      ...v,
      assets: v.assets.map((a) => ({ preview: resolveAssetPath(a.preview) ?? a.preview })),
    })),
  };
}

/** GET /v1/shop/catalog/products — plain paginated list (no term). */
export async function fetchProductList(params: {
  limit?: number;
  offset?: number;
  collectionSlug?: string;
} = {}): Promise<CatalogListResponse> {
  const { data, error } = await sellright().GET('/v1/shop/catalog/products', {
    params: { query: params },
  });
  if (error) throw error;
  return { ...data, items: data.items.map(withResolvedImage) };
}

/** GET /v1/shop/catalog/products/{slug} — null on 404. Stock always ships
 *  fail-closed (this endpoint carries no stock); call `fetchProductStock`
 *  and merge with `mergeProductStock` for live availability. */
export async function fetchProductDetail(
  slug: string,
  opts: { currency?: string } = {},
): Promise<CatalogProduct | null> {
  try {
    const { data, error } = await sellright().GET('/v1/shop/catalog/products/{slug}', {
      params: { path: { slug }, query: opts },
    });
    if (error) throw error;
    return withUncheckedStock(withResolvedProductImages(data));
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** GET /v1/shop/catalog/products/{slug}/stock — null on 404. */
export async function fetchProductStock(slug: string): Promise<CatalogStockResponse | null> {
  try {
    const { data, error } = await sellright().GET('/v1/shop/catalog/products/{slug}/stock', {
      params: { path: { slug } },
    });
    if (error) throw error;
    return data;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** Fetch a product detail with live stock already merged in one call — the
 *  live-fallback path (manifest miss). Fail-closed if the stock call itself
 *  fails (detail without stock is still fail-closed by default). */
export async function fetchProductDetailWithStock(slug: string): Promise<CatalogProduct | null> {
  const product = await fetchProductDetail(slug);
  if (!product) return null;
  try {
    const stock = await fetchProductStock(slug);
    return stock ? mergeProductStock(product, stock) : product;
  } catch {
    return product; // stays fail-closed (withUncheckedStock already applied)
  }
}

/** GET /v1/shop/catalog/collections. */
export async function fetchCollectionList(): Promise<CatalogCollectionSummary[]> {
  const { data, error } = await sellright().GET('/v1/shop/catalog/collections', {});
  if (error) throw error;
  return data.items;
}

/** GET /v1/shop/collections/{slug} — null on 404. */
export async function fetchCollectionDetail(
  slug: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<CatalogCollectionDetail | null> {
  try {
    const { data, error } = await sellright().GET('/v1/shop/collections/{slug}', {
      params: { path: { slug }, query: opts },
    });
    if (error) throw error;
    return { ...data, products: data.products.map(withResolvedCollectionProductImage) };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** Existing callers request up to a few thousand items at once; the API caps
 *  each page at 100 — this loops pages transparently. Mirrors the previous
 *  `srSearch` pagination behaviour, reimplemented against the native client. */
async function fetchListPaged(query: {
  term?: string;
  collectionSlug?: string;
  take: number;
  skip: number;
  inStock?: boolean;
}): Promise<CatalogSearchResponse> {
  if (query.take <= 100) return fetchOnePage(query);
  const items: CatalogListItem[] = [];
  const take = Math.min(query.take, 10000);
  let total = 0;
  while (items.length < take) {
    const page = await fetchOnePage({
      ...query,
      take: Math.min(100, take - items.length),
      skip: query.skip + items.length,
    });
    total = page.total;
    if (!page.items.length && query.skip + items.length < total) {
      throw new Error('Incomplete catalog page');
    }
    items.push(...page.items);
    if (query.skip + items.length >= total) break;
  }
  return { items, total };
}

async function fetchOnePage(query: {
  term?: string;
  collectionSlug?: string;
  take: number;
  skip: number;
  inStock?: boolean;
}): Promise<CatalogSearchResponse> {
  // The search endpoint requires a non-empty term; an empty term falls back to
  // the plain product list (search has nothing to match against otherwise).
  if (query.term && query.term.trim()) {
    const { data, error } = await sellright().GET('/v1/shop/catalog/search', {
      params: {
        query: {
          term: query.term.trim(),
          collectionSlug: query.collectionSlug,
          take: query.take,
          skip: query.skip,
          inStock: query.inStock == null ? undefined : (query.inStock ? 'true' : 'false'),
        },
      },
    });
    if (error) throw error;
    return { ...data, items: data.items.map(withResolvedImage) };
  }
  const list = await fetchProductList({ limit: query.take, offset: query.skip, collectionSlug: query.collectionSlug });
  return { items: list.items, total: list.total };
}

/** GET /v1/shop/catalog/search (term/collection/in-stock filtered, paginated)
 *  — falls back to the plain product list when `term` is empty. */
export async function searchCatalog(params: {
  term?: string;
  collectionSlug?: string;
  take?: number;
  skip?: number;
  inStock?: boolean;
} = {}): Promise<CatalogSearchResponse> {
  return fetchListPaged({
    term: params.term,
    collectionSlug: params.collectionSlug,
    take: params.take ?? 24,
    skip: params.skip ?? 0,
    inStock: params.inStock,
  });
}
