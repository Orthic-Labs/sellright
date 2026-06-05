import { $, component$, useSignal, useStore, useTask$ } from '@qwik.dev/core';
import { routeLoader$ } from '@qwik.dev/router';
import ProductCard from '~/components/products/ProductCard';
import { searchQueryWithTerm } from '~/providers/shop/products/products';
import { FacetWithValues } from '~/types';
import { createSEOHead } from '~/utils/seo';
import { generateBreadcrumbSchema } from '~/services/seo-api.service';
import Filters from '~/components/Filters';

// ── Catalog manifest loader (SSR) ──────────────────────────────
// Reads the pre-generated shop-catalog.json at SSR time.
// Manifest is regenerated on every StockMovementEvent (zero debounce on the
// admin side), so manifest.inStock is always current to the second.
// Products are in the HTML on first byte — no client-side API call needed.
export const useCatalogLoader = routeLoader$(async () => {
 try {
  const { readFile } = await import('node:fs/promises');
  const CATALOG_DIR = process.env.CATALOG_DIR || '/home/vendure/sites/damned/data';
  const raw = await readFile(`${CATALOG_DIR}/shop-catalog.json`, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.products)) {
   throw new Error(`Invalid manifest: products=${typeof parsed.products}`);
  }
  return { ...parsed, fallback: false };
 } catch (e: any) {
  if (e?.code === 'ENOENT') {
   console.warn('[catalog] Manifest not found, using API fallback');
  } else {
   console.error('[catalog] Failed to read/parse manifest:', e);
  }
  return { totalItems: 0, products: [], fallback: true };
 }
});

const HARDCODED_SHOP_FILTERS: FacetWithValues[] = [
 {
  id: 'category',
  name: 'Category',
  open: true,
  values: [
   { id: '1', name: 'folding knives', selected: false },
   { id: '3', name: 'fixed blades', selected: false },
   { id: '5', name: 'edc', selected: false },
   { id: '2', name: 'osiris chef knives', selected: false },
   { id: '6', name: 'fidget', selected: false },
   { id: '4', name: 'apparel', selected: false },
  ],
 },
];

