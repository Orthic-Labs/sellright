// Brand views PR2 §10: the branded shop page: the listing (manifest on load; the in-stock toggle is its only live listing read,
// moved from routes/shop/index.tsx) and the configurator over routes.json shop.detailProducts.
import { $, component$, useSignal, useStore, useVisibleTask$, type ReadonlySignal } from '@qwik.dev/core';
import { useStoreIdentityLoader } from '~/routes/layout';
import { useConfiguratorDetail } from '~/platform/configurator-detail';
import { ShopView, platformAction } from '~/platform/gateway';
import { searchProducts } from '~/providers/shop/products/products';
import type { ActionResult, PublicIdentity, ShopListingItem, ShopViewData } from '~/platform/views';
import { ACTION_RESULTS, dispatch, type ActionCtl } from './callbacks';
import { useConfigurator, type ConfiguratorLoaderValue } from './configurator';
import { useShopListingOnLoad } from '~/platform/stock-triggers';
import { projectIdentity, seal } from './project';

/** The listing with the live override from the toggle applied (the override exists only after a toggle in this view). */
export function applyOverride(listing: readonly ShopListingItem[], override: Record<string, boolean> | null): ShopListingItem[] {
	return listing.map((item) => ({
		...item,
		availability: override && Object.prototype.hasOwnProperty.call(override, item.slug) ? (override[item.slug] ? 'in-stock' : 'out-of-stock') : item.availability,
	}));
}

/** The in-stock toggle's live read: every listed product's live `inStock` (only an explicit true counts). */
export async function liveListingOverride(search = searchProducts): Promise<Record<string, boolean>> {
	const live = await search({ take: 500 });
	const out: Record<string, boolean> = {};
	for (const item of live.items) out[item.slug] = item.inStock === true;
	return out;
}

export const BrandShopMount = component$(() => {
	const identity = useStoreIdentityLoader();
	const detail = useConfiguratorDetail();
	const c = useConfigurator(detail as ReadonlySignal<ConfiguratorLoaderValue>, 'shop');
	const inStockOnly = useSignal(true);
	const override = useSignal<Record<string, boolean> | null>(null);
	const listCtl = useStore<ActionCtl>({ disposed: false, admitted: [] });
	useVisibleTask$(({ cleanup }) => cleanup(() => { listCtl.disposed = true; }));

	// shop.stockOnLoad = live (Rotten, owner decision O1): one live listing read per view on load, as the toggle does.
	useShopListingOnLoad(
		$(async () => {
			try {
				override.value = await liveListingOverride();
			} catch (err) {
				console.error('[shop] Live stock read on load failed:', err);
			}
		}),
	);

	const onInStockChange$ = $((inStock: boolean) =>
		dispatch<ActionResult>(listCtl, 'listing', ACTION_RESULTS, async () => {
			if (typeof inStock !== 'boolean') return { ok: false, reason: 'invalid' };
			inStockOnly.value = inStock;
			try {
				override.value = await liveListingOverride();
				return { ok: true };
			} catch (err) {
				console.error('[shop] Live stock recheck on toggle failed:', err);
				return { ok: false, reason: 'error' };
			}
		}),
	);

	// Built in the render body, field by field (no nested computed: see useConfigurator `project`).
	const d = detail.value;
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
