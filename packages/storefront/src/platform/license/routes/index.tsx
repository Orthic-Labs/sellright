import { component$ } from '@qwik.dev/core';
import { routeLoader$, type DocumentHead } from '@qwik.dev/router';
import { loadCatalog, type PricedProduct } from '../catalog';
import { PricingGrid } from '../PricingGrid';
import { useHostVariant } from './layout';
import { licensePageHead } from '../variant';

export const useCatalog = routeLoader$<PricedProduct[]>(async ({ resolveValue }) => loadCatalog((await resolveValue(useHostVariant)).collection));

export default component$(() => {
	const v = useHostVariant();
	const catalog = useCatalog();
	return (
		<main class="wrap section">
			<h1>{v.value.name} licenses</h1>
			<p class="lead">Secure checkout. Your license key is delivered instantly after payment.</p>
			<PricingGrid catalog={catalog.value} />
		</main>
	);
});

export const head: DocumentHead = ({ resolveValue, url }) => {
	const v = resolveValue(useHostVariant);
	return licensePageHead(v, `${v.name} — buy a license`, url);
};
