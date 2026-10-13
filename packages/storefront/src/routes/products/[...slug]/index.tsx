import { component$, useStyles$ } from '@qwik.dev/core';
import type { RequestHandler } from '@qwik.dev/router';
import { ProductContent } from './ProductContent';
import { PDP_STYLES } from './product-styles';
import { useProductLoader, useProductJsonLd, head as baseHead, onStaticGenerate } from '~/platform/product';
import { useBrandProductDetail, brandProductHead } from '~/platform/product-detail';
import { BrandProductMount } from '~/platform/controllers/product';
import { PRODUCT_PREFIX } from '~/platform/product-path';
import { hasView } from '~/platform/gateway';

export type { ProductLoaderResult } from '~/platform/product';
export { useProductLoader, useProductJsonLd, useBrandProductDetail, onStaticGenerate };

const SAFE_SLUG = /^[a-z0-9][a-z0-9\-_]*$/;

// Brand views PR2 §9: with routes.json productPath `/shop/:slug/`, a /products/<slug>/ link (the API's emails, feed and sitemap until
// its seo.productUrlPattern changes) is a 301 to the configured path, query string kept (deep-link preselection). Anything else keeps
// today's handling.
export const onGet: RequestHandler = ({ url, params, redirect, status }) => {
  if (PRODUCT_PREFIX === 'products') return;
  const slug = (params.slug ?? '').replace(/\/$/, '');
  if (!SAFE_SLUG.test(slug)) {
    // Not a product URL under either setting: keep the 404 the product route always answered.
    status(404);
    return;
  }
  throw redirect(301, `/${PRODUCT_PREFIX}/${encodeURIComponent(slug)}/${url.search}`);
};

export const head = hasView('route.product') ? brandProductHead : baseHead;

// ─────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────
const BaseProductPage = component$(() => {
  useStyles$(PDP_STYLES);
  const loaderData = useProductLoader();
  return <ProductContent loaderResult={loaderData.value} />;
});

export default hasView('route.product') ? BrandProductMount : BaseProductPage;
