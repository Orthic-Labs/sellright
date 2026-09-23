import { component$, QRL, useSignal } from '@qwik.dev/core';
import { FacetWithValues } from '~/types';

interface FiltersProps {
 facetsWithValues: FacetWithValues[];
 facetValueIds: string[];
 onFilterChange$: QRL<(id: string) => void>;
 searchTerm?: string;
 onSearchChange$?: QRL<(term: string) => void>;
 productCounts?: { [key: string]: number };
}

export default component$<FiltersProps>(({ facetsWithValues, facetValueIds, onFilterChange$, searchTerm, onSearchChange$, productCounts }) => {
 if (!facetsWithValues.length) return null;
 const noFiltersActive = facetValueIds.length === 0;
 const mobileSearchOpen = useSignal(false);

 return (
  <div class="flex flex-wrap gap-1.5 items-center w-full max-w-none min-w-0">
   {/* All Products pill */}
   <button
    type="button"
    class={`px-4 py-2.5 text-[13px] font-normal tracking-[2px] uppercase border cursor-pointer transition-all duration-150 font-heading whitespace-nowrap min-h-[44px] ${
     noFiltersActive
      ? 'bg-[var(--color-ink)] text-[var(--color-ink-contrast)] border-[var(--color-ink)]'
      : 'bg-transparent text-[var(--color-ink-soft)] border-[var(--color-card-border)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]'
    }`}
    onClick$={() => {
     onFilterChange$('CLEAR_ALL');
    }}
   >
    All
   </button>

   {facetsWithValues.flatMap(facet =>
    facet.values.map(value => {
     return (
     <button
      key={value.id}
      type="button"
      class={`px-4 py-2.5 text-[13px] font-normal tracking-[2px] uppercase border cursor-pointer transition-all duration-150 font-heading whitespace-nowrap min-h-[44px] ${
       value.selected
        ? 'bg-[var(--color-ink)] text-[var(--color-ink-contrast)] border-[var(--color-ink)]'
        : 'bg-transparent text-[var(--color-ink-soft)] border-[var(--color-card-border)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]'
      }`}
      onClick$={() => {
       onFilterChange$(value.id);
      }}
      title={value.name}
     >
      <span class="flex items-center justify-center gap-1.5">
       <span>{value.name}</span>
       {productCounts && productCounts[value.id] !== undefined && (
        <span
         class={`text-[10px] font-medium px-1.5 py-0.5 ${
          value.selected
           ? 'bg-white/15 text-white/70'
           : 'bg-[var(--color-card-border)] text-[var(--color-ink-muted)]'
         }`}
        >
         {productCounts[value.id]}
        </span>
       )}
      </span>
     </button>
    );})
   )}

   {/* Search — desktop: full bar, mobile: icon that expands */}
   {onSearchChange$ && (
    <>
     {/* Desktop search bar */}
     <div class="ml-auto hidden md:flex items-center border border-[var(--color-card-border)] bg-transparent overflow-hidden hover:border-[var(--color-ink)] transition-colors duration-150 focus-within:border-[var(--color-ink)]">
      <input
       type="text"
       value={searchTerm || ''}
       placeholder="Search…"
       class="px-3 py-2.5 text-[13px] font-light tracking-[0.5px] bg-transparent placeholder-[var(--color-ink-muted)] text-[var(--color-ink-soft)] focus:outline-none border-0 font-body"
       style={{ minWidth: '100px', maxWidth: '140px' }}
       onInput$={(event) => {
        const target = event.target as HTMLInputElement;
        onSearchChange$(target.value);
       }}
      />
      <button
       type="button"
       class={`flex items-center justify-center px-3 py-2.5 min-w-[44px] min-h-[44px] border-l border-[var(--color-card-border)] cursor-pointer transition-colors duration-150 focus:outline-none ${
        searchTerm ? 'bg-[var(--color-ink)]' : 'bg-transparent hover:bg-[#f6f5f1]'
       }`}
       onClick$={() => searchTerm ? onSearchChange$('') : undefined}
       tabIndex={-1}
       aria-label={searchTerm ? 'Clear search' : 'Search'}
      >
       {!searchTerm && (
        <svg class="h-4 w-4 text-[var(--color-ink-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
         <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
       )}
       {searchTerm && (
        <svg class="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
         <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
       )}
      </button>
     </div>

     {/* Mobile search — icon toggle */}
     <div class="ml-auto md:hidden flex items-center">
      {!mobileSearchOpen.value && !searchTerm ? (
       <button
        type="button"
        class="flex items-center justify-center min-w-[44px] min-h-[44px] border border-[var(--color-card-border)] cursor-pointer hover:border-[var(--color-ink)] transition-colors duration-150"
        onClick$={() => { mobileSearchOpen.value = true; }}
        aria-label="Search"
       >
        <svg class="h-4 w-4 text-[var(--color-ink-soft)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
         <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
       </button>
      ) : (
       <div class="flex items-center border border-[var(--color-ink)] bg-transparent overflow-hidden">
        <input
         type="text"
         value={searchTerm || ''}
         placeholder="Search…"
         class="px-3 py-2.5 text-[14px] font-light bg-transparent placeholder-[var(--color-ink-muted)] text-[var(--color-ink-soft)] focus:outline-none border-0 font-body w-[140px]"
         onInput$={(event) => {
          const target = event.target as HTMLInputElement;
          onSearchChange$(target.value);
         }}
        />
        <button
         type="button"
         class="flex items-center justify-center min-w-[44px] min-h-[44px] border-l border-[var(--color-card-border)] cursor-pointer bg-[var(--color-ink)]"
         onClick$={() => {
          if (searchTerm) onSearchChange$('');
          mobileSearchOpen.value = false;
         }}
         aria-label="Close search"
        >
         <svg class="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
         </svg>
        </button>
       </div>
      )}
     </div>
    </>
   )}
  </div>
 );
});
