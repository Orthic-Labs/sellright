// A13: PDP platform code moved verbatim from src/routes/products/[...slug]/index.tsx (loaders, SEO head, static
// generation). The PDP live-stock refresh itself (qidle, getProductStock) stays in ProductContent.tsx: it is a $ closure
// over component signals and cannot move verbatim.
import { routeLoader$, server$, type StaticGenerateHandler } from '@qwik.dev/router';
import { noStore, shellRender } from '~/platform/shell-render';
import { generateImagePreloadLinks } from '~/components/ui/LazyImage';
import { getProductDetail } from '~/providers/shop/products/products';
import { getProductReviews } from '~/providers/shop/rewards/rewards';
import { liveProductMeta, manifestProductMeta, normalizeManifestProductDetail, type CatalogProduct, type RawManifestProductDetail } from '~/sellright/types/catalog';
import { withAggregateRating } from '~/utils/rewards';
import { cleanUpParams } from '~/utils';
import { createSEOHead } from '~/utils/seo';
import { generateBreadcrumbSchema } from '~/services/seo-schemas';
import { jsonLdProduct } from '~/services/sellright-seo';
import { PDP_RELATED, productPageContent } from '~/platform/brand-data';
import { relatedPricesOf, relatedRow } from '~/platform/product-related-model';
import { normalizeBrowseCatalog } from '~/services/browse-catalog';
import type { JsonLdSchema } from '~/types/seo.types';
import { theme, siteUrl } from '~/theme/theme.config';
import { readCatalogGeneration, readCatalogSnapshot } from '~/services/catalog-snapshot';
import { catalogInStockOf, v1DetailFile, v2DetailFile } from '~/platform/catalog-stock-hint';
import { PRODUCT_PREFIX, productUrl } from '~/platform/product-path';
import { withAbsoluteImages, withoutOffers } from '~/platform/product-jsonld';
import { productMetaDescription } from '~/platform/product-meta';
import { hasView } from '~/platform/gateway';

/** The page reads these loaders in the browser too (render and head refresh). With the router's default ('never') each
 *  read after load re-fetched the loader, running it and its API calls again (#362). Their values are already rendered
 *  into the page; the product carries the fail-closed stock shell only (live stock is read in the browser). */
const PAGE_LOADER_OPTIONS = { serializationStrategy: 'always' } as const;

export interface ProductLoaderResult {
  product: CatalogProduct;
  source: 'manifest' | 'network';
  warning: string | null;
  /** Real product UUID (keys loyalty product multipliers); from the manifest,
   *  or the live detail response. Null only against an older API. */
  productId: string | null;
  /** Approved-review aggregate for the rating link + AggregateRating JSON-LD;
   *  null when the product is unreviewed or reviews are off/unreadable. On the
   *  live-API path it comes from the reviews endpoint summary. */
  rating: { average: number; count: number } | null;
  /** #382: the manifest detail's product-level inStock (computed from stock levels at publish), so first paint does
   *  not show a whole product sold out before live stock answers; null on the live-API path and older manifests. */
  catalogInStock?: boolean | null;
  /** ADR-0001 (SHELL_CACHE=1): the product's prices are redacted (0) and the stock hint removed; the page reads both in the browser
   *  (`readProductValues`, the live stock read). Absent = the loader carries the prices, as before. */
  valuesPending?: boolean;
}

/** One variant's live price fields, by SKU. */
export interface VariantPrice { sku: string; price: number; salePrice: number | null; preOrderPrice: number | null }

/** The shell copy of a product loader result (ADR-0001 §2-§3): prices zeroed, the stock hint removed, `valuesPending`. */
export function shellProductResult<T extends ProductLoaderResult>(r: T): T {
  return {
    ...r,
    product: { ...r.product, variants: r.product.variants.map((v) => ({ ...v, price: 0, salePrice: null, preOrderPrice: null, compareAtPrice: null })) },
    catalogInStock: null,
    valuesPending: true,
  };
}

/** The live price fields of a product's variants. */
export const variantPricesOf = (product: Pick<CatalogProduct, 'variants'>): VariantPrice[] =>
  product.variants.map((v) => ({ sku: String(v.sku), price: Number(v.price) || 0, salePrice: v.salePrice ?? null, preOrderPrice: v.preOrderPrice ?? null }));

