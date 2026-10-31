// Brand views PR2 §10: the branded shop page: the listing (manifest on load; the in-stock toggle is its only live listing read,
// moved from routes/shop/index.tsx) and the configurator over routes.json shop.detailProducts.
import { $, component$, useComputed$, useSignal, useStore, useTask$, useVisibleTask$, type ReadonlySignal } from '@qwik.dev/core';
import { useLocation } from '@qwik.dev/router';
import { useLiveRead } from '~/platform/live-values';
import { hasPendingValues, pickLiveSource } from './configurator-model';
import { useStoreIdentityLoader } from '~/routes/layout';
import { readConfiguratorDetail, useConfiguratorDetail, type ConfiguratorDetail } from '~/platform/configurator-detail';
import { ShopView, platformAction } from '~/platform/gateway';
import { searchProducts } from '~/providers/shop/products/products';
import type { ActionResult, PublicIdentity, ShopListingItem, ShopViewData } from '~/platform/views';
import { ACTION_RESULTS, dispatch, type ActionCtl } from './callbacks';
import { useConfigurator, type ConfiguratorLoaderValue } from './configurator';
import { useShopListingOnLoad } from '~/platform/stock-triggers';
import { liveListingAvailability, readLiveListing } from '~/platform/listing-availability';
import { projectIdentity, seal } from './project';

/** The listing with the live override from the toggle applied (the override exists only after a toggle in this view). */
export function applyOverride(listing: readonly ShopListingItem[], override: Record<string, boolean> | null): ShopListingItem[] {
	return listing.map((item) => ({
		...item,
		availability: override && Object.prototype.hasOwnProperty.call(override, item.slug) ? (override[item.slug] ? 'in-stock' : 'out-of-stock') : item.availability,
	}));
}

/** The listing's live read: fail closed for every listed slug (platform/listing-availability.ts); a failed read is all out of stock. */
export async function liveListingOverride(listedSlugs: readonly string[], search = searchProducts): Promise<{ override: Record<string, boolean>; ok: boolean }> {
	const live = await readLiveListing((p) => search(p));
	if (live === null) console.error('[shop] Live stock read failed');
	return { override: liveListingAvailability(listedSlugs, live), ok: live !== null };
}

export const BrandShopMount = component$(() => {
	const identity = useStoreIdentityLoader();
	const detail = useConfiguratorDetail();
	const location = useLocation();
	// ADR-0001 §2: a shell detail (no listing, prices pending) is read in the browser on load from the manifest, no-store (LOCKED layer 2:
	// still the manifest on load; the in-stock toggle stays the live API hit).
	const liveKey = useComputed$(() => (hasPendingValues(detail.value, 'shop') ? location.url.pathname : null));
	const live = useLiveRead<ConfiguratorDetail>($(() => readConfiguratorDetail()), liveKey);
	const c = useConfigurator(detail as ReadonlySignal<ConfiguratorLoaderValue>, 'shop', live);
	const inStockOnly = useSignal(true);
	const override = useSignal<Record<string, boolean> | null>(null);
	const listCtl = useStore<ActionCtl>({ disposed: false, admitted: [] });
	useVisibleTask$(({ cleanup }) => cleanup(() => { listCtl.disposed = true; }));

	// One request generation for the automatic read and the toggle: only the latest response applies.
	const listingGen = useSignal(0);
	// The listed slugs as plain data, taken at render: the read never touches the loader signal from inside an event handler.
	const listed = useStore<{ slugs: string[] }>({ slugs: (detail.value?.listing ?? []).map((item) => item.slug) });
	// A new loader value (SPA navigation) or the browser's listing read re-takes the slugs.
	useTask$(({ track }) => {
		const d = pickLiveSource(track(() => detail.value), track(() => live.value), 'shop');
		listed.slugs = (d?.listing ?? []).map((item) => item.slug);
	});
	const readListing = $(async (): Promise<boolean> => {
		const gen = ++listingGen.value;
		const slugs = [...listed.slugs];
		const { override: next, ok } = await liveListingOverride(slugs);
		if (gen === listingGen.value && !listCtl.disposed) override.value = next;
		return ok;
	});

	// shop.stockOnLoad = live (Rotten, owner decision O1): one live listing read per view on load, as the toggle does.
	useShopListingOnLoad(readListing);

	const onInStockChange$ = $((inStock: boolean) =>
		dispatch<ActionResult>(listCtl, 'listing', ACTION_RESULTS, async () => {
			if (typeof inStock !== 'boolean') return { ok: false, reason: 'invalid' };
			inStockOnly.value = inStock;
			return (await readListing()) ? { ok: true } : { ok: false, reason: 'error' };
		}),
	);

	// Built in the render body, field by field (no nested computed: see useConfigurator `project`).
	const d = pickLiveSource(detail.value, live.value, 'shop');
	const v = c.project();
	const data = seal<ShopViewData>({
		identity: projectIdentity(identity.value.identity) as PublicIdentity,
		listing: applyOverride(d?.listing ?? [], override.value),
		inStockOnly: inStockOnly.value,
		detail: v.products,
		detailStatus: d?.detailStatus ?? 'unavailable',
		selection: v.selection,
		purchase: v.purchase,
	});
	return (
		<ShopView
			{...data}
			onProductSelect$={platformAction('configurator.product-select', c.onProductSelect$)}
			onOptionSelect$={platformAction('configurator.option-select', c.onOptionSelect$)}
			onQuantityChange$={platformAction('configurator.quantity', c.onQuantityChange$)}
			onConsentChange$={platformAction('configurator.consent', c.onConsentChange$)}
			onAddToCart$={platformAction('configurator.add', c.onAddToCart$)}
			onRetryStock$={platformAction('configurator.retry-stock', c.onRetryStock$)}
			onInStockChange$={platformAction('shop.in-stock', onInStockChange$)}
		/>
	);
});
