/**
 * Validation Result Caching System
 * 
 * Provides caching for validation results to improve performance
 * while maintaining validation integrity and safety.
 */

import { ValidationResult } from './validation';

interface CacheEntry {
  result: ValidationResult;
  timestamp: number;
}

interface CacheOptions {
  ttl?: number; // Time to live in milliseconds
  maxSize?: number; // Maximum cache entries
}

class ValidationCache {
  private cache = new Map<string, CacheEntry>();
  private readonly ttl: number;
  private readonly maxSize: number;

  constructor(options: CacheOptions = {}) {
    this.ttl = options.ttl || 5000; // 5 seconds default
    this.maxSize = options.maxSize || 100; // 100 entries max
  }

  /**
   * Get cached validation result if available and fresh
   */
  get(key: string): ValidationResult | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return null;
    }

    // Check if entry is still fresh
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.result;
  }

  /**
   * Store validation result in cache
   */
  set(key: string, result: ValidationResult): void {
    // Implement LRU by removing oldest entry if at max size
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      result,
      timestamp: Date.now()
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
      if (now - entry.timestamp > this.ttl) {
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
      maxSize: this.maxSize,
      ttl: this.ttl,
      entries: Array.from(this.cache.keys())
    };
  }
}

// Global cache instance
const validationCache = new ValidationCache();

/**
 * Generic cached validation wrapper
 */
export function withCache<T extends any[]>(
  validationFn: (...args: T) => ValidationResult,
  cacheKeyFn: (...args: T) => string
) {
  return (...args: T): ValidationResult => {
    try {
      const cacheKey = cacheKeyFn(...args);
      
      // Try to get from cache first
      const cached = validationCache.get(cacheKey);
      if (cached) {
        // console.log('[ValidationCache] Cache hit for:', cacheKey);
        // Record cache hit for monitoring (if debug module is loaded)
        if (typeof window !== 'undefined' && (window as any).recordCacheHit) {
          (window as any).recordCacheHit();
        }
        return cached;
      }

      // Record cache miss for monitoring (if debug module is loaded)
      if (typeof window !== 'undefined' && (window as any).recordCacheMiss) {
        (window as any).recordCacheMiss();
      }

      // Run actual validation
      const result = validationFn(...args);
      
      // Cache the result
      validationCache.set(cacheKey, result);
      // console.log('[ValidationCache] Cached result for:', cacheKey);
      
      return result;
    } catch (error) {
      // If caching fails, fall back to direct validation
      console.warn('[ValidationCache] Cache error, falling back to direct validation:', error);
      return validationFn(...args);
    }
  };
}

/**
 * Clear validation cache for specific field or all
 */
export function clearValidationCache(keyOrPattern?: string): void {
  validationCache.clear(keyOrPattern);
}

/**
 * Get validation cache statistics
 */
export function getValidationCacheStats() {
  return validationCache.getStats();
}

/**
 * Cleanup expired cache entries
 */
export function cleanupValidationCache(): void {
  validationCache.cleanup();
}

// Auto cleanup only when explicitly enabled to prevent performance overhead
let cleanupInterval: NodeJS.Timeout | null = null;

export function enableAutoCleanup(): void {
  if (typeof window !== 'undefined' && !cleanupInterval) {
    cleanupInterval = setInterval(cleanupValidationCache, 30000);
  }
}

export function disableAutoCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