// ─────────────────────────────────────────────────────────────────
// Route loader — manifest-first with API fallback. Both paths return the
// native CatalogProduct shape with fail-closed stock (LOCKED rule: never
// block a routeLoader$ on a stock query, never default missing stock to
// in-stock) — the client hydrates real availability on qidle.
// ─────────────────────────────────────────────────────────────────
/** The PDP from the current catalog generation (metadata + the #382 in-stock hint), or null when the generation is unusable or
 *  does not have the product (the loader then falls back to the live API). Exported for the loader test. */
export async function productFromManifest(slug: string, read = readCatalogGeneration) {
  try {
    const gen = await read<RawManifestProductDetail>([v1DetailFile(slug), v2DetailFile(slug)]);
    const raw = gen.files[v1DetailFile(slug)];
    if (!raw) return null;
    const catalogInStock = catalogInStockOf(raw, gen.files[v2DetailFile(slug)]);
    return { product: normalizeManifestProductDetail(raw), source: 'manifest' as const, warning: null, ...manifestProductMeta(raw), catalogInStock };
  } catch {
    // Invalid generation or a file that fails to parse: the live API serves the PDP.
    return null;
  }
}

export const useProductLoader = routeLoader$(async ({ params, fail, status, url, headers }) => {
  // Brand views PR2: a branded product page has its own loader (useBrandProductDetail), and a route that is not the configured
  // product path (routes.json productPath) serves no product. Neither case does any I/O here.
  if (hasView('route.product') || url.pathname.split('/')[1] !== PRODUCT_PREFIX) return null;
  const { slug } = cleanUpParams(params);
  if (!slug) {
    status(404);
    return fail(404, { message: 'Product not found: missing slug' });
  }

  // Slug validation: prevent path traversal
  const SAFE_SLUG = /^[a-z0-9][a-z0-9\-_]*$/;
  if (!SAFE_SLUG.test(slug)) {
    status(404);
    return fail(404, { message: 'Product not found: invalid slug' });
  }

  // Try reading from the product JSON manifest first (metadata only — NO stock
  // in the SSR payload). Live stock is populated by the client-side
  // refreshLiveStock hook on qidle — fast SSR shell, progressive stock enable
  // once the client checks in.
  const fromManifest = await productFromManifest(slug);
  if (fromManifest) return shellRender() ? shellProductResult(fromManifest) : fromManifest;

  // No manifest: take the product id from the detail response and the rating from the reviews endpoint (null on any
  // failure — reviews must never block or fail the PDP shell). Both reads start together, not one after the other (#362).
  const reviewsRead = getProductReviews(slug, { limit: 1 }).catch(() => null);
  try {
    const product = await getProductDetail(slug);
    if (!product) {
      status(404);
      return fail(404, { message: `Product not found: ${slug}` });
    }
    const reviews = await reviewsRead;
    const result: ProductLoaderResult = { product, source: 'network' as const, warning: null, ...liveProductMeta(product, reviews) };
    return shellRender() ? shellProductResult(result) : result;
  } catch (error) {
    // A real 404 came back as null above; anything thrown is the API failing (429, 5xx, network). Answer 503 so a brief outage
    // never tells crawlers the product is gone (#408: demo PDPs returned 404 while its API was rate-limiting).
    console.error('Product loader error:', error);
    headers.set('Retry-After', '30');
    status(503);
    return fail(503, { message: 'Product temporarily unavailable' });
  }
}, PAGE_LOADER_OPTIONS);

// Product JSON-LD proxied live from the SellRight API
// (/v1/shop/seo/jsonld/products/{slug}) — offers.price/availability are
// computed from stock_level on the backend at request time, same "never
// cache stock" rule as the rest of the catalog. Runs alongside
// useProductLoader (which ships stockLevel '0' on the page itself); this
// loader only feeds the <script type="application/ld+json"> in <head>, so it
// never touches the PDP's own stock-shell/qidle-refresh behavior.
export const useProductJsonLd = routeLoader$(async ({ params, url }) => {
  if (url.pathname.split('/')[1] !== PRODUCT_PREFIX) return null;
  const { slug } = cleanUpParams(params);
  if (!slug) return null;
  const schema = await jsonLdProduct(slug);
  // ADR-0001 DP-1/DP-2: the shell's Product JSON-LD has no offers (price, availability); the browser fills them (readProductOffers).
  return shellRender() ? withoutOffers(schema) : schema;
}, PAGE_LOADER_OPTIONS);

const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9\-_]*$/;

