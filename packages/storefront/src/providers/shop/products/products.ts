/**
 * Product/search provider — rewired from Vendure GraphQL to the SellRight REST
 * shop API (strangler, pass 1). Exported signatures are unchanged so consumers
 * (PDP, shop grid, search route, cart stock refresh) need no edits; the response
 * shapes are normalised to the Vendure-ish shapes via sellright-adapters.
 */
import { SearchInput } from '~/generated/graphql-shop';
import {
  srSearch,
  srProductBySlug,
  srProductStock,
} from '~/utils/sellright';
import {
  adaptSearch,
  adaptProduct,
  applyStock,
  adaptStockOnly,
} from '~/utils/sellright-adapters';

/**
 * Core search. Accepts the legacy SearchInput shape; only term / collectionSlug /
 * skip / take / inStock are honoured (SellRight search has no facet filtering).
 *
 * Return type is `any` to match the legacy GraphQL provider, whose result was
 * assigned to the route's `SearchResponse`-typed state. The runtime shape (a
 * SearchResponse subset: items/totalItems/facetValues/collections/itemCustomFields)
 * is produced by adaptSearch.
 */
export const search = async (searchInput: SearchInput): Promise<any> => {
  const res = await srSearch({
    term: searchInput.term ?? undefined,
    collectionSlug: searchInput.collectionSlug ?? undefined,
    skip: searchInput.skip ?? undefined,
    take: searchInput.take ?? undefined,
    inStock: searchInput.inStock ?? undefined,
  });
  return adaptSearch(res);
};

export const searchQueryWithCollectionSlug = async (collectionSlug: string) =>
  search({ collectionSlug });

export const searchQueryWithTerm = async (
  collectionSlug: string,
  term: string,
  _facetValueIds: string[],
  skip: number = 0,
  take: number = 10,
  inStock: boolean | undefined = undefined
) => search({ collectionSlug, term, skip, take, inStock });

export const searchOptimized = async (searchInput: SearchInput) => search(searchInput);

// Fetch only product IDs (slugs are the stable id under SellRight)
export const searchProductIds = async (searchInput: SearchInput) => {
  const res = await search(searchInput);
  return res.items.map((item: any) => item.productId);
};

// Fetch specific products by IDs
export const getSpecificProducts = async (searchInput: SearchInput) => {
  const res = await search(searchInput);
  return res.items;
};

// Optimized search with caching (cache layer unchanged; backend is now REST)
export const optimizedSearch = async (searchInput: SearchInput) => {
  const { ProductCacheService, productCache } = await import('~/services/ProductCacheService');

  const cachedResult = productCache.get('products:search:all');
  if (cachedResult) {
    const cachedProducts = Object.values((cachedResult as any).products || {});
    if (cachedProducts.length > 0) {
      return {
        totalItems: cachedProducts.length,
        items: cachedProducts.map((product: any) => ({
          productId: (product as any).productId,
          productName: (product as any).productName,
          slug: (product as any).slug,
          currencyCode: 'USD' as any,
          inStock: (product as any).inStock,
          productAsset: (product as any).productAsset,
          priceWithTax: (product as any).priceWithTax as any,
        })),
      };
    }
  }

  const result = await search(searchInput);

  const cachedProducts = result.items.map((item: any) => ({
    productId: item.productId,
    productName: item.productName,
    slug: item.slug,
    productAsset: item.productAsset
      ? { id: item.productAsset.id, preview: item.productAsset.preview }
      : null,
    inStock: item.inStock,
    priceWithTax: {
      min: item.priceWithTax.min,
      max: item.priceWithTax.max,
      value: undefined,
    },
    lastUpdated: Date.now(),
  }));

  ProductCacheService.saveProductsToCache(cachedProducts);

  return result;
};

// Return type is intentionally `any` to match the legacy GraphQL provider
// contract that consumers (the 1900-line PDP) were written against — they read
// loose Vendure-ish fields. The adapter still produces the correct runtime shape.
export const getProductBySlug = async (slug: string): Promise<any> => {
  try {
    const [detail, stock] = await Promise.all([
      srProductBySlug(slug),
      srProductStock(slug).catch(() => null),
    ]);
    const product = adaptProduct(detail);
    return stock ? applyStock(product, stock) : product;
  } catch (error) {
    // 404 (and other transport errors) surface as null so the loader can fail(404)
    console.error(`Failed to fetch product ${slug}:`, error);
    return null;
  }
};

