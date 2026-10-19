import { $, component$, useStore, useTask$ } from '@qwik.dev/core';
import { routeLoader$, useLocation, routeAction$, zod$, z } from '@qwik.dev/router';
import { SearchFilters as Filters, FiltersButton, ProductCard, platformAction } from '~/platform/gateway';
import { searchProducts } from '~/providers/shop/products/products';
import type { CatalogListResponse } from '~/sellright/types/catalog';
import { FacetWithValues } from '~/types';
import { createSEOHead } from '~/utils/seo';
import { projectFacets } from '~/platform/controllers/project';
import { productPath } from '~/platform/product-path';
import { shopCategoryFilters } from '~/theme/theme.config';
import { searchByCategories } from './categories';
import { categoryFacets } from '~/config/shop-categories';

// Resolve the shop's stable configured category IDs against native tags.
export const executeQuery = $(
	async (term: string, facetIds: string[] = []): Promise<CatalogListResponse> =>
		searchByCategories(term, facetIds, shopCategoryFilters, searchProducts)
);

export const useSearchLoader = routeLoader$(async ({ query }) => {
	const term = query.get('q') || '';
	const search = await executeQuery(term, query.get('f')?.split('-') || []);
	return { search, query };
}, {
	// Qwik Router 2.0.0-rc: loaders only see allow-listed search params.
	search: ['q', 'f'],
});

// SSR-friendly search action
export const useSearchAction = routeAction$(async (data, { redirect }) => {
	const term = data.term || '';
	const facetIds = data.facetIds || '';

	// Build query parameters
	const params = new URLSearchParams();
	if (term) params.set('q', term);
	if (facetIds) params.set('f', facetIds);

	// Redirect to maintain SSR
	const queryString = params.toString();
	throw redirect(302, `/search${queryString ? `?${queryString}` : ''}`);
}, zod$({
	term: z.string().optional(),
	facetIds: z.string().optional()
}));

export default component$(() => {
	const { url } = useLocation();
	const searchLoader = useSearchLoader();
	const searchAction = useSearchAction();

	const term = url.searchParams.get('q') || '';

	const state = useStore<{
		showMenu: boolean;
		search: CatalogListResponse;
		facetValues: FacetWithValues[];
		facetValueIds: string[];
	}>({
		showMenu: false,
		search: searchLoader.value.search,
		facetValues: categoryFacets(shopCategoryFilters, searchLoader.value.query.get('f')?.split('-') || []),
		facetValueIds: searchLoader.value.query.get('f')?.split('-') || [],
	});

	// The route loader handles both q-only and f-only navigation. Reuse its
	// result so resumed pages do not issue a second, potentially stale search.
	useTask$(({ track }) => {
		const loaded = track(() => searchLoader.value);
		const ids = loaded.query.get('f')?.split('-') || [];
		const open = state.facetValues[0]?.open ?? true;
		state.search = loaded.search;
		state.facetValueIds = ids;
		state.facetValues = categoryFacets(shopCategoryFilters, ids);
		state.facetValues[0].open = open;
	});

	const onFilterChange = $(async (id: string) => {
		const newFacetValueIds = state.facetValueIds.includes(id)
			? state.facetValueIds.filter((f) => f !== id)
			: [...state.facetValueIds, id];

		// Use action for SSR-friendly navigation
		await searchAction.submit({
			term,
			facetIds: newFacetValueIds.join('-')
		});
	});

	const onOpenCloseFilter = $((id: string) => {
		state.facetValues = state.facetValues.map((f) => {
			if (f.id === id) {
				f.open = !f.open;
			}
			return f;
		});
	});

	return (
		<div
			class="max-w-6xl mx-auto px-4 py-10"
			onKeyDown$={(event: KeyboardEvent) => {
				if (event.key === 'Escape') {
					state.showMenu = false;
				}
			}}
		>
			<div class="flex justify-between items-center">
				<h2 class="text-3xl sm:text-5xl font-light tracking-tight text-gray-900 my-8">
					{term ? `Results for"${term}"` : 'All filtered results'}
				</h2>
				{!!state.facetValues.length && (
					<FiltersButton
						onToggleMenu$={platformAction('ui.press', $(async () => {
							state.showMenu = !state.showMenu;
						}))}
					/>
				)}
			</div>

			<div class="mt-6 grid sm:grid-cols-5 gap-x-4">
				{!!state.facetValues.length && (
					<Filters
						showMenu={state.showMenu}
						facetsWithValues={projectFacets(state.facetValues)}
						onToggleMenu$={platformAction('ui.press', $(async () => {
							state.showMenu = !state.showMenu;
						}))}
						onFilterChange$={platformAction('filters.value', onFilterChange)}
						onOpenCloseFilter$={platformAction('filters.value', onOpenCloseFilter)}
					/>
				)}
				<div class={state.facetValues.length ? 'sm:col-span-5 lg:col-span-4' : 'sm:col-span-5'}>
					<div class="grid grid-cols-1 gap-y-10 gap-x-6 sm:grid-cols-2 lg:grid-cols-4 xl:gap-x-8">
						{(state.search.items || []).map((item) => (
							<ProductCard
						key={item.slug}
						href={productPath(item.slug)}
						image={item.image}
						name={item.name}
						slug={item.slug}
						price={item.pricingVariant?.price ?? item.minPrice}
						inStock={item.inStock}
						salePrice={item.pricingVariant?.salePrice ?? null}
						preOrderPrice={item.pricingVariant?.preOrderPrice ?? null}
						isPreOrder={!!item.pricingVariant?.isPreOrder}
					></ProductCard>
						))}
					</div>
				</div>
			</div>
		</div>
	);
});

export const head = ({ url }: { url: URL }) => {
	const searchTerm = url.searchParams.get('q') || '';
	const isEmpty = !searchTerm;
	return createSEOHead({
		title: isEmpty ? 'Search' : `Search results for "${searchTerm}"`,
		description: isEmpty
			? 'Search our full product collection.'
			: `Results for "${searchTerm}" in our product collection.`,
		noindex: true,
	});
};
