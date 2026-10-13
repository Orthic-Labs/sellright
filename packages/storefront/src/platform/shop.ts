// A13: shop platform code moved verbatim from src/routes/shop/index.tsx (catalog loader) and src/routes/shop/seo.ts
// (head, onStaticGenerate). The shop route re-exports all three.
import { routeLoader$, type StaticGenerateHandler } from '@qwik.dev/router';
import { loadBrowseCatalog } from '~/services/browse-catalog';
import { generateBreadcrumbSchema } from '~/services/seo-schemas';
import { createSEOHead } from '~/utils/seo';
import { siteUrl } from '~/theme/theme.config';
import { hasView } from '~/platform/gateway';

// ── Catalog manifest loader (SSR) ──────────────────────────────
// Reads the pre-generated shop-catalog.json at SSR time, normalized to the
// native CatalogListItem shape regardless of source (manifest or live-API
// fallback — see services/browse-catalog.ts). SellRight's opt-in publisher
// refreshes every minute. Stale/foreign snapshots fall back to the live API;
// stock is rechecked before checkout.
// Products are in the HTML on first byte — no client-side API call needed.
export const useCatalogLoader = routeLoader$(async ({ error }) => {
 // Brand views PR2: a branded shop reads its listing through useConfiguratorDetail (one generation with the detail products).
 if (hasView('route.shop')) return { totalItems: 0, products: [], fallback: false };
 try {
  const parsed = await loadBrowseCatalog();
  return { ...parsed, fallback: false };
 } catch {
  throw error(503, 'Catalog temporarily unavailable');
 }
});

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
