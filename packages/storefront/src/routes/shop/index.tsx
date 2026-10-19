import { $, component$, useSignal, useStore, useTask$ } from '@qwik.dev/core';
import { ProductCard, ShopFilters as Filters, hasView, platformAction } from '~/platform/gateway';
import { BrandShopMount } from '~/platform/controllers/shop';
import { useShopListingOnLoad } from '~/platform/stock-triggers';
import { liveListingAvailability, readLiveListing as fetchLiveListing } from '~/platform/listing-availability';
import { searchProducts } from '~/providers/shop/products/products';
import type { CatalogListItem } from '~/sellright/types/catalog';
import { FacetWithValues } from '~/types';
import { shopCategoryFilters } from '~/theme/theme.config';
import { categoryFacets, filterCategoryProducts } from '~/utils/shop-categories';
import { useCatalogLoader } from '~/platform/shop';
import { projectFacetIds, projectFacets } from '~/platform/controllers/project';
import { productPath } from '~/platform/product-path';
import { SHOP_PRICE_RANGE, listingRank } from '~/platform/brand-data';

export { useCatalogLoader };
export { useConfiguratorDetail } from '~/platform/configurator-detail';
export { head, onStaticGenerate } from '~/platform/shop';

// Both shop and search use the same configured category identities and tags.
const SHOP_FILTERS = categoryFacets(shopCategoryFilters);

