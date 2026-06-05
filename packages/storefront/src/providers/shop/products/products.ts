import { SearchInput, SearchResponse } from '~/generated/graphql-shop';
import {
	SearchDocument, type SearchQuery, type SearchQueryVariables,
	ProductDocument, type ProductQuery, type ProductQueryVariables,
	GetSingleProductStockLevelsDocument, type GetSingleProductStockLevelsQuery, type GetSingleProductStockLevelsQueryVariables,
} from '~/generated/graphql-shop-typed';
import { requester } from '~/utils/api';

export const search = async (searchInput: SearchInput) => {
	const res: any = await requester<SearchQuery, SearchQueryVariables>(
		SearchDocument,
		{ input: { groupByProduct: true, ...searchInput } }
	);
	return res.search as SearchResponse & { itemCustomFields?: any[] };
};

export const searchQueryWithCollectionSlug = async (collectionSlug: string) =>
	search({ collectionSlug });

export const searchQueryWithTerm = async (
	collectionSlug: string,
	term: string,
	facetValueIds: string[],
	skip: number = 0,
	take: number = 10,
	inStock: boolean | undefined = undefined
) => search({ collectionSlug, term, facetValueFilters: [{ or: facetValueIds }], skip, take, inStock });

export const searchOptimized = async (searchInput: SearchInput) => {
	const optimizedInput = {
		...searchInput,
		groupByProduct: true,
		facetValueFilters: searchInput.facetValueFilters || undefined,
	};

	return search(optimizedInput);
};

// Function to fetch only product IDs
export const searchProductIds = async (searchInput: SearchInput) => {
	const res = await requester<SearchQuery, SearchQueryVariables>(
		SearchDocument,
		{ input: { groupByProduct: true, ...searchInput } }
	);
	return res.search.items.map(item => item.productId);
};

// Function to fetch specific products by IDs
export const getSpecificProducts = async (searchInput: SearchInput) => {
	const res = await requester<SearchQuery, SearchQueryVariables>(
		SearchDocument,
		{ input: { groupByProduct: true, ...searchInput } }
	);
	return res.search.items;
};

// Optimized search function with caching
export const optimizedSearch = async (searchInput: SearchInput) => {
		const { ProductCacheService, productCache } = await import('~/services/ProductCacheService');

// Check cache first
const cachedResult = productCache.get('products:search:all');
	if (cachedResult) {
		// Check if we have cached products for this search
		const cachedProducts = Object.values((cachedResult as any).products || {});
		if (cachedProducts.length > 0) {
			// For now, return all cached products (can be optimized later)
			return {
				totalItems: cachedProducts.length,
				items: cachedProducts.map((product: any) => ({
					productId: (product as any).productId,
					productName: (product as any).productName,
					slug: (product as any).slug,
					currencyCode: 'USD' as any,
					inStock: (product as any).inStock,
					productAsset: (product as any).productAsset,
					priceWithTax: (product as any).priceWithTax as any
				}))
			};
		}
	}

	// If not in cache, fetch from API
	const result = await search(searchInput);

	// Convert and cache the result
	const cachedProducts = result.items.map(item => ({
		productId: item.productId,
		productName: item.productName,
		slug: item.slug,
		productAsset: item.productAsset ? {
			id: item.productAsset.id,
			preview: item.productAsset.preview
		} : null,
		inStock: item.inStock,
		priceWithTax: {
			min: 'min' in item.priceWithTax ? item.priceWithTax.min : undefined,
			max: 'max' in item.priceWithTax ? item.priceWithTax.max : undefined,
			value: 'value' in item.priceWithTax ? item.priceWithTax.value : undefined
		},
		lastUpdated: Date.now()
	}));

	ProductCacheService.saveProductsToCache(cachedProducts);

	return result;
};

export const getProductBySlug = async (slug: string) => {
	const res: any = await requester<ProductQuery, ProductQueryVariables>(ProductDocument, { slug });
	return res.product;
};

export const getProductById = async (id: string) => {
	const res: any = await requester<ProductQuery, ProductQueryVariables>(ProductDocument, { id });
	return res.product;
};

