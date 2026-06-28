import type {
 BreadcrumbItem,
 BreadcrumbSchema,
 JsonLdSchema,
 ProductSchema,
} from '~/types/seo.types';

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
  : `${product.name} - Premium quality product from Damned Designs`;

 const hasStock = product.variants.some((variant: any) =>
  variant.stockLevel !== 'OUT_OF_STOCK'
 );

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
   name: 'Damned Designs',
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
    name: 'Damned Designs',
   },
   shippingDetails: [{
    '@type': 'OfferShippingDetails',
    shippingRate: {
     '@type': 'MonetaryAmount',
     value: '8.00',
     currency: 'USD',
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
  '@id': 'https://www.damneddesigns.com/#organization',
  name: 'Damned Designs',
  url: 'https://www.damneddesigns.com',
  logo: 'https://www.damneddesigns.com/logo.png',
  image: 'https://www.damneddesigns.com/og-image.jpg',
  description: 'Damned Designs makes premium EDC knives, blades, and accessories for collectors and everyday carry enthusiasts. Designed with precision, built to last.',
  contactPoint: {
   '@type': 'ContactPoint',
   email: 'info@damneddesigns.com',
   contactType: 'customer service',
  },
  address: {
   '@type': 'PostalAddress',
   streetAddress: '169 Madison Ave STE 15182',
   addressLocality: 'New York',
   addressRegion: 'NY',
   postalCode: '10016',
   addressCountry: 'US',
  },
  sameAs: [
   'https://www.instagram.com/damneddesigns/',
   'https://www.facebook.com/damneddesigns/',
   'https://www.facebook.com/groups/damnededc/',
  ],
 };
};

export const generateWebsiteSchema = (): JsonLdSchema => {
 return {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'Damned Designs',
  url: 'https://www.damneddesigns.com',
  potentialAction: {
   '@type': 'SearchAction',
   target: 'https://www.damneddesigns.com/shop?q={search_term_string}',
   'query-input': 'required name=search_term_string',
  },
 };
};
