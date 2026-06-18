interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiry: number;
}

const CACHE_TTL = 10 * 60 * 1000;
const FAILURE_TTL = 2 * 60 * 1000;
const CORRUPTION_TTL = 60 * 60 * 1000;
const MAX_SIZE = 50;

const cache = new Map<string, CacheEntry<any>>();

function get<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.timestamp > entry.expiry) {
    cache.delete(key);
    return null;
  }

  return entry.data;
}

function set<T>(key: string, data: T, expiry = CACHE_TTL): void {
  if (cache.size >= MAX_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }

  cache.set(key, { data, timestamp: Date.now(), expiry });
}

function clear(keyOrPattern?: string): void {
  if (!keyOrPattern) {
    cache.clear();
    return;
  }

  if (!keyOrPattern.includes('*')) {
    cache.delete(keyOrPattern);
    return;
  }

  const prefix = keyOrPattern.replace('*', '');
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

function getCachedProducts(): any {
  return get<any>('products:cached') || null;
}

function saveProductsToCache(cachedProducts: any[]): void {
  const data: any = get<any>('products:cached') || { products: {}, variantsFreshness: {} };
  const productsMap: Record<string, any> = data.products || {};

  for (const product of cachedProducts) {
    productsMap[product.productId] = { ...productsMap[product.productId], ...product };
  }

  set('products:cached', { ...data, products: productsMap });
  set('products:search:all', { products: productsMap }, 5 * 60 * 1000);
}

function updateProductCacheWithVariants(productId: string, variants: any[]): void {
  const data: any = get<any>('products:cached') || { products: {}, variantsFreshness: {} };
  const productsMap: Record<string, any> = data.products || {};

  productsMap[productId] = { ...(productsMap[productId] || { productId }), variants };

  set('products:cached', {
    ...data,
    products: productsMap,
    variantsFreshness: {
      ...(data.variantsFreshness || {}),
      [productId]: Date.now(),
    },
  });
}

function isVariantDataFresh(productId: string, ttlMs = 30_000): boolean {
  const data: any = get<any>('products:cached');
  const timestamp = data?.variantsFreshness?.[productId];
  return typeof timestamp === 'number' && Date.now() - timestamp < ttlMs;
}

function recordNetworkFailure(_err?: unknown): void {
  set('products:lastNetworkFailure', { t: Date.now() }, FAILURE_TTL);
}

function shouldUseStaleCache(): boolean {
  const record: any = get<any>('products:lastNetworkFailure');
  return !!record && typeof record.t === 'number' && Date.now() - record.t < FAILURE_TTL;
}

function isNetworkFailure(err: any): boolean {
  const msg = (err && (err.message || err.toString?.())) || '';
  return /Network|fetch|Failed|ECONN|timeout/i.test(String(msg));
}

function detectCorruption(err: any): boolean {
  const msg = (err && (err.message || err.toString?.())) || '';
  return /corrupt|syntax/i.test(String(msg));
}

function recordCorruption(err: any): void {
  const previous = get<any[]>('products:lastCorruption') || [];
  set('products:lastCorruption', [...previous, { t: Date.now(), err: String(err) }], CORRUPTION_TTL);
}

export const productCache = { get, set, clear };

export const ProductCacheService = {
  getCachedProducts,
  saveProductsToCache,
  updateProductCacheWithVariants,
  isVariantDataFresh,
  recordNetworkFailure,
  shouldUseStaleCache,
  isNetworkFailure,
  detectCorruption,
  recordCorruption,
};

export default ProductCacheService;
