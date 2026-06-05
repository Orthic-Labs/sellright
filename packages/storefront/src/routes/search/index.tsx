import { $, component$, useStore, useTask$ } from '@qwik.dev/core';
import { routeLoader$, useLocation, routeAction$, zod$, z } from '@qwik.dev/router';
import Filters from '~/components/facet-filter-controls/Filters';
import FiltersButton from '~/components/filters-button/FiltersButton';
import ProductCard from '~/components/products/ProductCard';
import { SearchResponse } from '~/generated/graphql-shop';
import { searchQueryWithTerm } from '~/providers/shop/products/products';
import { FacetWithValues } from '~/types';
import { groupFacetValues } from '~/utils';
import { createSEOHead } from '~/utils/seo';

export const executeQuery = $(
	async (term: string, activeFacetValueIds: string[]) =>
		await searchQueryWithTerm('', term, activeFacetValueIds)
);

export const useSearchLoader = routeLoader$(async ({ query }) => {
	const term = query.get('q') || '';
	const activeFacetValueIds: string[] = query.get('f')?.split('-') || [];
	const search = await executeQuery(term, activeFacetValueIds);
	return { search, query };
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
		search: SearchResponse;
		facetValues: FacetWithValues[];
		facetValueIds: string[];
	}>({
		showMenu: false,
		search: searchLoader.value.search,
		facetValues: groupFacetValues(searchLoader.value.search, searchLoader.value.query.get('f')?.split('-') || []),
		facetValueIds: searchLoader.value.query.get('f')?.split('-') || [],
	});

	// Only update on URL changes (SSR-friendly)
	useTask$(async ({ track }) => {
		track(() => searchLoader.value.query);

		const term = searchLoader.value.query.get('q') || '';
		const activeFacetValueIds: string[] = searchLoader.value.query.get('f')?.split('-') || [];

		// Only update if data has changed
		if (JSON.stringify(state.facetValueIds) !== JSON.stringify(activeFacetValueIds)) {
			state.search = await executeQuery(term, activeFacetValueIds);
			state.facetValues = groupFacetValues(state.search, activeFacetValueIds);
			state.facetValueIds = activeFacetValueIds;
		}
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
						onToggleMenu$={async () => {
							state.showMenu = !state.showMenu;
						}}
					/>
				)}
			</div>

			<div class="mt-6 grid sm:grid-cols-5 gap-x-4">
				{!!state.facetValues.length && (
					<Filters
						showMenu={state.showMenu}
						facetsWithValues={state.facetValues}
						onToggleMenu$={async () => {
							state.showMenu = !state.showMenu;
						}}
						onFilterChange$={onFilterChange}
						onOpenCloseFilter$={onOpenCloseFilter}
					/>
				)}
				<div class="sm:col-span-5 lg:col-span-4">
					<div class="grid grid-cols-1 gap-y-10 gap-x-6 sm:grid-cols-2 lg:grid-cols-4 xl:gap-x-8">
						{(state.search.items || []).map((item) => (
							<ProductCard
						key={item.productId}
						productAsset={item.productAsset}
						productName={item.productName}
						slug={item.slug}
						priceWithTax={item.priceWithTax}
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
			? 'Search our collection of premium knives and tools.'
			: `Results for "${searchTerm}" in our premium knife and tool collection.`,
		noindex: true,
	});
};
