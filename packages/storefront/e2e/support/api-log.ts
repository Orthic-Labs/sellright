/**
 * Spec-side view of the API tap's log (support/api-tap.mjs). Requires the suite to run with E2E_API_TAP=1; specs that
 * assert on API-side requests call `apiLog.require()` first so a run without the tap FAILS instead of passing vacuously.
 *
 *   const mark = apiLog.mark();
 *   ... drive the page ...
 *   const calls = await apiLog.since(mark, /\/v1\/shop\/catalog\/products/);   // settles in-flight requests first
 */
import { readFileSync } from 'node:fs';
import { API_LOG_FILE, API_TAP, TAP_URL } from './env.mjs';

export interface ApiCall { startedAt: number; endedAt: number; method: string; path: string; status: number; origin: 'browser' | 'server' }

function readAll(): ApiCall[] {
	let raw = '';
	try { raw = readFileSync(API_LOG_FILE, 'utf8'); } catch { return []; }
	return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as ApiCall);
}

async function settle(timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const { inflight } = (await (await fetch(`${TAP_URL}/__tap/inflight`)).json()) as { inflight: number };
		if (inflight === 0) return;
		if (Date.now() > deadline) throw new Error(`api tap still has ${inflight} in-flight request(s) after ${timeoutMs}ms`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

export const apiLog = {
	enabled: API_TAP,
	/** Throws unless the tap is on. */
	require(): void {
		if (!API_TAP) throw new Error('this spec observes API-side requests: run with E2E_API_TAP=1 (api tap) — refusing to pass without it');
	},
	/** A point in time; `since` returns requests that STARTED at or after it. */
	mark(): number { return Date.now(); },
	async since(mark: number, pattern?: RegExp, filter?: { origin?: 'browser' | 'server'; method?: string }): Promise<ApiCall[]> {
		apiLog.require();
		await settle();
		return readAll().filter((c) =>
			c.startedAt >= mark && (!pattern || pattern.test(c.path)) && (!filter?.origin || c.origin === filter.origin) && (!filter?.method || c.method === filter.method));
	},
	async all(): Promise<ApiCall[]> { apiLog.require(); await settle(); return readAll(); },
};

/** API paths of the stock-relevant requests the storefront makes (src/sellright/catalog.ts, services/CartService.ts). */
export const STOCK_PATTERNS = {
	/** shop toggle / listing: GET /v1/shop/catalog/products?limit=…&offset=… (src/routes/shop/index.tsx onInStockChange → searchProducts → fetchProductList) */
	shopCatalog: /^\/v1\/shop\/catalog\/products(\?|$)/,
	/** PDP live availability: GET /v1/shop/catalog/products/{slug}/stock (fetchProductStock) */
	productStock: /^\/v1\/shop\/catalog\/products\/[^/?]+\/stock(\?|$)/,
	/** server-side Product JSON-LD: GET /v1/shop/seo/jsonld/products/{slug} (services/sellright-seo.ts jsonLdProduct) */
	jsonLd: /^\/v1\/shop\/seo\/jsonld\/products\//,
	/** cart read = the live stock/price refresh (CartService.refresh): GET /v1/shop/cart/{token} */
	cartRead: /^\/v1\/shop\/cart\/[^/?]+(\?|$)/,
	/** order creation: POST /v1/shop/checkout */
	checkout: /^\/v1\/shop\/checkout(\?|$)/,
};
