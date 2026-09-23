// Collection / category page — generic, data-driven from the SellRight
// collections API (no hardcoded category names/copy). Renders full
// ProductCard tiles (image, price, sale/pre-order badges, live in-stock
// state) — `/v1/shop/collections/{slug}` now returns image/inStock/
// pricingVariant per product, same as catalog/search, so the grid has full
// parity with the shop page.
import { component$ } from '@qwik.dev/core';
import { Link, routeLoader$ } from '@qwik.dev/router';
import ProductCard from '~/components/products/ProductCard';
import { getCollectionBySlug } from '~/providers/shop/collections/collections';
import { createSEOHead } from '~/utils/seo';
import { generateBreadcrumbSchema } from '~/services/seo-api.service';
import { siteUrl, theme } from '~/theme/theme.config';

export const useCollectionLoader = routeLoader$(async ({ params, status }) => {
  try {
    return await getCollectionBySlug(params.slug, { pageSize: 60 });
  } catch {
    status(404);
    return null;
  }
});

export default component$(() => {
  const collection = useCollectionLoader();

  if (!collection.value) {
    return (
      <div class="max-w-3xl mx-auto px-6 py-24 text-center">
        <h1 class="text-2xl font-semibold mb-2">Collection not found</h1>
        <p class="text-[var(--color-text-muted,#71717a)] mb-6">
          This collection doesn't exist or is no longer published.
        </p>
        <Link href="/shop" class="btn-primary inline-flex w-auto px-6">Browse all products</Link>
      </div>
    );
  }

  const c = collection.value;

  return (
    <div class="max-w-6xl mx-auto px-6 py-12">
      <header class="mb-10">
        <h1 class="text-3xl font-semibold mb-2">{c.name}</h1>
        {c.description && <p class="text-[var(--color-text-muted,#71717a)] max-w-2xl">{c.description}</p>}
      </header>

      {c.products.length === 0 ? (
        <p class="text-[var(--color-text-muted,#71717a)]">No products in this collection yet.</p>
      ) : (
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-px bg-[var(--color-card-border)]">
          {c.products.map((p, index) => (
            <ProductCard
              key={p.slug}
              productAsset={p.productAsset}
              productName={p.name}
              slug={p.slug}
              priceWithTax={p.minPrice}
              inStock={p.inStock}
              priority={index < 6}
              salePrice={p.salePrice}
              preOrderPrice={p.preOrderPrice}
              isPreOrder={p.isPreOrder}
            />
          ))}
        </div>
      )}
    </div>
  );
});

export const head = ({ resolveValue, params }: any) => {
  const collection = resolveValue(useCollectionLoader);
  if (!collection) {
    return createSEOHead({ title: 'Collection not found', description: 'This collection is unavailable.', noindex: true });
  }
  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: `${siteUrl}/` },
    { name: 'Shop', url: `${siteUrl}/shop` },
    { name: collection.name, url: `${siteUrl}/collections/${params.slug}` },
  ]);
  return createSEOHead({
    title: collection.seoTitle || collection.name,
    description: collection.seoDescription || collection.description || `Shop ${collection.name} at ${theme.storeName}.`,
    canonical: `${siteUrl}/collections/${params.slug}/`,
    ogUrl: `${siteUrl}/collections/${params.slug}/`,
    schemas: [
      breadcrumbSchema,
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: collection.name,
        url: `${siteUrl}/collections/${params.slug}`,
        description: collection.description || undefined,
      },
    ],
  });
};
