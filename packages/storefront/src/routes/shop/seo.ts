import type { StaticGenerateHandler } from '@qwik.dev/router';
import { generateBreadcrumbSchema } from '~/services/seo-api.service';
import { createSEOHead } from '~/utils/seo';
import { siteUrl } from '~/theme/theme.config';

export const head = ({ url }: { url: URL }) => {
 const searchTerm = url.searchParams.get('q') || '';

 const breadcrumbSchema = generateBreadcrumbSchema([
  { name: 'Home', url: `${siteUrl}/` },
  { name: searchTerm ? `Search: ${searchTerm}` : 'Shop', url: `${siteUrl}/shop` },
 ]);

 return createSEOHead({
  title: searchTerm ? `Search results for "${searchTerm}"` : 'Shop All Products',
  description: searchTerm
   ? `Find products matching "${searchTerm}" in our collection.`
   : 'Browse our complete product collection.',
  canonical: `${siteUrl}/shop/`,
  ogUrl: `${siteUrl}/shop/`,
  noindex: !!searchTerm,
  schemas: [
   breadcrumbSchema,
   ...(!searchTerm ? [{
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Shop All Products',
    url: `${siteUrl}/shop`,
    description: 'Browse our complete product collection.',
   }] : []),
  ],
 });
};

export const onStaticGenerate: StaticGenerateHandler = () => {
 return { params: [] };
};