/** ADR-0001: a PDP's live prices in the browser (base PDP), from the same source the loader reads, per request, no-store. Null on failure. */
export const readProductValues = server$(async function (slug: string): Promise<{ variants: VariantPrice[]; related: Record<string, number> } | null> {
  noStore(this);
  if (typeof slug !== 'string' || !SAFE_SLUG_RE.test(slug)) return null;
  const related = await relatedPricesFor(slug);
  const fromManifest = await productFromManifest(slug);
  if (fromManifest) return { variants: variantPricesOf(fromManifest.product), related };
  const product = await getProductDetail(slug).catch(() => null);
  return product ? { variants: variantPricesOf(product), related } : null;
});

/** The related row's prices (routes.json productPage.related), from the same snapshot the row loader reads; empty without it. */
async function relatedPricesFor(slug: string): Promise<Record<string, number>> {
  if (!PDP_RELATED) return {};
  try {
    return relatedPricesOf(relatedRow(normalizeBrowseCatalog(await readCatalogSnapshot<unknown>('shop-catalog.json')).products, slug));
  } catch {
    return {};
  }
}

/** ADR-0001 DP-1/DP-2: the live Product JSON-LD offers (the API computes price and availability per request), no-store. */
export const readProductOffers = server$(async function (slug: string): Promise<Record<string, unknown> | null> {
  noStore(this);
  if (typeof slug !== 'string' || !SAFE_SLUG_RE.test(slug)) return null;
  const schema = await jsonLdProduct(slug).catch(() => null);
  const offers = schema?.offers;
  return offers && typeof offers === 'object' ? (offers as Record<string, unknown>) : null;
});

// ─────────────────────────────────────────────────────────────────
// Head — identical to original (preserves generateImagePreloadLinks for LCP)
// ─────────────────────────────────────────────────────────────────
export const head = ({ resolveValue, url: _url }: { resolveValue: any; url: URL }) => {
  const loaderResult = resolveValue(useProductLoader);
  const product = loaderResult?.product || loaderResult;
  const productJsonLd = resolveValue(useProductJsonLd) as JsonLdSchema | null;

  // the previous platform's meta logic (platform/product-meta.ts): plain text, never the raw SPECS dump.
  const cleanDescription = productMetaDescription(product, theme.storeName);

  let imagePreloadLinks: any[] = [];
  if (product?.images?.[0]) {
    imagePreloadLinks.push(
      // One preload only (V32): avif + webp preloads both download in a browser that supports both. The <picture> avif source
      // uses the identical URL set, so the preload is reused; webp-only browsers simply skip it.
      ...generateImagePreloadLinks(product.images[0], 'productMain', ['avif']),
    );
  }

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: `${siteUrl}/` },
    { name: 'Shop', url: `${siteUrl}/shop` },
    { name: product?.name || 'Product', url: productUrl(product?.slug || '') },
  ]);

  const schemas: JsonLdSchema[] = [breadcrumbSchema];
  if (productJsonLd) {
    // The API's Product JSON-LD carries offers but no review aggregate; add
    // AggregateRating from the manifest only when the product has approved
    // reviews (never an empty/zero rating).
    schemas.push(withAggregateRating(withAbsoluteImages(productJsonLd, siteUrl), loaderResult?.rating));
  }

  // routes.json productPage.content: the product's Q&A as FAQPage (plain text, validated at build).
  const faqs = productPageContent(String(product?.slug ?? ''))?.faqs ?? [];
  if (faqs.length > 0) {
    schemas.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    } as unknown as JsonLdSchema);
  }

  const canonicalUrl = productUrl(product?.slug || '');
  return createSEOHead({
    title: product?.name || 'Product',
    description: cleanDescription,
    image: product?.images?.[0],
    canonical: canonicalUrl,
    ogUrl: canonicalUrl,
    ogType: 'product',
    links: imagePreloadLinks,
    schemas,
  });
};

// ─────────────────────────────────────────────────────────────────
// Static generation — enumerates every active product slug via the native
// catalog list (paginated, the API caps each page at 100). A fetch failure
// degrades gracefully (empty slug list) rather than failing the build.
// ─────────────────────────────────────────────────────────────────
export const onStaticGenerate: StaticGenerateHandler = async () => {
  try {
    const { listProducts } = await import('~/providers/shop/products/products');
    const slugs: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await listProducts({ limit: 100, offset });
      slugs.push(...page.items.map((p) => p.slug));
      offset += page.items.length;
      if (!page.items.length || offset >= page.total) break;
    }
    return { params: slugs.map(slug => ({ slug })) };
  } catch (error) {
    console.error('Failed to generate product slugs', error);
    return { params: [] };
  }
};
