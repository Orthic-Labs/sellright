// A13: PDP platform code moved verbatim from src/routes/products/[...slug]/index.tsx (loaders, SEO head, static
// generation). The PDP live-stock refresh itself (qidle, getProductStock) stays in ProductContent.tsx: it is a $ closure
// over component signals and cannot move verbatim.
import { routeLoader$, type StaticGenerateHandler } from '@qwik.dev/router';
import { generateImagePreloadLinks } from '~/components/ui/LazyImage';
import { getProductDetail } from '~/providers/shop/products/products';
import { getProductReviews } from '~/providers/shop/rewards/rewards';
import { liveProductMeta, manifestProductMeta, normalizeManifestProductDetail, type CatalogProduct, type RawManifestProductDetail } from '~/sellright/types/catalog';
import { withAggregateRating } from '~/utils/rewards';
import { cleanUpParams } from '~/utils';
import { createSEOHead } from '~/utils/seo';
import { generateBreadcrumbSchema } from '~/services/seo-schemas';
import { jsonLdProduct } from '~/services/sellright-seo';
import { productPageContent } from '~/platform/brand-data';
import type { JsonLdSchema } from '~/types/seo.types';
import { theme, siteUrl } from '~/theme/theme.config';
import { stripHtml } from '~/utils/sanitize';
import { readCatalogSnapshot } from '~/services/catalog-snapshot';
import { PRODUCT_PREFIX, productUrl } from '~/platform/product-path';
import { withAbsoluteImages } from '~/platform/product-jsonld';
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
}

// ─────────────────────────────────────────────────────────────────
// Route loader — manifest-first with API fallback. Both paths return the
// native CatalogProduct shape with fail-closed stock (LOCKED rule: never
// block a routeLoader$ on a stock query, never default missing stock to
// in-stock) — the client hydrates real availability on qidle.
// ─────────────────────────────────────────────────────────────────
export const useProductLoader = routeLoader$(async ({ params, fail, status, url }) => {
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
  try {
    const raw = await readCatalogSnapshot<RawManifestProductDetail>(`products/${slug}.json`);
    return { product: normalizeManifestProductDetail(raw), source: 'manifest' as const, warning: null, ...manifestProductMeta(raw) };
  } catch {
    // File doesn't exist or failed to parse — fall back to the live API.
  }

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
    return { product, source: 'network' as const, warning: null, ...liveProductMeta(product, reviews) };
  } catch (error) {
    console.error('Product loader error:', error);
    status(404);
    return fail(404, { message: `Product not found: ${slug}` });
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
  return jsonLdProduct(slug);
}, PAGE_LOADER_OPTIONS);

// ─────────────────────────────────────────────────────────────────
// Head — identical to original (preserves generateImagePreloadLinks for LCP)
// ─────────────────────────────────────────────────────────────────
export const head = ({ resolveValue, url: _url }: { resolveValue: any; url: URL }) => {
  const loaderResult = resolveValue(useProductLoader);
  const product = loaderResult?.product || loaderResult;
  const productJsonLd = resolveValue(useProductJsonLd) as JsonLdSchema | null;

  const cleanDescription = product?.description
    ? (() => {
      // stripHtml (DOMPurify, real HTML parser) instead of a hand-rolled
      // tag-strip regex — a single-pass `/<[^>]*>/g` replace can leave a
      // reconstructed `<script` behind for crafted input like
      // `<scr<script>ipt>` (CodeQL js/incomplete-multi-character-sanitization).
      const raw = stripHtml(product.description).replace(/[""]/g, '"').replace(/['']/g, "'").trim();
      if (raw.length <= 160) return raw;
      const truncated = raw.substring(0, 160);
      const lastSpace = truncated.lastIndexOf(' ');
      return (lastSpace > 80 ? truncated.substring(0, lastSpace) : truncated).replace(/[.,;:!?\s]+$/, '') + '…';
    })()
    : `${product?.name || 'Product'} - High quality product available at ${theme.storeName}`;

  let imagePreloadLinks: any[] = [];
  if (product?.images?.[0]) {
    imagePreloadLinks.push(
      ...generateImagePreloadLinks(product.images[0], 'productMain', ['avif', 'webp']),
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
    description: cleanDescription || `${product?.name || 'Product'} - Premium quality product from ${theme.storeName}`,
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
