// A13: shop platform code moved verbatim from src/routes/shop/index.tsx (catalog loader) and src/routes/shop/seo.ts
// (head, onStaticGenerate). The shop route re-exports all three.
import { routeLoader$, server$, type StaticGenerateHandler } from '@qwik.dev/router';
import { noStore, shellRender } from '~/platform/shell-render';
import { loadBrowseCatalog } from '~/services/browse-catalog';
import { generateBreadcrumbSchema } from '~/services/seo-schemas';
import { createSEOHead } from '~/utils/seo';
import { siteUrl, theme } from '~/theme/theme.config';
import { hasView } from '~/platform/gateway';
import { DETAIL_PRODUCTS } from '~/platform/brand-data';
import { useConfiguratorDetail, type ConfiguratorDetail } from '~/platform/configurator-detail';
import { productGroupSchema } from '~/platform/product-jsonld';
import { redactListItem } from '~/platform/live-values';
import type { CatalogListItem } from '~/sellright/types/catalog';

// ── Catalog manifest loader (SSR) ──────────────────────────────
// Reads the pre-generated shop-catalog.json at SSR time, normalized to the
// native CatalogListItem shape regardless of source (manifest or live-API
// fallback — see services/browse-catalog.ts). SellRight's opt-in publisher
// refreshes every minute. Stale/foreign snapshots fall back to the live API;
// stock is rechecked before checkout.
// Products are in the HTML on first byte — no client-side API call needed.
// ADR-0001 §2 (SHELL_CACHE=1): the listing is stock-bearing (inStock, and the in-stock filter decides which cards exist) and priced,
// so the shell carries only its structure (#412): every product's slug, name, image, tags (shellShopItem: no price, the fail-closed
// stock constant), `deferred`. The grid paints from it in SSR, unfiltered by stock; the browser reads the same manifest snapshot on load
// through `readShopCatalog` (no-store) and the values (price, availability, the in-stock filter) apply only then. LOCKED layer 2 is
// otherwise unchanged (manifest on load, the in-stock toggle is the live API hit).
export const useCatalogLoader = routeLoader$(async ({ error }) => {
 // Brand views PR2: a branded shop reads its listing through useConfiguratorDetail (one generation with the detail products).
 if (hasView('route.shop')) return { totalItems: 0, products: [], fallback: false, deferred: false };
 if (shellRender()) {
  // A failed structure read keeps the previous shell (reserved grid, the browser read fills it): the page still works.
  const parsed = await loadBrowseCatalog().catch(() => null);
  return { totalItems: parsed?.totalItems ?? 0, products: parsed ? parsed.products.map(shellShopItem) : [], fallback: false, deferred: true };
 }
 try {
  const parsed = await loadBrowseCatalog();
  return { ...parsed, fallback: false, deferred: false };
 } catch {
  throw error(503, 'Catalog temporarily unavailable');
 }
});

/** A shop listing item for the shell (#412): structure only, as an explicit projection (no unknown field can carry a value through),
 *  then redacted (no price, the fail-closed stock constant, never shown as Sold Out while pending). */
export const shellShopItem = (p: CatalogListItem): CatalogListItem =>
 redactListItem({ slug: p.slug, name: p.name, status: p.status, tags: p.tags ?? [], image: p.image ?? null, inStock: false, minPrice: null, maxPrice: null, pricingVariant: null });

/** The shop listing's manifest read, moved to the browser (ADR-0001 §2): the same snapshot the SSR loader reads, per request, no-store. */
export const readShopCatalog = server$(async function () {
 noStore(this);
 return loadBrowseCatalog();
});

export const head = ({ url, resolveValue }: { url: URL; resolveValue?: (loader: unknown) => unknown }) => {
 const searchTerm = url.searchParams.get('q') || '';
 // A branded shop (route.shop view): one platform-built ProductGroup per configurator product, from the page's own catalog
 // generation, with the brand's declared facts (no availability: platform/product-jsonld.ts).
 const configurator = hasView('route.shop') && resolveValue ? (resolveValue(useConfiguratorDetail) as ConfiguratorDetail | null) : null;
 const groups = (configurator?.detail ?? []).map((m) =>
  productGroupSchema(m, { siteOrigin: siteUrl, brandName: theme.storeName, facts: DETAIL_PRODUCTS.find((p) => p.slug === m.slug)?.facts, variantUrls: hasView('route.product') }),
 );

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
   ...(!searchTerm ? groups : []),
  ],
 });
};

export const onStaticGenerate: StaticGenerateHandler = () => {
 return { params: [] };
};
