import type {
 BreadcrumbItem,
 BreadcrumbSchema,
 JsonLdSchema,
 ProductSchema,
} from '~/types/seo.types';
import { identityFromStaticTheme } from '~/theme/theme.config';
import type { SrStoreIdentity } from '~/utils/sellright';
import { stripHtml } from '~/utils/sanitize';
import { formatMinorUnitsAsDecimalString } from '~/utils/currency';

/**
 * WS-C: every schema generator below takes an optional `identity` — the
 * runtime store identity resolved per-request by the root layout's
 * useStoreIdentityLoader (see routes/*'s `head` functions, which read it via
 * `resolveValue(useStoreIdentityLoader)` and pass it through). Omitting it
 * falls back to the build-time static theme — kept for callers that haven't
 * been threaded through yet and for tests; never used to override a real,
 * resolved identity.
 */

export const generateBreadcrumbSchema = (breadcrumbs: BreadcrumbItem[]): BreadcrumbSchema => {
 return {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: breadcrumbs.map((crumb, index) => ({
   '@type': 'ListItem',
   position: index + 1,
   name: crumb.name,
   item: crumb.url,
  })),
 };
};

export const generateProductSchema = (product: any, identity: SrStoreIdentity = identityFromStaticTheme()): ProductSchema | null => {
 if (!product) {
  console.warn('Product data is required for schema generation');
  return null;
 }

 const primaryVariant = product.variants?.[0];
 if (!primaryVariant) {
  console.warn('Product must have at least one variant, skipping schema generation for:', product.name);
  return null;
 }

 // stripHtml (DOMPurify, real HTML parser) instead of a hand-rolled tag-strip
 // regex — a single-pass `/<[^>]*>/g` replace can leave a reconstructed
 // `<script` behind for crafted input like `<scr<script>ipt>` (CodeQL
 // js/incomplete-multi-character-sanitization).
 const cleanDescription = product.description
  ? stripHtml(product.description).trim()
  : `${product.name} - Premium quality product from ${identity.storeName}`;

 const hasStock = product.variants.some((variant: any) =>
  variant.stockLevel !== 'OUT_OF_STOCK'
 );

 const SITE = identity.siteOrigin;
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
   name: identity.storeName,
  },
  offers: {
   '@type': 'Offer',
   url: productUrl,
   price: formatMinorUnitsAsDecimalString(primaryVariant.priceWithTax, primaryVariant.currencyCode || identity.currency),
   priceCurrency: primaryVariant.currencyCode || identity.currency,
   priceValidUntil: validUntil,
   availability: hasStock
    ? 'https://schema.org/InStock'
    : 'https://schema.org/OutOfStock',
   seller: {
    '@type': 'Organization',
    name: identity.storeName,
   },
   shippingDetails: [{
    '@type': 'OfferShippingDetails',
    shippingRate: {
     '@type': 'MonetaryAmount',
     value: '8.00',
     currency: identity.currency,
    },
    shippingDestination: {
     '@type': 'DefinedRegion',
     addressCountry: 'US',
    },
    deliveryTime: {
     '@type': 'ShippingDeliveryTime',
     handlingTime: {
      '@type': 'QuantitativeValue',
      minValue: 1,
      maxValue: 3,
      unitCode: 'DAY',
     },
     transitTime: {
      '@type': 'QuantitativeValue',
      minValue: 3,
      maxValue: 7,
      unitCode: 'DAY',
     },
    },
   }],
   hasMerchantReturnPolicy: {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: 'US',
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: 7,
    returnMethod: 'https://schema.org/ReturnByMail',
    returnFees: 'https://schema.org/ReturnShippingFees',
   },
  },
  ...(productImages.length > 0 && {
   image: productImages,
  }),
 };
};

export const generateOrganizationSchema = (identity: SrStoreIdentity = identityFromStaticTheme()): JsonLdSchema => {
 const social = Object.values(identity.social).filter((v): v is string => typeof v === 'string' && v.length > 0);
 return {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${identity.siteOrigin}/#organization`,
  name: identity.storeName,
  url: identity.siteOrigin,
  logo: `${identity.siteOrigin}${identity.logoImageUrl ?? '/logo.png'}`,
  image: `${identity.siteOrigin}${identity.ogImageUrl}`,
  description: identity.tagline,
  contactPoint: {
   '@type': 'ContactPoint',
   email: identity.supportEmail,
   contactType: 'customer service',
  },
  ...(identity.address ? { address: { '@type': 'PostalAddress', ...identity.address } } : {}),
  ...(social.length > 0 ? { sameAs: social } : {}),
 };
};

export const generateWebsiteSchema = (identity: SrStoreIdentity = identityFromStaticTheme()): JsonLdSchema => {
 return {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: identity.storeName,
  url: identity.siteOrigin,
  potentialAction: {
   '@type': 'SearchAction',
   target: `${identity.siteOrigin}/shop?q={search_term_string}`,
   'query-input': 'required name=search_term_string',
  },
 };
};
