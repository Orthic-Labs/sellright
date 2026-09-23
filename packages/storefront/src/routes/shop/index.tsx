import { $, component$, useSignal, useStore, useTask$ } from '@qwik.dev/core';
import { routeLoader$ } from '@qwik.dev/router';
import ProductCard from '~/components/products/ProductCard';
import { searchQueryWithTerm } from '~/providers/shop/products/products';
import { FacetWithValues } from '~/types';
import Filters from '~/components/Filters';
import { loadBrowseCatalog } from '~/services/browse-catalog';
import { theme } from '~/theme/theme.config';
export { head, onStaticGenerate } from './seo';

// ── Catalog manifest loader (SSR) ──────────────────────────────
// Reads the pre-generated shop-catalog.json at SSR time.
// SellRight's opt-in publisher refreshes every minute. Stale/foreign snapshots
// fall back to the live API; stock is rechecked before checkout.
// Products are in the HTML on first byte — no client-side API call needed.
export const useCatalogLoader = routeLoader$(async ({ error }) => {
 try {
  const parsed = await loadBrowseCatalog();
  return { ...parsed, fallback: false };
 } catch {
  throw error(503, 'Catalog temporarily unavailable');
 }
});

// Category filter labels are generic and store-configurable (VITE_SHOP_CATEGORIES,
// comma-separated) — matched against product tags client-side. Neutral default
// is ['New', 'Bestsellers', 'Sale']; see src/theme/theme.config.ts.
const HARDCODED_SHOP_FILTERS: FacetWithValues[] = [
 {
  id: 'category',
  name: 'Category',
  open: true,
  values: theme.shopCategories.map((name, i) => ({ id: String(i + 1), name, selected: false })),
 },
];

// Map facet filter IDs to facet value names for client-side filtering
const FACET_ID_TO_NAME: Record<string, string> = Object.fromEntries(
 theme.shopCategories.map((name, i) => [String(i + 1), name]),
);

