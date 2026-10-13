// Brand views PR2 §6, §10: the branded product page. `BrandProductMount` is a switch with no hooks of its own beyond the loader read:
// a missing product renders `ProductMissingView` (no controller, no stock read, no view_item; the loader already set the 404 status),
// a found one mounts the configurator.
import { component$, useComputed$, type ReadonlySignal } from '@qwik.dev/core';
import { useStoreIdentityLoader } from '~/routes/layout';
import { useBrandProductDetail } from '~/platform/product-detail';
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
	const c = useConfigurator(detail as ReadonlySignal<ConfiguratorLoaderValue>, 'product');
	const data = useComputed$(() => {
		const d = detail.value;
		const v = c.view.value;
		return seal<ProductFoundData>({
			identity: projectIdentity(identity.value.identity) as PublicIdentity,
			state: 'found',
			product: v.products[0],
			siblings: v.siblings,
			selection: v.selection,
			purchase: v.purchase,
			breadcrumbs: d && d.state === 'found' ? d.breadcrumbs.map((b) => ({ name: b.name, href: b.href })) : [],
		});
	});
	return (
		<ProductView
			{...data.value}
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
