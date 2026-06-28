import { server$ } from '@qwik.dev/router';
import { DEV_API } from '~/constants';
import type {
  SeoApiResponse,
  BreadcrumbItem,
  SeoApiCacheConfig,
  ProductSchema,
  OrganizationSchema,
  WebsiteSchema,
  BreadcrumbSchema,
  JsonLdSchema
} from '~/types/seo.types';

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
 * Generate breadcrumb schema from breadcrumb items
 */
export const generateBreadcrumbSchema = (breadcrumbs: BreadcrumbItem[]): BreadcrumbSchema => {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: crumb.url
    }))
  };
};

/**
 * Generate product schema from product data (client-side)
 * This is used in head functions which must be synchronous
 */
export const generateProductSchema = (product: any): ProductSchema | null => {
  if (!product) {
    console.warn('Product data is required for schema generation');
    return null;
  }

  // Get the first variant for pricing (most products have single variants)
  const primaryVariant = product.variants?.[0];
  if (!primaryVariant) {
    console.warn('Product must have at least one variant, skipping schema generation for:', product.name);
    return null;
  }

  // Clean description by removing HTML tags
  const cleanDescription = product.description
    ? product.description.replace(/<[^>]*>/g, '').trim()
    : `${product.name} - Premium quality product from Damned Designs`;

  // Determine availability based on stock levels
  const hasStock = product.variants.some((variant: any) =>
    variant.stockLevel !== 'OUT_OF_STOCK'
  );

  // Get all product images (must be absolute URLs for Google rich results)
  const SITE = 'https://www.damneddesigns.com';
  const absUrl = (path: string) => path.startsWith('http') ? path : `${SITE}${path}`;
  const productImages: string[] = [];
  if (product.featuredAsset?.preview) {
    productImages.push(absUrl(product.featuredAsset.preview) + '?preset=xl');
  }
  if (product.assets?.length > 0) {
    product.assets.forEach((asset: any) => {
      if (asset.preview && asset.preview !== product.featuredAsset?.preview) {
        productImages.push(absUrl(asset.preview) + '?preset=xl');
      }
    });
  }

  const productUrl = `${SITE}/products/${product.slug}`;
  const validUntil = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    url: productUrl,
    description: cleanDescription,
    sku: primaryVariant.sku || product.id,
    brand: {
      '@type': 'Brand',
      name: 'Damned Designs'
    },
    offers: {
      '@type': 'Offer',
      url: productUrl,
      price: (primaryVariant.priceWithTax / 100).toFixed(2),
      priceCurrency: primaryVariant.currencyCode || 'USD',
      priceValidUntil: validUntil,
      availability: hasStock
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      seller: {
        '@type': 'Organization',
        name: 'Damned Designs'
      },
      shippingDetails: [{
        '@type': 'OfferShippingDetails',
        shippingRate: {
          '@type': 'MonetaryAmount',
          value: '8.00',
          currency: 'USD'
        },
        shippingDestination: {
          '@type': 'DefinedRegion',
          addressCountry: 'US'
        },
        deliveryTime: {
          '@type': 'ShippingDeliveryTime',
          handlingTime: {
            '@type': 'QuantitativeValue',
            minValue: 1,
            maxValue: 3,
            unitCode: 'DAY'
          },
          transitTime: {
            '@type': 'QuantitativeValue',
            minValue: 3,
            maxValue: 7,
            unitCode: 'DAY'
          }
        }
      }],
      hasMerchantReturnPolicy: {
        '@type': 'MerchantReturnPolicy',
        applicableCountry: 'US',
        returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
        merchantReturnDays: 7,
        returnMethod: 'https://schema.org/ReturnByMail',
        returnFees: 'https://schema.org/ReturnShippingFees'
      }
    },
    ...(productImages.length > 0 && {
      image: productImages
    })
  };
};

/**
 * Generate organization schema for homepage (client-side)
 */
export const generateOrganizationSchema = (): JsonLdSchema => {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': 'https://www.damneddesigns.com/#organization',
    name: 'Damned Designs',
    url: 'https://www.damneddesigns.com',
    logo: 'https://www.damneddesigns.com/logo.png',
    image: 'https://www.damneddesigns.com/og-image.jpg',
    description: 'Damned Designs makes premium EDC knives, blades, and accessories for collectors and everyday carry enthusiasts. Designed with precision, built to last.',
    contactPoint: {
      '@type': 'ContactPoint',
      email: 'info@damneddesigns.com',
      contactType: 'customer service'
    },
    address: {
      '@type': 'PostalAddress',
      streetAddress: '169 Madison Ave STE 15182',
      addressLocality: 'New York',
      addressRegion: 'NY',
      postalCode: '10016',
      addressCountry: 'US'
    },
    sameAs: [
      'https://www.instagram.com/damneddesigns/',
      'https://www.facebook.com/damneddesigns/',
      'https://www.facebook.com/groups/damnededc/'
    ]
  };
};

/**
 * Generate website schema for homepage (client-side)
 */
export const generateWebsiteSchema = (): JsonLdSchema => {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Damned Designs',
    url: 'https://www.damneddesigns.com',
    potentialAction: {
      '@type': 'SearchAction',
      target: 'https://www.damneddesigns.com/shop?q={search_term_string}',
      'query-input': 'required name=search_term_string'
    }
  };
};

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
