// A13: homepage platform code moved verbatim from src/routes/index.tsx (loaders + JSON-LD wiring). The route file
// re-exports the loaders (proven pattern, see probe.ts) and keeps the presentation.
import { routeLoader$, server$ } from '@qwik.dev/router';
import { noStore, shellRender } from '~/platform/shell-render';
import { createSEOHead } from '~/utils/seo';
import { jsonLdOrganization } from '~/services/sellright-seo';
import type { JsonLdSchema } from '~/types/seo.types';
import { getProductBySlug, search } from '~/providers/shop/products/products';
import { srCollections } from '~/utils/sellright';
import { hasView } from '~/platform/gateway';

/** A brand `route.home` view renders BrandHomeMount (identity, featured tiles, spotlight), never the base page's spotlight,
 *  feature strip or collection links: their loaders return empty without any I/O there (#362). */
const brandHome = () => hasView('route.home');

/** The home page reads its loaders in the browser too; with the router's default ('never') each read after load
 *  re-fetched the loader and re-ran its API calls (#362). Their values are already rendered into the page. */
const HOME_LOADER_OPTIONS = { serializationStrategy: 'always' } as const;

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
export const useOrganizationJsonLd = routeLoader$(async () => jsonLdOrganization(), HOME_LOADER_OPTIONS);

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

type HomeProduct = NonNullable<Awaited<ReturnType<typeof fetchHomeProduct>>>;

/** ADR-0001 §2-§3: the shell copy of a home product: every price and the stock level removed, `valuesPending`. */
export function shellHomeProduct(p: HomeProduct | null): (HomeProduct & { valuesPending?: boolean }) | null {
  if (!p) return null;
  return {
    ...p,
    variants: p.variants.map((v) => ({
      ...v,
      price: 0,
      priceWithTax: 0,
      stockLevel: null,
      customFields: { ...v.customFields, preOrderPrice: null, salePrice: null },
    })),
    valuesPending: true,
  };
}

/** A home product loader's value: with SHELL_CACHE=1 the shell copy. */
const homeProductFor = async (slug: string) => {
  const p = await fetchHomeProduct(slug);
  return shellRender() ? shellHomeProduct(p) : (p as (HomeProduct & { valuesPending?: boolean }) | null);
};

export const usePreorderProduct = routeLoader$(async () => (brandHome() ? null : homeProductFor(SPOTLIGHT_PRODUCT_SLUG)), HOME_LOADER_OPTIONS);

// Distinct from usePreorderProduct on purpose — same slug would render the
// same product in both the spotlight section AND HomeTeeSection.
export const useFeatureProduct = routeLoader$(async () => {
  if (brandHome() || !FEATURE_PRODUCT_SLUG || FEATURE_PRODUCT_SLUG === SPOTLIGHT_PRODUCT_SLUG) return null;
  return homeProductFor(FEATURE_PRODUCT_SLUG);
}, HOME_LOADER_OPTIONS);

/** Live storefront catalog — 4 tiles, same data/shape as the shop grid
 * (adaptSearch), so a demo/fresh install always has real, honest product
 * tiles here rather than a hand-picked slug that might not exist yet. */
async function featuredItems() {
  try {
    const res = await search({ take: 4 });
    return (res?.items ?? []).slice(0, 4);
  } catch {
    return [];
  }
}

type FeaturedItem = Awaited<ReturnType<typeof featuredItems>>[number];

/** ADR-0001 §2-§3: a featured tile for the shell: no price, the fail-closed stock constant (shown as "not known yet"). */
export const shellFeaturedItem = (item: FeaturedItem): FeaturedItem => ({ ...item, priceWithTax: { min: 0, max: 0 }, inStock: false });

/** `valuesPending` (SHELL_CACHE=1): the tiles carry no price or stock; the page reads them in the browser (readHomeValues). */
export const useFeaturedProducts = routeLoader$(async () => {
  const items = await featuredItems();
  return shellRender() ? { items: items.map(shellFeaturedItem), valuesPending: true } : { items, valuesPending: false };
}, HOME_LOADER_OPTIONS);

/** ADR-0001: the home page's live values in the browser, from the same reads as the loaders, per request, no-store. */
export const readHomeValues = server$(async function () {
  noStore(this);
  const base = !brandHome();
  const [preorder, feature, featured] = await Promise.all([
    base ? fetchHomeProduct(SPOTLIGHT_PRODUCT_SLUG) : null,
    base && FEATURE_PRODUCT_SLUG && FEATURE_PRODUCT_SLUG !== SPOTLIGHT_PRODUCT_SLUG ? fetchHomeProduct(FEATURE_PRODUCT_SLUG) : null,
    featuredItems(),
  ]);
  return { preorder, feature, featured };
});

/** Collection links (Desk & Paper / Everyday Carry / At Home on the seeded
 * demo catalog) — whatever the store actually has, never a hardcoded list. */
export const useHomeCollections = routeLoader$(async () => {
  if (brandHome()) return [];
  try {
    const res = await srCollections();
    return (res?.items ?? []).filter((c) => c.products > 0).slice(0, 6);
  } catch {
    return [];
  }
}, HOME_LOADER_OPTIONS);

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
