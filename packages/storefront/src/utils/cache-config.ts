/**
 * Cache Configuration for Enhanced Service Worker
 * Centralized configuration that preserves real-time stock accuracy
 */

export const CACHE_NAMES = {
  static: 'damned-designs-static-v1',
  images: 'damned-designs-images-v1',
  api: 'damned-designs-api-v1',
  pages: 'damned-designs-pages-v1'
};

export const CACHE_DURATIONS = {
  // Static assets - cache for 30 days
  static: 30 * 24 * 60 * 60 * 1000,
  // Images - cache for 7 days  
  images: 7 * 24 * 60 * 60 * 1000,
  // API responses - cache for 5 minutes (non-stock data only)
  api: 5 * 60 * 1000,
  // Pages - cache for 10 minutes
  pages: 10 * 60 * 1000
};

/**
 * Asset patterns for cache-first strategy
 * These assets rarely change and can be cached aggressively
 */
export const CACHE_FIRST_PATTERNS = [
  // Images (all formats including AVIF/WebP)
  /\.(jpg|jpeg|png|gif|webp|avif|svg|ico)$/,
  // Fonts and static assets
  /\.(css|js|woff|woff2|ttf|otf)$/,
  // Vendure asset images (but not API calls)
  /\/assets\/.*\.(jpg|jpeg|png|gif|webp|avif)$/,
  // Static files
  /\/favicon/,
  /\/manifest\.json$/,
  /\/logo-/
];

/**
 * API patterns that should NEVER be cached
 * These contain real-time data like stock levels
 */
export const NEVER_CACHE_PATTERNS = [
  // Stock-related GraphQL queries
  /\/shop-api.*stockLevel/,
  /\/shop-api.*inventory/,
  /\/shop-api.*inStock/,
  // Real-time product data queries
  /\/shop-api.*product.*stockLevel/,
  // Any mutation operations
  /\/shop-api.*mutation/,
  // Admin API (always fresh)
  /\/admin-api/,
  // Cart operations (real-time)
  /\/shop-api.*cart/,
  /\/shop-api.*order/
];

/**
 * API patterns for network-first strategy
 * Check network first, fallback to cache
 */
export const NETWORK_FIRST_PATTERNS = [
  // General shop API (excluding never-cache patterns)
  /\/shop-api/,
  // Any API endpoints
  /\/api\//
];

/**
 * Page patterns for stale-while-revalidate
 * Show cached version immediately, update in background
 */
export const STALE_WHILE_REVALIDATE_PATTERNS = [
  // Shop pages
  /\/shop/,
  // Product pages  
  /\/products/,
  // Collection pages
  /\/collections/,
  // Homepage
  /^\/$|^\/$/
];

/**
 * Check if a request should never be cached
 */
export const shouldNeverCache = (url: string): boolean => {
  return NEVER_CACHE_PATTERNS.some(pattern => pattern.test(url));
};

/**
 * Check if a request matches cache-first pattern
 */
export const isCacheFirstAsset = (url: string): boolean => {
  return CACHE_FIRST_PATTERNS.some(pattern => pattern.test(url));
};

/**
 * Check if a request matches network-first pattern
 */
export const isNetworkFirstAsset = (url: string): boolean => {
  return NETWORK_FIRST_PATTERNS.some(pattern => pattern.test(url)) && !shouldNeverCache(url);
};

/**
 * Check if a request matches stale-while-revalidate pattern
 */
export const isStaleWhileRevalidateAsset = (url: string): boolean => {
  return STALE_WHILE_REVALIDATE_PATTERNS.some(pattern => pattern.test(url));
};
