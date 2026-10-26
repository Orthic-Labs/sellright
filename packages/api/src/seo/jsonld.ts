/**
 * SEO-1: JSON-LD builders. Pure functions — no DB, no fetch. Product offers
 * take price/availability as plain inputs so the route handler is the only
 * place that ever queries stock (queries.ts::productAvailability), keeping
 * "never cache stock" enforceable at a single call site.
 *
 * Shapes follow the previous the previous platform store's seo-api.service.ts
 * (generateProductSchema / generateOrganizationSchema / generateWebsiteSchema).
 * Every store-specific value (brand, seller, shipping, returns, address,
 * description, search path) comes from the store's SEO config and is omitted
 * when the store has not configured it — nothing here is brand-specific.
 */
import { productPath, type SeoConfig } from './config.js';
import type { ProductAvailability } from './queries.js';
import { htmlToPlainText, specsToMaterial, specsToSchemaProperties } from './specs.js';

const SCHEMA = 'https://schema.org';
const DAY_MS = 24 * 60 * 60 * 1000;

/** cents -> a schema.org Offer price string. Assumes a 2-decimal currency
 *  (USD/EUR/GBP etc — the only currencies this codebase's currency_rate
 *  table and money/currency.ts already support). */
function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** An image as an absolute URL: asset keys are served from the storefront's /assets mount, and a bare key would be resolved
 *  by crawlers against the product page (#366). Images on the storefront's /assets mount carry the `xl` preset, as the previous store did. */
function absoluteImage(siteUrl: string, ref: string): string {
  const url = /^https?:\/\//.test(ref) ? ref : ref.startsWith('/') ? `${siteUrl}${ref}` : `${siteUrl}/assets/${ref}`;
  return url.includes('/assets/') && !url.includes('?') ? `${url}?preset=xl` : url;
}

/** The Organization node's @id (articles and other nodes on the site point at it). */
export const organizationId = (siteUrl: string): string => `${siteUrl}/#organization`;

export function organizationSchema(config: SeoConfig): Record<string, unknown> | null {
  const siteUrl = config.siteUrl;
  if (!siteUrl) return null;
  const org = config.organization;
  const schema: Record<string, unknown> = {
    '@context': SCHEMA,
    '@type': 'Organization',
    '@id': organizationId(siteUrl),
    name: org.name,
    url: siteUrl,
  };
  if (org.logo) schema.logo = org.logo;
  if (org.image) schema.image = org.image;
  if (org.description) schema.description = org.description;
  if (org.founder) schema.founder = { '@type': 'Person', ...(org.founder.id ? { '@id': org.founder.id } : {}), name: org.founder.name };
  if (config.contactEmail || org.telephone) {
    schema.contactPoint = {
      '@type': 'ContactPoint',
      ...(org.telephone ? { telephone: org.telephone } : {}),
      ...(config.contactEmail ? { email: config.contactEmail } : {}),
      contactType: 'customer service',
    };
  }
  if (org.address) schema.address = { '@type': 'PostalAddress', ...org.address };
  if (org.sameAs.length > 0) schema.sameAs = org.sameAs;
  return schema;
}

export function websiteSchema(config: SeoConfig): Record<string, unknown> | null {
  const siteUrl = config.siteUrl;
  if (!siteUrl) return null;
  const schema: Record<string, unknown> = {
    '@context': SCHEMA,
    '@type': 'WebSite',
    name: config.organization.name,
    url: siteUrl,
  };
  if (config.searchPath) {
    schema.potentialAction = {
      '@type': 'SearchAction',
      target: `${siteUrl}${config.searchPath}?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    };
  }
  return schema;
}

const quantity = (r: { min: number; max: number }) => ({ '@type': 'QuantitativeValue', minValue: r.min, maxValue: r.max, unitCode: 'DAY' });

function shippingDetails(config: SeoConfig, currency: string): Record<string, unknown>[] | null {
  const ship = config.shipping;
  if (!ship) return null;
  const deliveryTime = ship.handling || ship.transit
    ? {
        '@type': 'ShippingDeliveryTime',
        ...(ship.handling ? { handlingTime: quantity(ship.handling) } : {}),
        ...(ship.transit ? { transitTime: quantity(ship.transit) } : {}),
      }
    : null;
  return [{
    '@type': 'OfferShippingDetails',
    shippingRate: { '@type': 'MonetaryAmount', value: ship.rate, currency },
    shippingDestination: { '@type': 'DefinedRegion', addressCountry: ship.country },
    ...(deliveryTime ? { deliveryTime } : {}),
  }];
}

function returnPolicy(config: SeoConfig): Record<string, unknown> | null {
  const ret = config.returns;
  if (!ret) return null;
  return {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: ret.country,
    returnPolicyCategory: `${SCHEMA}/MerchantReturnFiniteReturnWindow`,
    merchantReturnDays: ret.days,
    returnMethod: `${SCHEMA}/ReturnByMail`,
    returnFees: ret.fees === 'free' ? `${SCHEMA}/FreeReturn` : `${SCHEMA}/ReturnShippingFees`,
  };
}

/** In stock with a pre-order variant is PreOrder (the previous platform's store's rule: an in-stock product with any pre-order variant is reported PreOrder). */
function availabilityUrl(product: ProductAvailability): string {
  if (!product.inStock) return `${SCHEMA}/OutOfStock`;
  return product.preOrder ? `${SCHEMA}/PreOrder` : `${SCHEMA}/InStock`;
}

export function productSchema(config: SeoConfig, product: ProductAvailability, now: Date = new Date()): Record<string, unknown> | null {
  const siteUrl = config.siteUrl;
  if (!siteUrl) return null;
  const url = `${siteUrl}${productPath(config, product.slug)}`;
  const storeName = config.organization.name;
  const schema: Record<string, unknown> = {
    '@context': SCHEMA,
    '@type': 'Product',
    name: product.name,
    url,
  };
  const description = product.description ? htmlToPlainText(product.description) : '';
  if (description) schema.description = description;
  if (product.images.length > 0) schema.image = product.images.map((key) => absoluteImage(siteUrl, key));
  if (product.sku) schema.sku = product.sku;
  schema.brand = { '@type': 'Brand', name: storeName };
  schema.itemCondition = `${SCHEMA}/NewCondition`;
  if (product.price != null) {
    const shipping = shippingDetails(config, product.currency);
    const returns = returnPolicy(config);
    schema.offers = {
      '@type': 'Offer',
      url,
      priceCurrency: product.currency,
      price: centsToDecimal(product.price),
      priceValidUntil: new Date(now.getTime() + 365 * DAY_MS).toISOString().split('T')[0],
      availability: availabilityUrl(product),
      itemCondition: `${SCHEMA}/NewCondition`,
      seller: { '@type': 'Organization', name: storeName },
      ...(shipping ? { shippingDetails: shipping } : {}),
      ...(returns ? { hasMerchantReturnPolicy: returns } : {}),
    };
  }
  // Machine-readable specs parsed from the description's SPECS block (empty for products without one).
  const material = specsToMaterial(product.description);
  if (material) schema.material = material;
  const properties = specsToSchemaProperties(product.description);
  if (properties.length > 0) schema.additionalProperty = properties;
  return schema;
}
