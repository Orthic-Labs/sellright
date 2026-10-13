// Brand views PR2 §9: product pages under /shop/<slug>/ when routes.json productPath is `/shop/:slug/`. Otherwise this route is
// today's catch-all 404 (its onGet, head and component), so /shop/<anything>/ answers exactly as before.
import { component$, useStyles$ } from '@qwik.dev/core';
import type { DocumentHead, RequestHandler } from '@qwik.dev/router';
import CatchAll, { head as catchAllHead, onGet as catchAllOnGet, useLegacyRedirects } from '../../[...catchall]/index';
import { ProductContent } from '../../products/[...slug]/ProductContent';
import { PDP_STYLES } from '../../products/[...slug]/product-styles';
import { useProductLoader, useProductJsonLd, head as baseHead } from '~/platform/product';
import { useBrandProductDetail, brandProductHead } from '~/platform/product-detail';
import { BrandProductMount } from '~/platform/controllers/product';
import { PRODUCT_PREFIX } from '~/platform/product-path';
import { hasView } from '~/platform/gateway';

export { useProductLoader, useProductJsonLd, useBrandProductDetail, useLegacyRedirects };

const ACTIVE = PRODUCT_PREFIX === 'shop';

export const onGet: RequestHandler = async (ev) => {
  if (!ACTIVE) return catchAllOnGet(ev);
};

export const head = (ACTIVE ? (hasView('route.product') ? brandProductHead : baseHead) : catchAllHead) as DocumentHead;

const BaseProductPage = component$(() => {
  useStyles$(PDP_STYLES);
  const loaderData = useProductLoader();
  return <ProductContent loaderResult={loaderData.value} />;
});

export default ACTIVE ? (hasView('route.product') ? BrandProductMount : BaseProductPage) : CatchAll;
