import { server$ } from '@qwik.dev/router';
import { DEV_API } from '~/constants';
import type {
  SeoApiResponse,
  SeoApiCacheConfig,
  ProductSchema,
  OrganizationSchema,
  WebsiteSchema
} from '~/types/seo.types';
export {
  generateBreadcrumbSchema,
  generateOrganizationSchema,
  generateProductSchema,
  generateWebsiteSchema,
} from './seo-schemas';

// Cache configuration
const CACHE_CONFIG: SeoApiCacheConfig = {
  ttl: 300, // 5 minutes
  maxSize: 100,
  enabled: true
};

// Simple in-memory cache for SEO data
class SeoCache {
  private cache = new Map<string, { data: any; timestamp: number }>();
  private config: SeoApiCacheConfig;

  constructor(config: SeoApiCacheConfig) {
    this.config = config;
  }

  get<T>(key: string): T | null {
    if (!this.config.enabled) return null;

    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    const isExpired = (now - entry.timestamp) > (this.config.ttl * 1000);

    if (isExpired) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  set<T>(key: string, data: T): void {
    if (!this.config.enabled) return;

    // Implement LRU eviction if cache is full
    if (this.cache.size >= this.config.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

// Global cache instance
const seoCache = new SeoCache(CACHE_CONFIG);

// Base API URL — always use localhost when running server-side (inside server$())
// PROD_API (public domain) must not be used from server context: it hits Cloudflare and returns 400
const INTERNAL_API = 'http://localhost:3100';
const baseUrl = import.meta.env.DEV ? DEV_API : INTERNAL_API;

/**
 * Generic API request function with caching and error handling
 */
const makeApiRequest = async <T>(
  endpoint: string,
  cacheKey?: string
): Promise<SeoApiResponse<T>> => {
  try {
    // Check cache first
    if (cacheKey) {
      const cached = seoCache.get<T>(cacheKey);
      if (cached) {
        return {
          success: true,
          data: cached,
          cached: true,
          timestamp: Date.now()
        };
      }
    }

    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    // Cache successful responses
    if (cacheKey && data) {
      seoCache.set(cacheKey, data);
    }

    return {
      success: true,
      data,
      cached: false,
      timestamp: Date.now()
    };

  } catch (error) {
    console.warn('SEO API request failed for endpoint:', endpoint, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: Date.now()
    };
  }
};

/**
 * Fetch product schema from backend
 */
export const fetchProductSchema = server$(async (productId: string): Promise<ProductSchema | null> => {
  const response = await makeApiRequest<ProductSchema>(
    `/seo/schema/product/${productId}`,
    `product-schema-${productId}`
  );

  return response.success ? response.data || null : null;
});
/**
 * Fetch organization schema from backend
 */
export const fetchOrganizationSchema = server$(async (): Promise<OrganizationSchema | null> => {
  const response = await makeApiRequest<OrganizationSchema>(
    '/seo/schema/organization',
    'organization-schema'
  );

  return response.success ? response.data || null : null;
});
/**
 * Fetch website schema from backend
 */
export const fetchWebsiteSchema = server$(async (): Promise<WebsiteSchema | null> => {
  const response = await makeApiRequest<WebsiteSchema>(
    '/seo/schema/website',
    'website-schema'
  );

  return response.success ? response.data || null : null;
});
/**
 * Fetch sitemap XML from backend
 */
export const fetchSitemap = server$(async (type: 'main' | 'products' | 'collections' | 'index' = 'main'): Promise<string | null> => {
  const endpoint = type === 'index' ? '/seo/sitemap.xml' : type === 'main' ? '/seo/sitemap-main.xml' : `/seo/sitemap-${type}.xml`;

  try {
    // Check cache first
    const cacheKey = `sitemap-${type}`;
    const cached = seoCache.get<string>(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/xml, text/xml',
        'Cache-Control': 'no-cache'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const xmlData = await response.text();

    // Cache successful responses
    if (xmlData) {
      seoCache.set(cacheKey, xmlData);
    }

    return xmlData;
  } catch (error) {
    console.warn('Failed to fetch sitemap:', type, error);
    return null;
  }
});

/**
 * Fetch robots.txt from backend
 */
export const fetchRobotsTxt = server$(async (): Promise<string | null> => {
  try {
    // Check cache first
    const cacheKey = 'robots-txt';
    const cached = seoCache.get<string>(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await fetch(`${baseUrl}/seo/robots.txt`, {
      method: 'GET',
      headers: {
        'Accept': 'text/plain',
        'Cache-Control': 'no-cache'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const textData = await response.text();

    // Cache successful responses
    if (textData) {
      seoCache.set(cacheKey, textData);
    }

    return textData;
  } catch (error) {
    console.warn('Failed to fetch robots.txt:', error);
    return null;
  }
});
