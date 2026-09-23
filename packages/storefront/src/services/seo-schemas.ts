import type {
 BreadcrumbItem,
 BreadcrumbSchema,
 JsonLdSchema,
 ProductSchema,
} from '~/types/seo.types';
import { theme, siteUrl, socialLinks } from '~/theme/theme.config';

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

export const generateProductSchema = (product: any): ProductSchema | null => {
 if (!product) {
  console.warn('Product data is required for schema generation');
  return null;
 }

 const primaryVariant = product.variants?.[0];
 if (!primaryVariant) {
  console.warn('Product must have at least one variant, skipping schema generation for:', product.name);
  return null;
 }

 const cleanDescription = product.description
  ? product.description.replace(/<[^>]*>/g, '').trim()
  : `${product.name} - Premium quality product from ${theme.storeName}`;

 const hasStock = product.variants.some((variant: any) =>
  variant.stockLevel !== 'OUT_OF_STOCK'
 );

 const SITE = siteUrl;
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
   name: theme.storeName,
  },
  offers: {
   '@type': 'Offer',
   url: productUrl,
   price: (primaryVariant.priceWithTax / 100).toFixed(2),
   priceCurrency: primaryVariant.currencyCode || theme.currency,
   priceValidUntil: validUntil,
   availability: hasStock
    ? 'https://schema.org/InStock'
    : 'https://schema.org/OutOfStock',
   seller: {
    '@type': 'Organization',
    name: theme.storeName,
   },
   shippingDetails: [{
    '@type': 'OfferShippingDetails',
    shippingRate: {
     '@type': 'MonetaryAmount',
     value: '8.00',
     currency: theme.currency,
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

export const generateOrganizationSchema = (): JsonLdSchema => {
 return {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${siteUrl}/#organization`,
  name: theme.storeName,
  url: siteUrl,
  logo: `${siteUrl}${theme.logoImageUrl ?? '/logo.png'}`,
  image: `${siteUrl}${theme.ogImageUrl}`,
  description: theme.tagline,
  contactPoint: {
   '@type': 'ContactPoint',
   email: theme.supportEmail,
   contactType: 'customer service',
  },
  ...(theme.address ? { address: { '@type': 'PostalAddress', ...theme.address } } : {}),
  ...(socialLinks.length > 0 ? { sameAs: socialLinks } : {}),
 };
};

export const generateWebsiteSchema = (): JsonLdSchema => {
 return {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: theme.storeName,
  url: siteUrl,
  potentialAction: {
   '@type': 'SearchAction',
   target: `${siteUrl}/shop?q={search_term_string}`,
   'query-input': 'required name=search_term_string',
  },
 };
};
