import { component$, useStyles$ } from '@qwik.dev/core';
import { routeLoader$, type StaticGenerateHandler } from '@qwik.dev/router';
import { generateImagePreloadLinks } from '~/components/ui';
import { getProductDetail } from '~/providers/shop/products/products';
import { normalizeManifestProductDetail, type CatalogProduct, type RawManifestProductDetail } from '~/sellright/types/catalog';
import { cleanUpParams } from '~/utils';
import { createSEOHead } from '~/utils/seo';
import { generateBreadcrumbSchema } from '~/services/seo-api.service';
import { jsonLdProduct } from '~/services/sellright-seo';
import type { JsonLdSchema } from '~/types/seo.types';
import { ProductContent } from './ProductContent';
import { PDP_STYLES } from './product-styles';
import { theme, siteUrl } from '~/theme/theme.config';
import { stripHtml } from '~/utils/sanitize';
import { readCatalogSnapshot } from '~/services/catalog-snapshot';

export interface ProductLoaderResult {
  product: CatalogProduct;
  source: 'manifest' | 'network';
  warning: string | null;
}

// ─────────────────────────────────────────────────────────────────
// Route loader — manifest-first with API fallback. Both paths return the
// native CatalogProduct shape with fail-closed stock (LOCKED rule: never
// block a routeLoader$ on a stock query, never default missing stock to
// in-stock) — the client hydrates real availability on qidle.
// ─────────────────────────────────────────────────────────────────
export const useProductLoader = routeLoader$(async ({ params, fail, status }) => {
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
    return { product: normalizeManifestProductDetail(raw), source: 'manifest' as const, warning: null };
  } catch {
    // File doesn't exist or failed to parse — fall back to the live API.
  }

  try {
    const product = await getProductDetail(slug);
    if (!product) {
      status(404);
      return fail(404, { message: `Product not found: ${slug}` });
    }
    return { product, source: 'network' as const, warning: null };
  } catch (error) {
    console.error('Product loader error:', error);
    status(404);
    return fail(404, { message: `Product not found: ${slug}` });
  }
});

// Product JSON-LD proxied live from the SellRight API
// (/v1/shop/seo/jsonld/products/{slug}) — offers.price/availability are
// computed from stock_level on the backend at request time, same "never
// cache stock" rule as the rest of the catalog. Runs alongside
// useProductLoader (which ships stockLevel '0' on the page itself); this
// loader only feeds the <script type="application/ld+json"> in <head>, so it
// never touches the PDP's own stock-shell/qidle-refresh behavior.
export const useProductJsonLd = routeLoader$(async ({ params }) => {
  const { slug } = cleanUpParams(params);
  if (!slug) return null;
  return jsonLdProduct(slug);
});

// ─────────────────────────────────────────────────────────────────
// Two-group selector helpers
// ─────────────────────────────────────────────────────────────────



// ─────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────
export default component$(() => {
  useStyles$(PDP_STYLES);
  const loaderData = useProductLoader();
  return <ProductContent loaderResult={loaderData.value} />;
});

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
    { name: product?.name || 'Product', url: `${siteUrl}/products/${product?.slug || ''}/` },
  ]);

  const schemas: JsonLdSchema[] = [breadcrumbSchema];
  if (productJsonLd) schemas.push(productJsonLd);

  const canonicalUrl = `${siteUrl}/products/${product?.slug || ''}/`;
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
