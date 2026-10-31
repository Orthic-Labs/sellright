// Brand views PR2 §6, §10: the branded product page. `BrandProductMount` is a switch with no hooks of its own beyond the loader read:
// a missing product renders `ProductMissingView` (no controller, no stock read, no view_item; the loader already set the 404 status),
// a found one mounts the configurator.
import { $, component$, useComputed$, type ReadonlySignal } from '@qwik.dev/core';
import { useLiveReadStart, useLiveReadState } from '~/platform/live-values';
import { hasPendingValues } from './configurator-model';
import { fillLiveOffers } from './jsonld-offers';
import { useStoreIdentityLoader } from '~/routes/layout';
import { useBrandProductDetail, type BrandProductDetail } from '~/platform/product-detail';
import { readBrandProductLive } from '~/platform/product-live';
import { ProductMissingView, ProductView, platformAction } from '~/platform/gateway';
import type { ProductFoundData, PublicIdentity } from '~/platform/views';
import { useConfigurator, type ConfiguratorLoaderValue } from './configurator';
import { projectIdentity, seal } from './project';

export const ProductMissingMount = component$(() => {
	const identity = useStoreIdentityLoader();
	const data = useComputed$(() => seal({ identity: projectIdentity(identity.value.identity) as PublicIdentity, state: 'missing' as const, shopHref: '/shop/' }));
	return <ProductMissingView {...data.value} />;
});

export const ProductFoundMount = component$(() => {
	const identity = useStoreIdentityLoader();
	const detail = useBrandProductDetail();
	// ADR-0001: a shell detail (prices pending) is read again in the browser on load, no-store; the configurator sells from it once it lands.
	const liveKey = useComputed$(() => {
		const d = detail.value;
		return d && d.state === 'found' && hasPendingValues(d, 'product') ? d.product.slug : null;
	});
	// Lane 11: the configurator registers the LOCKED live stock read's document handler first; the live values read (prices and the
	// JSON-LD offers in ONE request, low priority) registers after it, so the stock read is the first request this page starts.
	const live = useLiveReadState<BrandProductDetail>();
	const c = useConfigurator(detail as ReadonlySignal<ConfiguratorLoaderValue>, 'product', live);
	useLiveReadStart<BrandProductDetail>(live, $(async () => {
		const values = await readBrandProductLive(liveKey.value ?? '');
		fillLiveOffers(values?.offers);
		return values?.detail ?? null;
	}), liveKey);
	// Built in the render body, field by field (no nested computed: see useConfigurator `project`).
	const d = detail.value;
	const v = c.project();
	const data = seal<ProductFoundData>({
		identity: projectIdentity(identity.value.identity) as PublicIdentity,
		state: 'found',
		product: v.products[0],
		siblings: v.siblings,
		selection: v.selection,
		purchase: v.purchase,
		breadcrumbs: d && d.state === 'found' ? d.breadcrumbs.map((b) => ({ name: b.name, href: b.href })) : [],
	});
	return (
		<ProductView
			{...data}
			onOptionSelect$={platformAction('configurator.option-select', c.onOptionSelect$)}
			onQuantityChange$={platformAction('configurator.quantity', c.onQuantityChange$)}
			onConsentChange$={platformAction('configurator.consent', c.onConsentChange$)}
			onAddToCart$={platformAction('configurator.add', c.onAddToCart$)}
			onRetryStock$={platformAction('configurator.retry-stock', c.onRetryStock$)}
		/>
	);
});

/** `route.product`. */
export const BrandProductMount = component$(() => {
	const detail = useBrandProductDetail();
	return detail.value?.state === 'found' ? <ProductFoundMount /> : <ProductMissingMount />;
});