export default component$(() => {
 const catalog = useCatalogLoader();

 // Fallback API data (only used when manifest is missing or for text search)
 const apiData = useSignal<{ items: any[]; itemCustomFields?: any[]; totalItems: number } | null>(null);
 const isSearching = useSignal(false);
 const searchTerm = useSignal('');
 const facetIds = useSignal<string[]>([]);
 const inStockOnly = useSignal(true);
 // Overrides populated ONLY when the in-stock toggle is flipped — live backend check
 // at that exact moment. Never consulted at any other time.
 const liveStockOverride = useSignal<Record<string, boolean> | null>(null);

 const state = useStore<{
  showMenu: boolean;
  facetValues: FacetWithValues[];
 }>({
  showMenu: false,
  facetValues: HARDCODED_SHOP_FILTERS.map(facet => ({
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
    const result = await searchQueryWithTerm('', term, facetIds.value, 0, 200, inStockOnly.value);
    apiData.value = result as any;
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
  if (searchTerm.value && apiData.value?.items) {
   const filterName = FACET_ID_TO_NAME[facetIds.value[0]];
   const products = apiData.value.items.filter(item => (!inStockOnly.value || item.inStock) && (!filterName || item.facetValues?.some((value: any) => value.name === filterName)));
   return { products, count: products.length, fromApi: true };
  }

  // Use manifest data with client-side filtering.
  // If the in-stock toggle was flipped, the live override from that moment
  // supersedes the manifest's inStock value.
  const override = liveStockOverride.value;
  let products: any[] = (catalog.value.products || []).map((p: any) =>
   override && Object.prototype.hasOwnProperty.call(override, String(p.id))
    ? { ...p, inStock: override[String(p.id)] }
    : p,
  );

  // In-stock filter
  if (inStockOnly.value) {
   products = products.filter((p: any) => p.inStock);
  }

  // Category filter
  if (facetIds.value.length > 0) {
   const filterName = FACET_ID_TO_NAME[facetIds.value[0]];
   if (filterName) {
    products = products.filter((p: any) =>
     p.facetValues?.some((fv: any) => fv.name === filterName)
    );
   }
  }

  // Sort: in-stock first, then by manifest order (position)
  const sorted = [...products].sort((a: any, b: any) => {
   if (a.inStock && !b.inStock) return -1;
   if (!a.inStock && b.inStock) return 1;
   return 0; // Preserve manifest order within same stock status
  });

  return { products: sorted, count: sorted.length, fromApi: false };
 };

 const getCustomFieldsMap = () => {
  // For API data, use itemCustomFields
  if (apiData.value?.itemCustomFields) {
   return new Map<string, any>(
    (apiData.value.itemCustomFields as any[]).map((cf: any) => [String(cf.productVariantId), cf])
   );
  }
  return new Map<string, any>();
 };

 const onFilterChange = $((id: string) => {
  if (id === 'CLEAR_ALL') {
   facetIds.value = [];
  } else {
   facetIds.value = [id];
  }
  // Update filter UI selected state
  state.facetValues = HARDCODED_SHOP_FILTERS.map(facet => ({
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

 // Toggling the stock filter refreshes availability from SellRight.
 const onInStockChange = $(async (inStock: boolean) => {
  inStockOnly.value = inStock;
  try {
   isSearching.value = true;
   const liveSearch = await searchQueryWithTerm('', searchTerm.value, facetIds.value, 0, 500, undefined);
   const override: Record<string, boolean> = {};
   for (const item of ((liveSearch as any)?.items || [])) {
    override[String(item.productId)] = Boolean(item.inStock);
   }
   liveStockOverride.value = override;
  } catch (err) {
   console.error('[shop] Live stock recheck on toggle failed:', err);
  } finally {
   isSearching.value = false;
  }
 });

 const displayData = getDisplayProducts();
 const displayProducts = displayData.products;
 const displayCount = displayData.count;
 const isFromApi = displayData.fromApi;

 return (
  <div class="bg-[var(--color-parchment)] min-h-screen">

   {/* ── PAGE HEADING (visually subtle, semantically correct) ── */}
   <h1 class="sr-only">Shop All Products</h1>

   {/* ── FILTERS BAR ── */}
   <div class="border-b border-[var(--color-card-border)] bg-[var(--color-parchment)]">
    <div class="max-w-[1920px] mx-auto px-4 sm:px-8 lg:px-12 py-4">
     <Filters
      facetsWithValues={state.facetValues}
      facetValueIds={facetIds.value}
      onFilterChange$={onFilterChange}
      searchTerm={searchTerm.value}
      onSearchChange$={onSearchChange}
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
      <ProductCard skeleton />
      <ProductCard skeleton />
      <div class="hidden md:block"><ProductCard skeleton /></div>
      <div class="hidden lg:block"><ProductCard skeleton /></div>
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
        state.facetValues = HARDCODED_SHOP_FILTERS.map(facet => ({
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
      {(() => {
       const cfMap = isFromApi ? getCustomFieldsMap() : null;
       return displayProducts.map((item: any, index: number) => {
        // For manifest data, use product-level customFields
        // For API data, use itemCustomFields map
        const cf = isFromApi
         ? cfMap?.get(String(item.productVariantId))
         : item.customFields;

        const productAsset = isFromApi
         ? item.productAsset
         : item.featuredAsset
          ? { id: item.id, preview: item.featuredAsset.preview }
          : null;

        const priceWithTax = isFromApi
         ? item.priceWithTax
         : item.priceRange;

        return (
         <ProductCard
          key={isFromApi ? item.productId : item.id}
          productAsset={productAsset}
          productName={isFromApi ? item.productName : item.name}
          slug={item.slug}
          priceWithTax={priceWithTax}
          inStock={isFromApi ? item.inStock : item.inStock}
          productId={isFromApi ? item.productId : item.id}
          priority={index < 6}
          salePrice={cf?.salePrice ?? null}
          preOrderPrice={cf?.preOrderPrice ?? null}
          isPreOrder={!!cf?.isPreOrder}
         />
        );
       });
      })()}
     </div>
    )}
   </div>

  </div>
 );
});
