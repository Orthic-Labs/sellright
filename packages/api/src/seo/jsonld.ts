/**
 * SEO-1: JSON-LD builders. Pure functions — no DB, no fetch. Product offers
 * take price/availability as plain inputs so the route handler is the only
 * place that ever queries stock (queries.ts::productAvailability), keeping
 * "never cache stock" enforceable at a single call site.
 */
import type { SeoConfig } from './config.js';
import type { ProductAvailability } from './queries.js';

/** cents -> a schema.org Offer price string. Assumes a 2-decimal currency
 *  (USD/EUR/GBP etc — the only currencies this codebase's currency_rate
 *  table and money/currency.ts already support). */
function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function organizationSchema(config: SeoConfig): Record<string, unknown> | null {
  if (!config.siteUrl) return null;
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: config.organization.name,
    url: config.siteUrl,
  };
  if (config.organization.logo) schema.logo = config.organization.logo;
  if (config.organization.sameAs.length > 0) schema.sameAs = config.organization.sameAs;
  if (config.contactEmail) schema.email = config.contactEmail;
  return schema;
}

export function websiteSchema(config: SeoConfig): Record<string, unknown> | null {
  if (!config.siteUrl) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: config.organization.name,
    url: config.siteUrl,
  };
}

export function productSchema(config: SeoConfig, product: ProductAvailability): Record<string, unknown> | null {
  if (!config.siteUrl) return null;
  const url = `${config.siteUrl}/products/${encodeURIComponent(product.slug)}/`;
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    url,
  };
  if (product.description) schema.description = product.description;
  if (product.images.length > 0) schema.image = product.images;
  if (product.sku) schema.sku = product.sku;
  if (product.price != null) {
    schema.offers = {
      '@type': 'Offer',
      url,
      priceCurrency: product.currency,
      price: centsToDecimal(product.price),
      availability: product.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    };
  }
  return schema;
}