const BaseShopPage = component$(() => {
 const catalog = useCatalogLoader();

 // Fallback API data (only used when manifest is missing or for text search) —
 // same native CatalogListItem[] shape as the manifest, so the grid never has
 // to branch on where a product came from.
 const apiData = useSignal<{ items: CatalogListItem[]; total: number } | null>(null);
 const isSearching = useSignal(false);
 const searchTerm = useSignal('');
 const facetIds = useSignal<string[]>([]);
 const inStockOnly = useSignal(true);
 // Overrides populated ONLY when the in-stock toggle is flipped — live backend check
 // at that exact moment. Never consulted at any other time. Keyed by slug (the
 // catalog's stable identity — SellRight has no numeric product id).
 const liveStockOverride = useSignal<Record<string, boolean> | null>(null);

 const state = useStore<{
  showMenu: boolean;
  facetValues: FacetWithValues[];
 }>({
  showMenu: false,
  facetValues: SHOP_FILTERS.map(facet => ({
   ...facet,
   values: facet.values.map(value => ({ ...value, selected: false })),
  })),
 });

 // T13: Text search — fires when searchTerm changes (needs API call)
 useTask$(async ({ track }) => {
  const term = track(() => searchTerm.value);
  if (typeof document === 'undefined') return;

  if (term) {
   isSearching.value = true;
   try {
    const result = await searchProducts({ term, take: 200, inStock: inStockOnly.value || undefined });
    apiData.value = result;
   } catch (err) {
    console.error('Shop search failed:', err);
   } finally {
    isSearching.value = false;
   }
  } else {
   apiData.value = null;
  }
 });

 const getDisplayProducts = () => {
  // If text search is active, use API data
  if (searchTerm.value && apiData.value) {
   const products = filterCategoryProducts(apiData.value.items, shopCategoryFilters, facetIds.value)
    .filter(item => !inStockOnly.value || item.inStock);
   return { products, count: products.length };
  }

  // Use manifest data with client-side filtering.
  // If the in-stock toggle was flipped, the live override from that moment
  // supersedes the manifest's inStock value.
  const override = liveStockOverride.value;
  let products: CatalogListItem[] = (catalog.value.products || []).map(p =>
   override && Object.prototype.hasOwnProperty.call(override, p.slug)
    ? { ...p, inStock: override[p.slug] }
    : p,
  );

  // In-stock filter
  if (inStockOnly.value) {
   products = products.filter(p => p.inStock);
  }

  // Category filter
  products = filterCategoryProducts(products, shopCategoryFilters, facetIds.value);

  // Sort: in-stock first, then the brand's merchandising order (routes.json shop.listingOrder), then manifest order
  const sorted = [...products].sort((a, b) => {
   if (a.inStock && !b.inStock) return -1;
   if (!a.inStock && b.inStock) return 1;
   return listingRank(a.slug) - listingRank(b.slug); // equal ranks keep manifest order (stable sort)
  });

  return { products: sorted, count: sorted.length };
 };

 const onFilterChange = $((id: string) => {
  if (id === 'CLEAR_ALL') {
   facetIds.value = [];
  } else {
   facetIds.value = [id];
  }
  // Update filter UI selected state
  state.facetValues = SHOP_FILTERS.map(facet => ({
   ...facet,
   values: facet.values.map(value => ({
    ...value,
    selected: id !== 'CLEAR_ALL' && value.id === id,
   })),
  }));
 });

 const onSearchChange = $((newTerm: string) => {
  searchTerm.value = newTerm;
 });

 // The listing's live read (the toggle, and shop.stockOnLoad = live on load): fail closed per platform/listing-availability.ts, and
 // only the latest request applies (an older response can never overwrite a newer one).
 const listingGen = useSignal(0);
 const readLiveListing = $(async (): Promise<boolean> => {
  const gen = ++listingGen.value;
  const live = await fetchLiveListing((p) => searchProducts(p));
  if (live === null) console.error('[shop] Live stock read failed');
  if (gen !== listingGen.value) return live !== null;
  liveStockOverride.value = liveListingAvailability((catalog.value.products || []).map((p) => p.slug), live);
  return live !== null;
 });

 // shop.stockOnLoad = live: one live listing read per view on load (platform/stock-triggers.ts). Default manifest: none.
 useShopListingOnLoad(readLiveListing);

 // Toggling the stock filter refreshes availability from SellRight.
 const onInStockChange = $(async (inStock: boolean) => {
  inStockOnly.value = inStock;
  isSearching.value = true;
  try {
   await readLiveListing();
  } finally {
   isSearching.value = false;
  }
 });

 const displayData = getDisplayProducts();
 const displayProducts = displayData.products;
 const displayCount = displayData.count;

 return (
  <div class="bg-[var(--color-parchment)] min-h-screen">

   {/* ── PAGE HEADING (visually subtle, semantically correct) ── */}
   <h1 class="sr-only">Shop All Products</h1>

   {/* ── FILTERS BAR ── */}
   <div class="border-b border-[var(--color-card-border)] bg-[var(--color-parchment)]">
    <div class="max-w-[1920px] mx-auto px-4 sm:px-8 lg:px-12 py-4">
     <Filters
      facetsWithValues={projectFacets(state.facetValues)}
      facetValueIds={projectFacetIds(facetIds.value)}
      onFilterChange$={platformAction('filters.value', onFilterChange)}
      searchTerm={searchTerm.value}
      onSearchChange$={platformAction('filters.search', onSearchChange)}
     />
    </div>
   </div>

   {/* ── META ROW — stock toggle + count ── */}
   <div class="border-b border-[var(--color-card-border)] bg-[var(--color-parchment)]">
    <div class="max-w-[1920px] mx-auto px-4 sm:px-8 lg:px-12 py-3 flex items-center gap-4">
     <label class="flex items-center gap-2 cursor-pointer select-none">
      <input type="checkbox" class="sr-only peer" checked={inStockOnly.value} onChange$={(_event, element) => onInStockChange(element.checked)} />
      <div class="min-h-[48px] min-w-[48px] flex items-center justify-center flex-shrink-0 peer-focus-visible:outline peer-focus-visible:outline-2">
      <div
       class={`relative w-8 h-[18px] cursor-pointer transition-colors duration-150 ${
        inStockOnly.value ? 'bg-[var(--color-ink)]' : 'bg-[var(--color-card-border)]'
       }`}
      >
       <div
        class={`absolute top-[3px] w-3 h-3 bg-[var(--color-parchment)] transition-all duration-150 ${
         inStockOnly.value ? 'left-[17px]' : 'left-[3px]'
        }`}
       ></div>
      </div>
      </div>
      <span class="text-[13px] tracking-[1.5px] uppercase text-[var(--color-ink-muted)] font-heading">
       In stock only
      </span>
     </label>

     <span class="text-[var(--color-card-border)] text-xs">·</span>

     <span class="text-[13px] tracking-[0.5px] text-[var(--color-ink-soft)] font-body">
      {inStockOnly.value
       ? (
        <>
         Showing{' '}
         <span class="text-[var(--color-ink)]">{displayCount}</span>{' '}
         <span class="text-[var(--color-accent)]">in stock</span>
         {searchTerm.value && (
          <span class="text-[var(--color-ink-muted)]"> · "{searchTerm.value}"</span>
         )}
        </>
       ) : (
        <>
         Showing all{' '}
         <span class="text-[var(--color-ink)]">{displayCount}</span>
         {searchTerm.value && (
          <span class="text-[var(--color-ink-muted)]"> · "{searchTerm.value}"</span>
         )}
        </>
       )
      }
     </span>
    </div>
   </div>

   {/* ── PRODUCT GRID ── */}
   <div class="max-w-[1920px] mx-auto">
    {isSearching.value && displayProducts.length === 0 ? (
     /* Skeleton grid — only during API search */
     <div
      class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-px bg-[var(--color-card-border)]"
      style={{ contain: 'layout' }}
     >
      <ProductCard skeleton slug="" />
      <ProductCard skeleton slug="" />
      <div class="hidden md:block"><ProductCard skeleton slug="" /></div>
      <div class="hidden lg:block"><ProductCard skeleton slug="" /></div>
     </div>
    ) : displayProducts.length === 0 ? (
     /* Empty state */
     <div class="flex flex-col items-center justify-center py-32 text-center px-12">
      <div class="w-16 h-px bg-[var(--color-card-border)] mb-8"></div>
      <h3 class="font-heading font-normal text-2xl text-[var(--color-ink)] mb-3">
       No products found
      </h3>
      <p class="text-[13px] text-[var(--color-ink-muted)] mb-8 max-w-xs leading-loose tracking-wide">
       {searchTerm.value
        ? `Nothing matched "${searchTerm.value}".`
        : 'Nothing matches your current filters.'}
      </p>
      <button
       class="px-6 py-3 bg-[var(--color-ink)] text-[var(--color-ink-contrast)] text-[13px] tracking-[2.5px] uppercase font-heading cursor-pointer hover:bg-[var(--color-ink-hover)] transition-colors duration-150 min-h-[44px]"
       onClick$={() => {
        facetIds.value = [];
        searchTerm.value = '';
        state.facetValues = SHOP_FILTERS.map(facet => ({
         ...facet,
         values: facet.values.map(value => ({ ...value, selected: false })),
        }));
       }}
      >
       Clear filters
      </button>
     </div>
    ) : (
     <div
      class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-px bg-[var(--color-card-border)]"
      style={{ contain: 'layout' }}
     >
      {displayProducts.map((item, index) => (
       <ProductCard
        key={item.slug}
        href={productPath(item.slug)}
        image={item.image}
        name={item.name}
        slug={item.slug}
        price={item.pricingVariant?.price ?? item.minPrice}
        maxPrice={SHOP_PRICE_RANGE ? item.maxPrice ?? null : null}
        inStock={item.inStock}
        priority={index < 6}
        salePrice={item.pricingVariant?.salePrice ?? null}
        preOrderPrice={item.pricingVariant?.preOrderPrice ?? null}
        isPreOrder={!!item.pricingVariant?.isPreOrder}
       />
      ))}
     </div>
    )}
   </div>

  </div>
 );
});

export default hasView('route.shop') ? BrandShopMount : BaseShopPage;
