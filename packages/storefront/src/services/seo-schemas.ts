import type { BreadcrumbItem, BreadcrumbSchema } from '~/types/seo.types';

/**
 * Storefront-side JSON-LD generators. Only the breadcrumb list is built here: it is page structure the storefront knows.
 * Product, Organization and WebSite JSON-LD come from the SellRight API (`jsonLdProduct` / `jsonLdOrganization` in
 * services/sellright-seo.ts -> api/src/seo/jsonld.ts), built from the store's own config, so there is one copy of those shapes.
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
