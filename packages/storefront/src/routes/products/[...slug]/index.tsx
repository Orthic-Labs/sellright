import { component$, useStyles$ } from '@qwik.dev/core';
import { routeLoader$, type StaticGenerateHandler } from '@qwik.dev/router';
import { generateImagePreloadLinks } from '~/components/ui';
import { getProductBySlug, getProductBySlugWithCachedVariants } from '~/providers/shop/products/products';
import { cleanUpParams } from '~/utils';
import { createSEOHead } from '~/utils/seo';
import { generateBreadcrumbSchema, generateProductSchema } from '~/services/seo-api.service';
import type { JsonLdSchema } from '~/types/seo.types';
import { ProductContent } from './ProductContent';
import { PDP_STYLES } from './product-styles';

// ─────────────────────────────────────────────────────────────────
// Route loader — manifest-first with API fallback
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

  // Try reading from product JSON file first (metadata only — NO stock in the SSR payload).
  // Variants ship with stockLevel '0' so every option button renders disabled on first paint.
  // Live stock is populated by the client-side refreshLiveStock hook on qidle/focus/visibility,
  // matching Rotten's ShopComponent pattern (fast SSR, progressive enable).
  const CATALOG_DIR = process.env.CATALOG_DIR || '/home/vendure/sites/damned/data';
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(`${CATALOG_DIR}/products/${slug}.json`, 'utf-8');
    const data = JSON.parse(raw);

    return {
      product: {
        id: data.id,
        name: data.name,
        slug: data.slug,
        description: data.description,
        featuredAsset: data.featuredAsset ? { id: 'manifest', preview: data.featuredAsset.preview, name: data.name, source: data.featuredAsset.preview, createdAt: data.lastUpdated, updatedAt: data.lastUpdated, fileSize: 0, height: 0, width: 0, mimeType: 'image/png', type: 'IMAGE', focalPoint: null, customFields: null, tags: [] } : null,
        assets: data.assets.map((a: any, i: number) => ({ id: `asset_${i}`, preview: a.preview, name: `${data.name} ${i}`, source: a.preview, createdAt: data.lastUpdated, updatedAt: data.lastUpdated, fileSize: 0, height: 0, width: 0, mimeType: 'image/png', type: 'IMAGE', focalPoint: null, customFields: null, tags: [] })),
        variants: data.variants.map((v: any) => ({
          id: v.id,
          name: v.name,
          sku: v.sku,
          priceWithTax: v.priceWithTax,
          currencyCode: 'USD',
          options: v.options.map((o: any) => ({ id: o.code, code: o.code, name: o.name, group: { id: o.code, name: o.group, code: o.code }, groupId: o.code })),
          assets: v.assets.map((a: any, i: number) => ({ id: `vasset_${v.id}_${i}`, preview: a.preview })),
          customFields: v.customFields || {},
          // Stock is NEVER in the SSR payload — populated client-side after hydration.
          stockLevel: '0',
        })),
        facetValues: data.facetValues?.map((fv: any) => ({ id: fv.name, name: fv.name, code: fv.name, facet: { id: fv.facetName, name: fv.facetName, code: fv.facetName } })) || [],
        customFields: {},
        hasVariantAssets: Boolean(data.hasVariantAssets),
      },
      source: 'manifest',
      warning: null,
    };
  } catch {
    // File doesn't exist or failed to parse — fall back to API
  }

  // Existing API fallback
  let result;
  try {
    result = await getProductBySlugWithCachedVariants(slug);
    if (!result || !result.product) {
      console.warn('Cache-aware loader failed, falling back to direct query');
      const product = await getProductBySlug(slug);
      if (!product) {
        status(404);
        return fail(404, { message: `Product not found: ${slug}` });
      }
      result = { product, source: 'fallback', warning: null };
    }
  } catch (error) {
    console.error('Product loader error:', error);
    try {
      const product = await getProductBySlug(slug);
      if (!product) {
        status(404);
        return fail(404, { message: `Product not found: ${slug}` });
      }
      result = { product, source: 'error-fallback', warning: 'Data may be outdated due to loading issues' };
    } catch (_fallbackError) {
      status(404);
      return fail(404, { message: `Product not found: ${slug}` });
    }
  }

  const product = result.product;
  if (product && !product.assets) product.assets = [];
  if (product && product.assets.length === 0) {
    product.assets.push({
      __typename: 'Asset' as const,
      id: 'placeholder_1', name: 'placeholder',
      preview: '/asset_placeholder.webp', source: '/asset_placeholder.webp',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      fileSize: 0, height: 400, width: 400, mimeType: 'image/webp',
      type: 'IMAGE' as any, focalPoint: null, customFields: null, tags: [],
    } as any);
  }
  return result;
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

  const cleanDescription = product?.description
    ? (() => {
      const raw = product.description.replace(/<[^>]*>/g, '').replace(/[""]/g, '"').replace(/['']/g, "'").trim();
      if (raw.length <= 160) return raw;
      const truncated = raw.substring(0, 160);
      const lastSpace = truncated.lastIndexOf(' ');
      return (lastSpace > 80 ? truncated.substring(0, lastSpace) : truncated).replace(/[.,;:!?\s]+$/, '') + '…';
    })()
    : `${product?.name || 'Product'} - High quality product available at Damned Designs`;

  let imagePreloadLinks: any[] = [];
  if (product?.featuredAsset?.preview) {
    imagePreloadLinks.push(
      ...generateImagePreloadLinks(product.featuredAsset.preview, 'productMain', ['avif', 'webp']),
    );
  }

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: 'https://www.damneddesigns.com/' },
    { name: 'Shop', url: 'https://www.damneddesigns.com/shop' },
    { name: product?.name || 'Product', url: `https://www.damneddesigns.com/products/${product?.slug || ''}/` },
  ]);

  let productSchema = null;
  try {
    productSchema = generateProductSchema(product);
  } catch (error) {
    console.warn('Failed to generate product schema:', error);
  }

  const schemas: JsonLdSchema[] = [breadcrumbSchema];
  if (productSchema) schemas.push(productSchema);

  const canonicalUrl = `https://www.damneddesigns.com/products/${product?.slug || ''}/`;
  return createSEOHead({
    title: product?.name || 'Product',
    description: cleanDescription || `${product?.name || 'Product'} - Premium quality knife from Damned Designs`,
    image: product?.featuredAsset?.preview,
    canonical: canonicalUrl,
    ogUrl: canonicalUrl,
    ogType: 'product',
    links: imagePreloadLinks,
    schemas,
  });
};

// ─────────────────────────────────────────────────────────────────
// Static generation — identical to original
// ─────────────────────────────────────────────────────────────────
export const onStaticGenerate: StaticGenerateHandler = async () => {
  const endpoint = process.env.VENDURE_API_URL || 'http://localhost:3100/shop-api';
  const query = `
    query GetProductSlugs {
      products(options: { take: 500 }) {
        items { slug }
      }
    }
  `;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const json = await response.json();
    const slugs: string[] = json?.data?.products?.items?.map((p: { slug: string }) => p.slug) ?? [];
    return { params: slugs.map(slug => ({ slug })) };
  } catch (error) {
    console.error('Failed to generate product slugs', error);
    return { params: [] };
  }
};