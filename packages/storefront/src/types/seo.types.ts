// SEO Types for Frontend Integration
// Matches backend SEO plugin response formats

export interface JsonLdSchema {
  '@context': string;
  '@type': string;
  [key: string]: any;
}

export interface ProductSeoData {
  id: string;
  name: string;
  description: string;
  slug: string;
  price: number;
  currencyCode: string;
  image?: string;
  brand?: string;
  sku: string;
  availability: 'InStock' | 'OutOfStock' | 'PreOrder';
  category?: string;
  updatedAt: Date;
}

export interface CollectionSeoData {
  id: string;
  name: string;
  description: string;
  slug: string;
  updatedAt: Date;
}

export interface SeoMetadata {
  title: string;
  description: string;
  keywords?: string[];
  canonical?: string;
  noindex?: boolean;
  ogImage?: string;
}

export interface BreadcrumbItem {
  name: string;
  url: string;
}

export interface SeoApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  cached?: boolean;
  timestamp?: number;
}

// Schema-specific types for different JSON-LD schemas
export interface ProductSchema extends JsonLdSchema {
  '@type': 'Product';
  name: string;
  description: string;
  sku: string;
  brand: {
    '@type': 'Brand';
    name: string;
  };
  url?: string;
  offers: {
    '@type': 'Offer';
    url?: string;
    price: string;
    priceCurrency: string;
    priceValidUntil?: string;
    availability: string;
    seller: {
      '@type': 'Organization';
      name: string;
    };
    shippingDetails?: any[];
    hasMerchantReturnPolicy?: any;
  };
  image?: string | string[];
}

export interface OrganizationSchema extends JsonLdSchema {
  '@type': 'Organization';
  name: string;
  url: string;
  logo?: string;
  contactPoint?: {
    '@type': 'ContactPoint';
    telephone: string;
    contactType: string;
  };
  sameAs?: string[];
}

export interface WebsiteSchema extends JsonLdSchema {
  '@type': 'WebSite';
  name: string;
  url: string;
  potentialAction: {
    '@type': 'SearchAction';
    target: string;
    'query-input': string;
  };
}

export interface BreadcrumbSchema extends JsonLdSchema {
  '@type': 'BreadcrumbList';
  itemListElement: Array<{
    '@type': 'ListItem';
    position: number;
    name: string;
    item: string;
  }>;
}

export interface LocalBusinessSchema extends JsonLdSchema {
  '@type': 'LocalBusiness';
  name: string;
  address: {
    '@type': 'PostalAddress';
    streetAddress: string;
    addressLocality: string;
    addressRegion: string;
    postalCode: string;
    addressCountry: string;
  };
  telephone: string;
  openingHours: string[];
  geo?: {
    '@type': 'GeoCoordinates';
    latitude: number;
    longitude: number;
  };
}

// Cache configuration
export interface SeoApiCacheConfig {
  ttl: number; // Time to live in seconds
  maxSize: number; // Maximum cache entries
  enabled: boolean;
}

// API endpoint configuration
export interface SeoApiEndpoints {
  productSchema: (productId: string) => string;
  organizationSchema: () => string;
  websiteSchema: () => string;
  breadcrumbSchema: (breadcrumbs: BreadcrumbItem[]) => string;
  sitemap: (type: 'main' | 'products' | 'collections') => string;
  robotsTxt: () => string;
}
