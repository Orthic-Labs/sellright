// Collection / category page — generic, data-driven from the SellRight
// collections API (no hardcoded category names/copy). Renders full
// ProductCard tiles (image, price, sale/pre-order badges, live in-stock
// state) — `/v1/shop/collections/{slug}` returns image/inStock/pricingVariant
// per product, same as catalog/search, so the grid has full parity with the
// shop page. Talks to the native `~/sellright/catalog` client directly
// (bypassing the retired legacy-shaped collections provider
// adapter, which is out of scope for this conversion and has no other
// consumers after this route stops using it).
import { component$ } from '@qwik.dev/core';
import { Link, routeLoader$ } from '@qwik.dev/router';
import { ProductCard } from '~/platform/gateway';
import { fetchCollectionDetail } from '~/sellright/catalog';
import { createSEOHead } from '~/utils/seo';
import { generateBreadcrumbSchema } from '~/services/seo-schemas';
import { siteUrl, theme } from '~/theme/theme.config';
import { productPath } from '~/platform/product-path';
import { COLLECTION_PAGE_SIZE, collectionPageCount, collectionPageParam } from './pagination';

export const useCollectionLoader = routeLoader$(async ({ params, status, query }) => {
  const page = collectionPageParam(query.get('page'));
  if (page === null) {
    status(404);
    return null;
  }
  const collection = await fetchCollectionDetail(params.slug, { page, pageSize: COLLECTION_PAGE_SIZE });
  // A page past the end is a 404 (page 1 of an empty collection still renders its empty state).
  if (!collection || (page > 1 && page > collectionPageCount(collection.total, COLLECTION_PAGE_SIZE))) {
    status(404);
    return null;
  }
  return collection;
}, { search: ['page'] });

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
        // auto-fit (not a fixed column count) collapses unused tracks to 0
        // width instead of rendering them as empty background-colored cells
        // when a collection has fewer products than the usual column count.
        <div class="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-px bg-[var(--color-card-border)] border border-[var(--color-card-border)]">
          {c.products.map((p, index) => (
            <ProductCard
              key={p.slug}
              href={productPath(p.slug)}
              image={p.image}
              name={p.name}
              slug={p.slug}
              price={p.pricingVariant?.price ?? p.minPrice}
              inStock={p.inStock}
              priority={index < 6}
              salePrice={p.pricingVariant?.salePrice ?? null}
              preOrderPrice={p.pricingVariant?.preOrderPrice ?? null}
              isPreOrder={!!p.pricingVariant?.isPreOrder}
            />
          ))}
        </div>
      )}
      {collectionPageCount(c.total, COLLECTION_PAGE_SIZE) > 1 && (
        <nav class="mt-10 flex items-center justify-between gap-4" aria-label="Collection pages">
          {c.page > 1 ? (
            <Link href={c.page === 2 ? `/collections/${c.slug}/` : `/collections/${c.slug}/?page=${c.page - 1}`} rel="prev" class="btn-primary inline-flex w-auto px-6">Previous</Link>
          ) : <span />}
          <span class="text-[var(--color-text-muted,#71717a)]">Page {c.page} of {collectionPageCount(c.total, COLLECTION_PAGE_SIZE)}</span>
          {c.page < collectionPageCount(c.total, COLLECTION_PAGE_SIZE) ? (
            <Link href={`/collections/${c.slug}/?page=${c.page + 1}`} rel="next" class="btn-primary inline-flex w-auto px-6">Next</Link>
          ) : <span />}
        </nav>
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
    // Each page is its own canonical URL (page 1 has no query).
    canonical: `${siteUrl}/collections/${params.slug}/${collection.page > 1 ? `?page=${collection.page}` : ''}`,
    ogUrl: `${siteUrl}/collections/${params.slug}/${collection.page > 1 ? `?page=${collection.page}` : ''}`,
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