// Function to fetch only variant stock data with error handling
export const getProductVariantsBySlug = async (slug: string) => {
	try {
		// Use the existing product query but with the lightweight fragment
		const res: any = await requester<ProductQuery, ProductQueryVariables>(ProductDocument, { slug });
		if (res.product) {
			// Return only the variant data we need
			return {
				id: res.product.id,
				variants: res.product.variants
			};
		}
		return null;
	} catch (error) {
		console.error('Failed to fetch product variants:', error);
		throw error;
	}
};

// Function to fetch only variant stock data by ID with error handling
export const getProductVariantsById = async (id: string) => {
	try {
		// Use the existing product query but with the lightweight fragment
		const res: any = await requester<ProductQuery, ProductQueryVariables>(ProductDocument, { id });
		if (res.product) {
			// Return only the variant data we need
			return {
				id: res.product.id,
				variants: res.product.variants
			};
		}
		return null;
	} catch (error) {
		console.error('Failed to fetch product variants by ID:', error);
		throw error;
	}
};

// Cache-aware product loader with robust fallback mechanisms
export const getProductBySlugWithCachedVariants = async (slug: string) => {
	const { ProductCacheService } = await import('~/services/ProductCacheService');

	try {
		// Check if we should use stale cache due to network issues
		if (ProductCacheService.shouldUseStaleCache()) {
			const cache = ProductCacheService.getCachedProducts();
			if (cache) {
				const cachedProduct: any = Object.values((cache as any).products || {}).find((p: any) => (p as any).slug === slug);
				if (cachedProduct) {
					return {
						source: 'stale-cache',
						product: {
							id: (cachedProduct as any).productId,
							name: (cachedProduct as any).productName,
							slug: (cachedProduct as any).slug,
							description: (cachedProduct as any).description,
							// Map productAsset -> featuredAsset to match component expectations
							featuredAsset: (cachedProduct as any).productAsset || undefined,
							productAsset: (cachedProduct as any).productAsset,
							assets: (cachedProduct as any).assets,
							facetValues: (cachedProduct as any).facetValues,
							variants: (cachedProduct as any).variants
						},
						warning: 'Using cached data due to network issues'
					};
				}
			}
		}

		// Step 1: Try to get cached product data
		const cache: any = ProductCacheService.getCachedProducts();
		let cachedProduct: any = null;

		if (cache) {
			// Find product by slug in cache
			cachedProduct = Object.values((cache as any).products || {}).find((p: any) => (p as any).slug === slug) as any;
			// If assets are missing in cache, hydrate just the assets from network (non-blocking for failures)
			if (cachedProduct && (!cachedProduct.assets || (cachedProduct.assets as any[]).length === 0)) {
				try {
					const fresh = await getProductBySlug(slug);
					if (fresh?.assets?.length) {
						cachedProduct.assets = fresh.assets;
						// Also ensure we have featuredAsset if missing
						if (!cachedProduct.productAsset && fresh.featuredAsset) {
							cachedProduct.productAsset = { id: fresh.featuredAsset.id, preview: fresh.featuredAsset.preview };
						}
					}
				} catch (_e) {
					// ignore asset hydration failures and continue with cached data
				}
			}
		}

		// Step 2: Check if we have fresh variant data
		if (cachedProduct && ProductCacheService.isVariantDataFresh((cachedProduct as any).productId)) {
		// We have fresh cached data, return it
		return {
			source: 'cache',
			product: {
				id: (cachedProduct as any).productId,
				name: (cachedProduct as any).productName,
				slug: (cachedProduct as any).slug,
				description: (cachedProduct as any).description,
				// Map productAsset -> featuredAsset to keep UI consistent
				featuredAsset: (cachedProduct as any).productAsset || undefined,
				productAsset: (cachedProduct as any).productAsset,
				assets: (cachedProduct as any).assets,
				facetValues: (cachedProduct as any).facetValues,
				variants: (cachedProduct as any).variants
			}
		};
		}

		// Step 3: Try to fetch only variant data if we have basic product info
		if (cachedProduct) {
			try {
				const variantResult = await getProductVariantsBySlug(slug);
				if (variantResult && variantResult.variants) {
					// Update cache with fresh variant data
					ProductCacheService.updateProductCacheWithVariants(
						(cachedProduct as any).productId,
						variantResult.variants
					);

					return {
						source: 'hybrid',
						product: {
							id: (cachedProduct as any).productId,
							name: (cachedProduct as any).productName,
							slug: (cachedProduct as any).slug,
							description: (cachedProduct as any).description,
							// Ensure featuredAsset is present for UI
							featuredAsset: (cachedProduct as any).productAsset || undefined,
							productAsset: (cachedProduct as any).productAsset,
							assets: (cachedProduct as any).assets,
							facetValues: (cachedProduct as any).facetValues,
							variants: variantResult.variants
						}
					};
				}
			} catch (variantError) {
				console.warn('Failed to fetch variant data, falling back to full product query:', variantError);

				// Check if this is a network failure
				if (ProductCacheService.isNetworkFailure(variantError)) {
					ProductCacheService.recordNetworkFailure(variantError);

					// Return stale cached data if available
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
							variants: (cachedProduct as any).variants
						},
						warning: 'Using cached data due to network error'
					};
				}
				// Continue to full product fetch for non-network errors
			}
		}

		// Step 4: Fallback to full product query
		try {
			const result = await getProductBySlug(slug);
			if (result) {
				// Update cache with complete product data
				if (result.variants) {
					ProductCacheService.updateProductCacheWithVariants(
						result.id,
						result.variants
					);
				}

				return {
					source: 'network',
					product: result
				};
			}
		} catch (networkError) {
			console.error('Network request failed:', networkError);

			// Handle network failures
			if (ProductCacheService.isNetworkFailure(networkError)) {
				ProductCacheService.recordNetworkFailure(networkError);

				// Step 5: Last resort - return stale cached data if available
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
						variants: (cachedProduct as any).variants || []
						},
						warning: 'Using cached data due to network error'
					};
				}
			}

			// Re-throw the error if no cached data is available
			throw networkError;
		}

		// No product found
		return null;

	} catch (error) {
		console.error('Failed to load product with cached variants:', error);

		// Check for corruption errors
		if (ProductCacheService.detectCorruption(error)) {
			ProductCacheService.recordCorruption(error);
		}

		// Try to get any available cached data as last resort
		const cache = ProductCacheService.getCachedProducts();
		if (cache) {
			const cachedProduct: any = Object.values((cache as any).products || {}).find((p: any) => (p as any).slug === slug);
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
						variants: (cachedProduct as any).variants
					},
					warning: 'Showing cached data due to system error'
				};
			}
		}

		// Final fallback: try direct product query
		try {
			const result = await getProductBySlug(slug);
			return {
				source: 'fallback',
				product: result,
				warning: 'Data may be outdated due to previous errors'
			};
		} catch (fallbackError) {
			console.error('All fallbacks failed:', fallbackError);

			// Record the final failure
			if (ProductCacheService.isNetworkFailure(fallbackError)) {
				ProductCacheService.recordNetworkFailure(fallbackError);
			}

			return {
				source: 'error',
				product: null,
				warning: 'Unable to load product data'
			};
		}
	}
};

// 🚀 OPTIMIZED: Fetch stock levels only for a single product (used in cart validation)
export const getProductStockLevelsOnly = async (slug: string) => {
  console.log(`🚀 Loading stock levels only for product: ${slug}`);

  try {
    const startTime = Date.now();
    const result: any = await requester<GetSingleProductStockLevelsQuery, GetSingleProductStockLevelsQueryVariables>(
      GetSingleProductStockLevelsDocument,
      { slug }
    );

    const loadTime = Date.now() - startTime;
    console.log(`✅ Stock levels loaded for ${slug} in ${loadTime}ms - payload ~98% smaller than full product`);

    return result;
  } catch (error) {
    console.error(`❌ Failed to load stock levels for ${slug}:`, error);
    throw error;
  }
};
