/**
 * localStorage-based shop data cache.
 * Caches the full search response so repeat visits to /shop render instantly
 * from localStorage while the server revalidates in the background.
 *
 * Invalidated by SSE product-updated and stock-changed events.
 * No TTL — invalidation-driven only.
 */

const KEYS = {
	searchResponse: 'dd_shop_search',
	featuredImages: 'dd_featured_images',
};

export interface CachedSearchItem {
	productId: string;
	productVariantId: string;
	productName: string;
	slug: string;
	productAsset: { id: string; preview: string } | null;
	inStock: boolean;
	priceWithTax: any;
}

export interface CachedSearchResponse {
	items: CachedSearchItem[];
	itemCustomFields: any[];
	totalItems: number;
	/** URL search params that produced this cache (for cache key matching) */
	cacheKey: string;
}

function safeGet<T>(key: string): T | null {
	try {
		const raw = localStorage.getItem(key);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

function safeSet(key: string, data: any): void {
	try {
		localStorage.setItem(key, JSON.stringify(data));
	} catch {
		// localStorage full or unavailable
	}
}

/**
 * Build a cache key from the URL search params that affect shop results.
 */
function buildCacheKey(params: { term: string; facetIds: string[]; inStockOnly: boolean }): string {
	return `q=${params.term}|f=${params.facetIds.sort().join(',')}|s=${params.inStockOnly}`;
}

export const ShopCache = {
	/**
	 * Get cached search response if it matches the current query params.
	 */
	getSearchResponse(params: { term: string; facetIds: string[]; inStockOnly: boolean }): CachedSearchResponse | null {
		const cached = safeGet<CachedSearchResponse>(KEYS.searchResponse);
		if (!cached) return null;
		const key = buildCacheKey(params);
		if (cached.cacheKey !== key) return null;
		return cached;
	},

	/**
	 * Cache the search response.
	 */
	setSearchResponse(
		params: { term: string; facetIds: string[]; inStockOnly: boolean },
		response: { items: any[]; itemCustomFields?: any[]; totalItems: number }
	): void {
		const cached: CachedSearchResponse = {
			items: response.items.map((item: any) => ({
				productId: item.productId,
				productVariantId: item.productVariantId,
				productName: item.productName,
				slug: item.slug,
				productAsset: item.productAsset ? { id: item.productAsset.id, preview: item.productAsset.preview } : null,
				inStock: item.inStock,
				priceWithTax: item.priceWithTax,
			})),
			itemCustomFields: response.itemCustomFields || [],
			totalItems: response.totalItems,
			cacheKey: buildCacheKey(params),
		};
		safeSet(KEYS.searchResponse, cached);
	},

	/**
	 * Get cached featured image URL for a product.
	 */
	getImageUrl(productId: string): string | null {
		const images = safeGet<Record<string, string>>(KEYS.featuredImages);
		return images?.[productId] || null;
	},

	/**
	 * Cache featured image URLs for products.
	 */
	setFeaturedImages(products: Array<{ productId: string; imageUrl: string }>): void {
		const existing = safeGet<Record<string, string>>(KEYS.featuredImages) || {};
		for (const p of products) {
			existing[p.productId] = p.imageUrl;
		}
		safeSet(KEYS.featuredImages, existing);
	},

	/**
	 * Clear all shop caches. Called by SSE product-updated / stock-changed events.
	 */
	clearAll(): void {
		try {
			localStorage.removeItem(KEYS.searchResponse);
			localStorage.removeItem(KEYS.featuredImages);
		} catch {
			// ignore
		}
	},
};
