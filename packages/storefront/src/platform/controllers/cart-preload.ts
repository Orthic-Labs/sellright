// #425: what a product page does at idle so the Add to cart tap does not wait on code or on the country read.
//
// 1. The code. The tap opens the cart drawer; the drawer's components, the add handler and the cart service are lazy QRLs, and the page
//    preloads only what it renders (platform/preload-graph.ts, P7), so the first tap fetched ~18 chunks in ~6 sequential waves (each
//    chunk discovered only after its parent ran: 1.5 s at 150 ms RTT). The segment of the visible task below is the ANCHOR of the
//    cart-drawer closure in preload-graph.ts (CART_ANCHOR): Qwik's own preloader fetches it when the page goes idle and, through the
//    graph edges the build adds to it, the drawer + add-to-cart + cart service bundles with it, in parallel. Nothing hand-rolled: the
//    framework's preloader and its bundle graph do the loading, at the preloader's low priority.
// 2. The visitor country. The drawer's Checkout control and shipping quote want the shopper's country, and the lookup (/api/country/,
//    public, once per page load, only while the stored preference is still the default) used to start only after the add finished,
//    landing ~1 s into the drawer. Started here, the answer is in the stored preference when the drawer opens.
import { useVisibleTask$ } from '@qwik.dev/core';
import { resolveVisitorCountry } from '~/utils/addressStorage';

export function usePreloadCartDrawer(): void {
	useVisibleTask$(
		() => {
			void resolveVisitorCountry().catch(() => undefined);
		},
		{ strategy: 'document-idle' },
	);
}