// SellRight catalog is keyed by slug; products are not addressable by numeric id.
export const getProductById = async (_id: string): Promise<any> => {
  console.warn('getProductById is not supported by the SellRight catalog (slug-keyed)');
  return null;
};

// Fetch variant stock data only (slug)
export const getProductVariantsBySlug = async (slug: string): Promise<any> => {
  try {
    const product = await getProductBySlug(slug);
    if (product) return { id: product.id, variants: product.variants };
    return null;
  } catch (error) {
    console.error('Failed to fetch product variants:', error);
    throw error;
  }
};

// id form unsupported under SellRight (slug-keyed)
export const getProductVariantsById = async (_id: string) => {
  console.warn('getProductVariantsById is not supported by the SellRight catalog (slug-keyed)');
  return null;
};

// Cache-aware product loader with robust fallback mechanisms (cache layer unchanged)
export const getProductBySlugWithCachedVariants = async (slug: string): Promise<any> => {
  const { ProductCacheService } = await import('~/services/ProductCacheService');

  try {
    if (ProductCacheService.shouldUseStaleCache()) {
      const cache = ProductCacheService.getCachedProducts();
      if (cache) {
        const cachedProduct: any = Object.values((cache as any).products || {}).find(
          (p: any) => (p as any).slug === slug,
        );
        if (cachedProduct) {
          return {
            source: 'stale-cache',
            product: {
              id: (cachedProduct as any).productId,
              name: (cachedProduct as any).productName,
              slug: (cachedProduct as any).slug,
              description: (cachedProduct as any).description,
              featuredAsset: (cachedProduct as any).productAsset || undefined,
              productAsset: (cachedProduct as any).productAsset,
              assets: (cachedProduct as any).assets,
              facetValues: (cachedProduct as any).facetValues,
              variants: (cachedProduct as any).variants,
            },
            warning: 'Using cached data due to network issues',
          };
        }
      }
    }

    const cache: any = ProductCacheService.getCachedProducts();
    let cachedProduct: any = null;

    if (cache) {
      cachedProduct = Object.values((cache as any).products || {}).find(
        (p: any) => (p as any).slug === slug,
      ) as any;
      if (cachedProduct && (!cachedProduct.assets || (cachedProduct.assets as any[]).length === 0)) {
        try {
          const fresh = await getProductBySlug(slug);
          if (fresh?.assets?.length) {
            cachedProduct.assets = fresh.assets;
            if (!cachedProduct.productAsset && fresh.featuredAsset) {
              cachedProduct.productAsset = { id: fresh.featuredAsset.id, preview: fresh.featuredAsset.preview };
            }
          }
        } catch (_e) {
          // ignore asset hydration failures and continue with cached data
        }
      }
    }

    if (cachedProduct && ProductCacheService.isVariantDataFresh((cachedProduct as any).productId)) {
      return {
        source: 'cache',
        product: {
          id: (cachedProduct as any).productId,
          name: (cachedProduct as any).productName,
          slug: (cachedProduct as any).slug,
          description: (cachedProduct as any).description,
          featuredAsset: (cachedProduct as any).productAsset || undefined,
          productAsset: (cachedProduct as any).productAsset,
          assets: (cachedProduct as any).assets,
          facetValues: (cachedProduct as any).facetValues,
          variants: (cachedProduct as any).variants,
        },
      };
    }

    if (cachedProduct) {
      try {
        const variantResult = await getProductVariantsBySlug(slug);
        if (variantResult && variantResult.variants) {
          ProductCacheService.updateProductCacheWithVariants(
            (cachedProduct as any).productId,
            variantResult.variants as any,
          );

          return {
            source: 'hybrid',
            product: {
              id: (cachedProduct as any).productId,
              name: (cachedProduct as any).productName,
              slug: (cachedProduct as any).slug,
              description: (cachedProduct as any).description,
              featuredAsset: (cachedProduct as any).productAsset || undefined,
              productAsset: (cachedProduct as any).productAsset,
              assets: (cachedProduct as any).assets,
              facetValues: (cachedProduct as any).facetValues,
              variants: variantResult.variants,
            },
          };
        }
      } catch (variantError) {
        console.warn('Failed to fetch variant data, falling back to full product query:', variantError);

        if (ProductCacheService.isNetworkFailure(variantError)) {
          ProductCacheService.recordNetworkFailure(variantError);
          return {
            source: 'stale-cache',
            product: {
              id: (cachedProduct as any).productId,
              name: (cachedProduct as any).productName,
              slug: (cachedProduct as any).slug,
              description: (cachedProduct as any).description,
              featuredAsset: (cachedProduct as any).productAsset || undefined,
              productAsset: (cachedProduct as any).productAsset,
              assets: (cachedProduct as any).assets,
              facetValues: (cachedProduct as any).facetValues,
              variants: (cachedProduct as any).variants,
            },
            warning: 'Using cached data due to network error',
          };
        }
      }
    }

    // Fallback to full product query
    try {
      const result = await getProductBySlug(slug);
      if (result) {
        if (result.variants) {
          ProductCacheService.updateProductCacheWithVariants(result.id, result.variants as any);
        }
        return { source: 'network', product: result };
      }
    } catch (networkError) {
      console.error('Network request failed:', networkError);
      if (ProductCacheService.isNetworkFailure(networkError)) {
        ProductCacheService.recordNetworkFailure(networkError);
        if (cachedProduct) {
          console.warn('Returning stale cached data due to network failure');
          return {
            source: 'stale-cache',
            product: {
              id: (cachedProduct as any).productId,
              name: (cachedProduct as any).productName,
              slug: (cachedProduct as any).slug,
              description: (cachedProduct as any).description,
              productAsset: (cachedProduct as any).productAsset,
              assets: (cachedProduct as any).assets,
              facetValues: (cachedProduct as any).facetValues,
              variants: (cachedProduct as any).variants || [],
            },
            warning: 'Using cached data due to network error',
          };
        }
      }
      throw networkError;
    }

    return null;
  } catch (error) {
    console.error('Failed to load product with cached variants:', error);

    if (ProductCacheService.detectCorruption(error)) {
      ProductCacheService.recordCorruption(error);
    }

    const cache = ProductCacheService.getCachedProducts();
    if (cache) {
      const cachedProduct: any = Object.values((cache as any).products || {}).find(
        (p: any) => (p as any).slug === slug,
      );
      if (cachedProduct) {
        return {
          source: 'stale-cache',
          product: {
            id: (cachedProduct as any).productId,
            name: (cachedProduct as any).productName,
            slug: (cachedProduct as any).slug,
            description: (cachedProduct as any).description,
            featuredAsset: (cachedProduct as any).productAsset || undefined,
            productAsset: (cachedProduct as any).productAsset,
            assets: (cachedProduct as any).assets,
            facetValues: (cachedProduct as any).facetValues,
            variants: (cachedProduct as any).variants,
          },
          warning: 'Showing cached data due to system error',
        };
      }
    }

    try {
      const result = await getProductBySlug(slug);
      return {
        source: 'fallback',
        product: result,
        warning: 'Data may be outdated due to previous errors',
      };
    } catch (fallbackError) {
      console.error('All fallbacks failed:', fallbackError);
      if (ProductCacheService.isNetworkFailure(fallbackError)) {
        ProductCacheService.recordNetworkFailure(fallbackError);
      }
      return { source: 'error', product: null, warning: 'Unable to load product data' };
    }
  }
};

// Fetch stock levels only for a single product (used in cart validation + PDP live refresh)
export const getProductStockLevelsOnly = async (slug: string) => {
  try {
    const stock = await srProductStock(slug);
    return adaptStockOnly(slug, stock);
  } catch (error) {
    console.error(`Failed to load stock levels for ${slug}:`, error);
    throw error;
  }
};
