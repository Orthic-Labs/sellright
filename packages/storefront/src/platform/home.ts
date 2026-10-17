// A13: homepage platform code moved verbatim from src/routes/index.tsx (loaders + JSON-LD wiring). The route file
// re-exports the loaders (proven pattern, see probe.ts) and keeps the presentation.
import { routeLoader$ } from '@qwik.dev/router';
import { createSEOHead } from '~/utils/seo';
import { jsonLdOrganization } from '~/services/sellright-seo';
import type { JsonLdSchema } from '~/types/seo.types';
import { getProductBySlug, search } from '~/providers/shop/products/products';
import { srCollections } from '~/utils/sellright';

/* Optional homepage spotlight product — configure VITE_HOME_SPOTLIGHT_SLUG to
 * feature a real catalog item. Unset by default so a fresh install never
 * ships a broken/fabricated product reference. */
const SPOTLIGHT_PRODUCT_SLUG = (import.meta.env.VITE_HOME_SPOTLIGHT_SLUG as string | undefined) || '';

/* Optional second homepage product for the "New Arrival" strip
 * (HomeTeeSection) — configure VITE_HOME_FEATURE_SLUG to a DIFFERENT catalog
 * item than VITE_HOME_SPOTLIGHT_SLUG so the two sections never feature the
 * same product back-to-back. If unset (or accidentally equal to the
 * spotlight slug) HomeTeeSection falls back to its generic, product-less
 * "New arrivals." copy rather than repeating the spotlight product. */
const FEATURE_PRODUCT_SLUG = (import.meta.env.VITE_HOME_FEATURE_SLUG as string | undefined) || '';

// Organization + WebSite JSON-LD proxied live from the SellRight API
// (/v1/shop/seo/jsonld/organization) — never generated locally from
// theme.config.ts, so the schema always matches whatever the backend store
// config says (siteUrl, address, social links, etc).
export const useOrganizationJsonLd = routeLoader$(async () => jsonLdOrganization());

async function fetchHomeProduct(slug: string) {
  if (!slug) return null;
  try {
    const product = await getProductBySlug(slug);
    if (!product) return null;
    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      // Plain-text category label for the featured-product spec row (e.g.
      // seed tags ['demo','desk'] -> 'Desk'). Never fabricate material/fit/
      // finish claims — show only what the product's own data says.
      category: (product.facetValues || []).map((f: any) => f.name).find((t: string) => t !== 'demo') || null,
      description: product.description || null,
      featuredAsset: product.featuredAsset,
      variants: product.variants.map((v: any) => ({
        id: v.id,
        name: v.name,
        price: v.price,
        priceWithTax: v.priceWithTax,
        stockLevel: v.stockLevel,
        options: v.options,
        featuredAsset: v.featuredAsset,
        customFields: {
          preOrderPrice: v.customFields?.preOrderPrice,
          salePrice: v.customFields?.salePrice,
          shipDate: v.customFields?.shipDate, shipDateLabel: v.customFields?.shipDateLabel,
          isPreOrder: v.customFields?.isPreOrder,
        },
      })),
    };
  } catch {
    return null;
  }
}

export const usePreorderProduct = routeLoader$(async () => fetchHomeProduct(SPOTLIGHT_PRODUCT_SLUG));

// Distinct from usePreorderProduct on purpose — same slug would render the
// same product in both the spotlight section AND HomeTeeSection.
export const useFeatureProduct = routeLoader$(async () => {
  if (!FEATURE_PRODUCT_SLUG || FEATURE_PRODUCT_SLUG === SPOTLIGHT_PRODUCT_SLUG) return null;
  return fetchHomeProduct(FEATURE_PRODUCT_SLUG);
});

/** Live storefront catalog — 4 tiles, same data/shape as the shop grid
 * (adaptSearch), so a demo/fresh install always has real, honest product
 * tiles here rather than a hand-picked slug that might not exist yet. */
export const useFeaturedProducts = routeLoader$(async () => {
  try {
    const res = await search({ take: 4 });
    return (res?.items ?? []).slice(0, 4);
  } catch {
    return [];
  }
});

/** Collection links (Desk & Paper / Everyday Carry / At Home on the seeded
 * demo catalog) — whatever the store actually has, never a hardcoded list. */
export const useHomeCollections = routeLoader$(async () => {
  try {
    const res = await srCollections();
    return (res?.items ?? []).filter((c) => c.products > 0).slice(0, 6);
  } catch {
    return [];
  }
});

/** SEO head body for the homepage. The route's `head` resolves the loaders and passes the hero preload href in, so the
 *  brand-replaceable hero asset import stays in the presentation file. null (a brand home view, which preloads its own hero
 *  through head.json imagePreloads): no base hero preload. */
export const buildHomeHead = (
  schemas: JsonLdSchema[],
  identity: any,
  heroPreloadHref: string | null,
) =>
  createSEOHead({
    title: identity.storeName,
    description: identity.tagline,
    noindex: false,
    image: `${identity.siteOrigin}${identity.ogImageUrl}`,
    ogUrl: `${identity.siteOrigin}/`,
    identity,
    links: heroPreloadHref ? [{ rel: 'preload', as: 'image', type: 'image/avif', href: heroPreloadHref }] : [],
    schemas,
  });
