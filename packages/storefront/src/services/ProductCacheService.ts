/**
 * Product Cache Service
 *
 * Provides advanced caching for product data with different strategies:
 * - Static data caching (name, description, options)
 * - Stock level caching (frequent refresh)
 * - Asset caching (images)
 * - Progressive loading support
 */

import { Product } from '~/types';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiry: number;
}

interface ProductCacheConfig {
  staticDataTTL: number;      // Indefinite - invalidated by SSE product-updated events
  assetsTTL: number;          // Indefinite - invalidated by SSE product-updated events
  maxSize: number;            // Maximum entries in cache
}

export class ProductCacheService {
  private static instance: ProductCacheService;
  private cache = new Map<string, CacheEntry<any>>();
  private config: ProductCacheConfig;

  private constructor(config?: Partial<ProductCacheConfig>) {
    this.config = {
      staticDataTTL: config?.staticDataTTL || 30 * 24 * 60 * 60 * 1000, // Indefinite - invalidated by SSE product-updated events
      assetsTTL: config?.assetsTTL || 30 * 24 * 60 * 60 * 1000,    // Indefinite - invalidated by SSE product-updated events
      maxSize: config?.maxSize || 50                               // 50 entries max
    };
  }

  static getInstance(config?: Partial<ProductCacheConfig>): ProductCacheService {
    if (!ProductCacheService.instance) {
      ProductCacheService.instance = new ProductCacheService(config);
    }
    return ProductCacheService.instance;
  }

