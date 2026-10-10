import { component$, useStyles$ } from '@qwik.dev/core';
import { ProductContent } from './ProductContent';
import { PDP_STYLES } from './product-styles';
import { useProductLoader, useProductJsonLd, head, onStaticGenerate } from '~/platform/product';

export type { ProductLoaderResult } from '~/platform/product';
export { useProductLoader, useProductJsonLd, head, onStaticGenerate };

// ─────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────
export default component$(() => {
  useStyles$(PDP_STYLES);
  const loaderData = useProductLoader();
  return <ProductContent loaderResult={loaderData.value} />;
});
