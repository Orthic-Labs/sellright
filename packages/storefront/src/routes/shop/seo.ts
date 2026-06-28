import type { StaticGenerateHandler } from '@qwik.dev/router';
import { generateBreadcrumbSchema } from '~/services/seo-api.service';
import { createSEOHead } from '~/utils/seo';

export const head = ({ url }: { url: URL }) => {
 const searchTerm = url.searchParams.get('q') || '';

 const breadcrumbSchema = generateBreadcrumbSchema([
  { name: 'Home', url: 'https://www.damneddesigns.com/' },
  { name: searchTerm ? `Search: ${searchTerm}` : 'Shop', url: 'https://www.damneddesigns.com/shop' },
 ]);

 return createSEOHead({
  title: searchTerm ? `Search results for "${searchTerm}"` : 'Shop All Premium Knives & Tools',
  description: searchTerm
   ? `Find products matching "${searchTerm}" in our premium collection of handcrafted knives and tools.`
   : 'Browse our complete collection of premium handcrafted knives and everyday carry tools. Find the perfect blade for collectors and professionals.',
  canonical: 'https://www.damneddesigns.com/shop/',
  ogUrl: 'https://www.damneddesigns.com/shop/',
  noindex: !!searchTerm,
  schemas: [
   breadcrumbSchema,
   ...(!searchTerm ? [{
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Shop All Premium Knives & Tools',
    url: 'https://www.damneddesigns.com/shop',
    description: 'Browse our complete collection of premium handcrafted knives and everyday carry tools.',
   }] : []),
  ],
 });
};

export const onStaticGenerate: StaticGenerateHandler = () => {
 return { params: [] };
};