  /**
   * Get cached data if available and not expired
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if entry is still fresh
    if (Date.now() - entry.timestamp > entry.expiry) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Store data in cache with specific expiry
   */
  set<T>(key: string, data: T, expiry: number = this.config.staticDataTTL): void {
    // Implement LRU by removing oldest entry if at max size
    if (this.cache.size >= this.config.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      expiry
    });
  }

  /**
   * Clear specific cache entry or pattern
   */
  clear(keyOrPattern?: string): void {
    if (!keyOrPattern) {
      // Clear all cache
      this.cache.clear();
      return;
    }

    if (keyOrPattern.includes('*')) {
      // Pattern matching - clear all keys that match pattern
      const pattern = keyOrPattern.replace('*', '');
      for (const key of this.cache.keys()) {
        if (key.startsWith(pattern)) {
          this.cache.delete(key);
        }
      }
    } else {
      // Clear specific key
      this.cache.delete(keyOrPattern);
    }
  }

  /**
   * Clear expired entries
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.expiry) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get cache statistics for debugging
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
      entries: Array.from(this.cache.keys())
    };
  }

  // Product-specific cache methods

  /**
   * Cache static product data (name, description, options)
   */
  cacheStaticProduct(slug: string, product: Product): void {
    // Remove stock-sensitive fields before caching
    const staticData = {
      ...product,
      variants: product.variants?.map(v => ({
        ...v,
        stockLevel: undefined // Never cache stock levels
      }))
    };

    this.set(`product:static:${slug}`, staticData, this.config.staticDataTTL);
  }

  /**
   * Get static product data from cache
   */
  getStaticProduct(slug: string): Product | null {
    return this.get(`product:static:${slug}`);
  }

  // Stock levels are NEVER cached — always fetched live from the backend.

  /**
   * Cache product assets
   */
  cacheAssets(slug: string, assets: any): void {
    this.set(`product:assets:${slug}`, assets, this.config.assetsTTL);
  }

  /**
   * Get product assets from cache
   */
  getAssets(slug: string): any | null {
    return this.get(`product:assets:${slug}`);
  }

  /**
   * Merge static data with fresh stock levels
   */
  mergeProductWithStock(staticProduct: Product, stockData: any): Product {
    if (!staticProduct?.variants || !stockData?.variants) {
      return staticProduct;
    }

    return {
      ...staticProduct,
      variants: staticProduct.variants.map(staticVariant => {
        const stockVariant = stockData.variants.find((v: any) => v.id === staticVariant.id);
        return {
          ...staticVariant,
          stockLevel: stockVariant?.stockLevel || 0
        };
      })
    };
  }

  // --- Legacy compatibility static methods (used by migrated files) ---
  // These methods allow callers to use ProductCacheService as a namespace with static helpers.
  // Internally they use the singleton instance via getInstance().
  static getCachedProducts(): any {
    const data: any = ProductCacheService.getInstance().get<any>('products:cached');
    return data || null;
  }

  static saveProductsToCache(cachedProducts: any[]): void {
    const inst = ProductCacheService.getInstance();
    const data: any = inst.get<any>('products:cached') || { products: {}, variantsFreshness: {} };
    const productsMap: Record<string, any> = data.products || {};
    for (const p of cachedProducts) {
      productsMap[p.productId] = { ...productsMap[p.productId], ...p };
    }
    inst.set('products:cached', { ...data, products: productsMap }, 10 * 60 * 1000);
    // Also set a search alias used by optimizedSearch
    inst.set('products:search:all', { products: productsMap }, 5 * 60 * 1000);
  }

  static updateProductCacheWithVariants(productId: string, variants: any[]): void {
    const inst = ProductCacheService.getInstance();
    const data: any = inst.get<any>('products:cached') || { products: {}, variantsFreshness: {} };
    const productsMap: Record<string, any> = data.products || {};
    if (productsMap[productId]) {
      productsMap[productId] = { ...productsMap[productId], variants };
    } else {
      productsMap[productId] = { productId, variants };
    }
    const variantsFreshness: Record<string, number> = data.variantsFreshness || {};
    variantsFreshness[productId] = Date.now();
    inst.set('products:cached', { ...data, products: productsMap, variantsFreshness }, 10 * 60 * 1000);
  }

  static isVariantDataFresh(productId: string, ttlMs: number = 30_000): boolean {
    const inst = ProductCacheService.getInstance();
    const data: any = inst.get<any>('products:cached');
    const ts = data?.variantsFreshness?.[productId];
    return typeof ts === 'number' ? Date.now() - ts < ttlMs : false;
  }

  static recordNetworkFailure(_err?: unknown): void {
    const inst = ProductCacheService.getInstance();
    inst.set('products:lastNetworkFailure', { t: Date.now() }, 2 * 60 * 1000);
  }

  static shouldUseStaleCache(): boolean {
    const inst = ProductCacheService.getInstance();
    const rec: any = inst.get<any>('products:lastNetworkFailure');
    return !!rec && typeof rec.t === 'number' && Date.now() - rec.t < 2 * 60 * 1000;
  }

  static isNetworkFailure(err: any): boolean {
    const msg = (err && (err.message || err.toString?.())) || '';
    return /Network|fetch|Failed|ECONN|timeout/i.test(String(msg));
  }

  static detectCorruption(err: any): boolean {
    const msg = (err && (err.message || err.toString?.())) || '';
    return /corrupt|syntax/i.test(String(msg));
  }

  static recordCorruption(err: any): void {
    const inst = ProductCacheService.getInstance();
    const prev: any[] = inst.get<any>('products:lastCorruption') || [];
    inst.set('products:lastCorruption', [...prev, { t: Date.now(), err: String(err) }], 60 * 60 * 1000);
  }

  static compareVariantData(oldVariants: any[] = [], newVariants: any[] = []) {
    const byId = (arr: any[]) => Object.fromEntries(arr.map(v => [v.id, v]));
    const a = byId(oldVariants);
    const b = byId(newVariants);
    const stockChanges: any[] = [];
    const priceChanges: any[] = [];
    let hasChanges = false;
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const va = a[id];
      const vb = b[id];
      if (!va || !vb) { hasChanges = true; continue; }
      if (va.stockLevel !== vb.stockLevel) { hasChanges = true; stockChanges.push({ id, from: va.stockLevel, to: vb.stockLevel }); }
      if (va.priceWithTax !== vb.priceWithTax) { hasChanges = true; priceChanges.push({ id, from: va.priceWithTax, to: vb.priceWithTax }); }
    }
    return { hasChanges, stockChanges, priceChanges };
  }

  static compareProductData(a: any, b: any) {
    if (!a || !b) return { hasChanges: !!(a || b), changes: [] as string[] };
    const keys = ['name', 'slug', 'description'];
    const changes: string[] = [];
    for (const k of keys) { if (a[k] !== b[k]) changes.push(k); }
    const assetsA = (a.assets || []).length; const assetsB = (b.assets || []).length;
    if (assetsA !== assetsB) changes.push('assets');
    const facetsA = (a.facetValues || []).length; const facetsB = (b.facetValues || []).length;
    if (facetsA !== facetsB) changes.push('facetValues');
    return { hasChanges: changes.length > 0, changes };
  }
}

// Export singleton instance
export const productCache = ProductCacheService.getInstance();

// Auto cleanup only when explicitly enabled
let cleanupInterval: NodeJS.Timeout | null = null;

export function enableAutoCleanup(): void {
  if (typeof window !== 'undefined' && !cleanupInterval) {
    cleanupInterval = setInterval(() => {
      productCache.cleanup();
    }, 30000); // Every 30 seconds
  }
}

export function disableAutoCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

export default ProductCacheService;