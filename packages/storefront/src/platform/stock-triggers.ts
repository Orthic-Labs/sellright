// The ONE module that turns the platform settings into stock-read timing (L1 only: no brand code can import it, and only this file
// reads platform/settings.ts, see settings.wiring.test.ts). It decides WHEN the live reads the locked stock rules prescribe start; it
// never caches a result, never skips a read because of an earlier one, and never changes what missing stock means (out of stock).
//   pdp.stockRefreshTrigger  qidle (default) | qinit (Damned, approved 2026-09-26): the document event of the PDP's automatic read.
//   pdp.bfcacheRefresh       false (default) | true (Damned, O3): a page restored from the back/forward cache reads live stock again.
//   shop.stockOnLoad         manifest (default) | live (Rotten, O1): the shop listing makes one live, uncached, fail-closed read per
//                            view on load, as the in-stock toggle does; the toggle stays a live read too.
import { $, useOnDocument, useOnWindow, useSignal, useTask$, type QRL } from '@qwik.dev/core';
import { isBrowser } from '@qwik.dev/core/build';
import { platformSettings } from './settings';

export const PDP_STOCK_TRIGGER: 'qinit' | 'qidle' = platformSettings['pdp.stockRefreshTrigger'];
export const PDP_BFCACHE_REFRESH: boolean = platformSettings['pdp.bfcacheRefresh'];
export const SHOP_STOCK_ON_LOAD: 'manifest' | 'live' = platformSettings['shop.stockOnLoad'];

/** The document event that starts a view's automatic live read on a direct load: the PDP's setting, or the shop's qidle. */
export function useStockTrigger(page: 'pdp' | 'shop', load: QRL<() => unknown>): void {
	useOnDocument(page === 'pdp' ? PDP_STOCK_TRIGGER : 'qidle', $(() => { load(); }));
}

/** PDP (base and brand view): `useStockTrigger('pdp', load)`. */
export function usePdpStockTrigger(load: QRL<() => unknown>): void {
	useStockTrigger('pdp', load);
}

/** PDP: with pdp.bfcacheRefresh, a persisted `pageshow` (back/forward cache restore) starts one new live read. Off: no listener at all. */
export function useBfcacheStockRefresh(refresh: QRL<() => unknown>, page: 'pdp' | 'shop' = 'pdp'): void {
	// Build constants and a per-call-site constant: the hook list is the same on every render.
	if (!PDP_BFCACHE_REFRESH || page !== 'pdp') return;
	useOnWindow('pageshow', $((event: Event) => { if ((event as PageTransitionEvent).persisted) refresh(); }));
}

/**
 * Shop: with shop.stockOnLoad = live, one live listing read per view: qidle on a direct load, a browser task at a client-side mount
 * (SPA navigation), whichever comes first. `requested` belongs to this mounted view only; it is not a freshness flag (a new view or a
 * reload reads again). Manifest (default): no listener, no task.
 */
export function useShopListingOnLoad(read: QRL<() => unknown>): void {
	if (SHOP_STOCK_ON_LOAD !== 'live') return;
	const requested = useSignal(false);
	const start = $(() => {
		if (requested.value) return;
		requested.value = true;
		read();
	});
	useTask$(() => {
		if (isBrowser) start();
	});
	useOnDocument('qidle', start);
}
