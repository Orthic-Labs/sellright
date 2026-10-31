import { $, component$, useComputed$ } from '@qwik.dev/core';
import { routeLoader$, server$, type DocumentHead } from '@qwik.dev/router';
import { loadCatalog, redactCatalogPrices, type PricedProduct } from '../catalog';
import { PricingGrid } from '../PricingGrid';
import { useHostVariant } from './layout';
import { licensePageHead, variantForHost } from '../variant';
import { useLiveRead } from '~/platform/live-values';
import { noStore, shellRender } from '~/platform/shell-render';
import { validatedRequestHost } from '~/utils/trusted-request.server';

/** ADR-0001 §3: with SHELL_CACHE=1 the cached home carries the cards without prices (`valuesPending`); the browser reads them. */
export const useCatalog = routeLoader$<{ items: PricedProduct[]; valuesPending: boolean }>(async ({ resolveValue }) => {
	const items = await loadCatalog((await resolveValue(useHostVariant)).collection);
	return shellRender() ? { items: redactCatalogPrices(items), valuesPending: true } : { items, valuesPending: false };
});

/** The live catalog of the request host's variant (no-store; the same host boundary as the layout). */
const readCatalog = server$(async function () {
	noStore(this);
	const host = validatedRequestHost({ host: this.request.headers.get('host') ?? this.url.host, 'x-forwarded-host': this.request.headers.get('x-forwarded-host') ?? undefined });
	return loadCatalog(variantForHost(host).collection);
});

export default component$(() => {
	const v = useHostVariant();
	const catalog = useCatalog();
	const valuesKey = useComputed$(() => (catalog.value.valuesPending ? 'license-home' : null));
	const live = useLiveRead($(() => readCatalog()), valuesKey);
	const ready = catalog.value.valuesPending && live.status === 'ready' && !!live.value;
	return (
		<main class="wrap section">
			<h1>{v.value.name} licenses</h1>
			<p class="lead">Secure checkout. Your license key is delivered instantly after payment.</p>
			<PricingGrid catalog={ready ? live.value! : catalog.value.items} pricePending={catalog.value.valuesPending && !ready} />
		</main>
	);
});

export const head: DocumentHead = ({ resolveValue, url }) => {
	const v = resolveValue(useHostVariant);
	return licensePageHead(v, `${v.name} — buy a license`, url);
};
