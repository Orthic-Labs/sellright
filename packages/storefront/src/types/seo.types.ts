// JSON-LD schema.org types used by `~/services/seo-schemas.ts` (generators)
// and every route that injects structured data via `~/utils/schema-injection`.
//
// Trimmed 2026 (SellRight content/SEO migration): removed `ProductSeoData`,
// `CollectionSeoData`, `SeoMetadata`, `LocalBusinessSchema` (this isn't a
// local business — see `~/services/seo-schemas.ts`), `SeoApiResponse`,
// `SeoApiCacheConfig`, `SeoApiEndpoints` — all dead, only ever referenced by
// the removed `seo-api.service.ts` fetch/cache layer that called stale
// pre-`/v1` legacy-plugin-era paths and had zero real callers.

export interface JsonLdSchema {
  '@context': string;
  '@type': string;
  [key: string]: any;
}

export interface BreadcrumbItem {
  name: string;
  url: string;
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