// Map facet filter IDs to facet value names for client-side filtering
const FACET_ID_TO_NAME: Record<string, string> = {
 '1': 'folding knives',
 '3': 'fixed blades',
 '5': 'edc',
 '2': 'osiris chef knives',
 '6': 'fidget',
 '4': 'apparel',
};

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

 // Manifest fallback — if no manifest, fetch all products from API once
 useTask$(async () => {
  if (typeof document === 'undefined') return;
  if (catalog.value.fallback) {
   isSearching.value = true;
   try {
    const result = await searchQueryWithTerm('', '', [], 0, 200, true);
    apiData.value = result as any;
   } catch (err) {
    console.error('Shop fallback fetch failed:', err);
   } finally {
    isSearching.value = false;
   }
  }
 });

 const getDisplayProducts = () => {
  // If text search is active, use API data
  if (searchTerm.value && apiData.value?.items) {
   return { products: apiData.value.items, count: apiData.value.items.length, fromApi: true };
  }

  // If manifest fallback mode, use API data
  if (catalog.value.fallback && apiData.value?.items) {
   return { products: apiData.value.items, count: apiData.value.items.length, fromApi: true };
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

 // Toggling the in-stock filter triggers a live stock recheck from the backend —
 // the only place the shop page hits the API. Every other render uses the manifest,
 // which is live-updated on StockMovementEvent on the admin side.
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
  <div class="bg-[#F7F2EA] min-h-screen">

   {/* ── PAGE HEADING (visually subtle, semantically correct) ── */}
   <h1 class="sr-only">Shop All Premium Knives & Tools</h1>

   {/* ── FILTERS BAR ── */}
   <div class="border-b border-[#e4e2dc] bg-[#F7F2EA]">
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
   <div class="border-b border-[#e4e2dc] bg-[#F7F2EA]">
    <div class="max-w-[1920px] mx-auto px-4 sm:px-8 lg:px-12 py-3 flex items-center gap-4">
     <label class="flex items-center gap-2 cursor-pointer select-none">
      <div class="min-h-[48px] min-w-[48px] flex items-center justify-center flex-shrink-0" onClick$={() => onInStockChange(!inStockOnly.value)}>
      <div
       class={`relative w-8 h-[18px] cursor-pointer transition-colors duration-150 ${
        inStockOnly.value ? 'bg-[#111110]' : 'bg-[#e4e2dc]'
       }`}
      >
       <div
        class={`absolute top-[3px] w-3 h-3 bg-[#F7F2EA] transition-all duration-150 ${
         inStockOnly.value ? 'left-[17px]' : 'left-[3px]'
        }`}
       ></div>
      </div>
      </div>
      <span class="text-[13px] tracking-[1.5px] uppercase text-[#adadaa] font-heading">
       In stock only
      </span>
     </label>

     <span class="text-[#e4e2dc] text-xs">·</span>

     <span class="text-[13px] tracking-[0.5px] text-[#6b6b68] font-body">
      {inStockOnly.value
       ? (
        <>
         Showing{' '}
         <span class="text-[#111110]">{displayCount}</span>{' '}
         <span class="text-[#965341]">in stock</span>
         {searchTerm.value && (
          <span class="text-[#adadaa]"> · "{searchTerm.value}"</span>
         )}
        </>
       ) : (
        <>
         Showing all{' '}
         <span class="text-[#111110]">{displayCount}</span>
         {searchTerm.value && (
          <span class="text-[#adadaa]"> · "{searchTerm.value}"</span>
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
      class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-px bg-[#e4e2dc]"
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
      <div class="w-16 h-px bg-[#e4e2dc] mb-8"></div>
      <h3 class="font-heading font-normal text-2xl text-[#111110] mb-3">
       No products found
      </h3>
      <p class="text-[13px] text-[#adadaa] mb-8 max-w-xs leading-loose tracking-wide">
       {searchTerm.value
        ? `Nothing matched "${searchTerm.value}".`
        : 'Nothing matches your current filters.'}
      </p>
      <button
       class="px-6 py-3 bg-[#111110] text-[#fafaf8] text-[13px] tracking-[2.5px] uppercase font-heading cursor-pointer hover:bg-[#2a2926] transition-colors duration-150 min-h-[44px]"
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
      class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-px bg-[#e4e2dc]"
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

export const head = ({ url }: { url: URL }) => {
 const searchTerm = url.searchParams.get('q') || '';

 const breadcrumbSchema = generateBreadcrumbSchema([
  { name: 'Home', url: 'https://www.damneddesigns.com/' },
  { name: searchTerm ? `Search: ${searchTerm}` : 'Shop', url: `https://www.damneddesigns.com/shop` },
 ]);

 return createSEOHead({
  title: searchTerm ? `Search results for "${searchTerm}"` : 'Shop All Premium Knives & Tools',
  description: searchTerm
   ? `Find products matching "${searchTerm}" in our premium collection of handcrafted knives and tools.`
   : 'Browse our complete collection of premium handcrafted knives and everyday carry tools. Find the perfect blade for collectors and professionals.',
  canonical: 'https://www.damneddesigns.com/shop/',
  ogUrl: 'https://www.damneddesigns.com/shop/',
  noindex: !!searchTerm,
  schemas: [
   breadcrumbSchema,
   ...(!searchTerm ? [{
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Shop All Premium Knives & Tools',
    url: 'https://www.damneddesigns.com/shop',
    description: 'Browse our complete collection of premium handcrafted knives and everyday carry tools.',
   }] : []),
  ],
 });
};

import type { StaticGenerateHandler } from '@qwik.dev/router';
export const onStaticGenerate: StaticGenerateHandler = () => {
 return { params: [] };
};
