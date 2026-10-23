// E2E probe (not product behaviour): mounts the brand-facing ExpressBuyButtons view export exactly as a brand product view
// would, so e2e/express-checkout.spec.ts can drive PDP buy-now against the real API without a brand build. Gated at request
// time like the A12 probe (src/platform/probe.ts): a 404 with no button unless the server runs with E2E_PLATFORM_PROBE=1.
import { component$ } from '@qwik.dev/core';
import { routeLoader$ } from '@qwik.dev/router';
import { ExpressBuyButtons } from '~/platform/views';

export const useBuyNowProbe = routeLoader$(({ env, status, url }) => {
	if (env.get('E2E_PLATFORM_PROBE') !== '1') {
		status(404);
		return { enabled: false as const, sku: null };
	}
	return { enabled: true as const, sku: url.searchParams.get('sku') || null };
});

export default component$(() => {
	const probe = useBuyNowProbe();
	if (!probe.value.enabled) return <main>not found</main>;
	return (
		<main>
			<h1>express buy-now probe</h1>
			<button type="button" style="height:48px">Add to cart</button>
			<ExpressBuyButtons sku={probe.value.sku} currency="USD" buttonHeight={48} />
		</main>
	);
});
