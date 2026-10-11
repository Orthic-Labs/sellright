/**
 * The single place that decides cache headers for storefront responses (CLAUDE.md "Stock Architecture": no cache,
 * TTL or debounce for stock anywhere). Every HTML document and every loader/action data response is
 * `private, no-store`: documents render stock-derived state (home cards, shop, PDP, JSON-LD availability, search)
 * or per-request state (CSP nonce, cookies, identity, maintenance), so a shared or browser cache in front of ANY of
 * them is a stock cache or replays a stale nonce. There is deliberately no "public" page class: an unknown path
 * fails closed. Cacheable responses are only content-hashed build assets (`/build`, `/assets`, hashed root images)
 * and the stock-free sitemap/robots/IndexNow-key routes, which set their own headers.
 * `no-cache`/`must-revalidate` are kept alongside `no-store` for older intermediaries and the e2e/prod-smoke checks.
 */
export const NO_STORE_CACHE_CONTROL = 'private, no-store, no-cache, must-revalidate';

export type RouteClass = 'dynamic' | 'stock_bearing' | 'document';

export interface RouteCacheProfile {
	routeClass: RouteClass;
	responseCacheControl: string;
}

export const CACHE_POLICY_VERSION = '2026-10-11.1';

// `/shop-api` and `/admin-api` were the old legacy GraphQL endpoint
// prefixes — this SellRight storefront never serves or proxies those paths
// (the native API lives under `/v1`, handled directly by
// `~/sellright/client`'s SSR fetch, never through a Qwik route), so they were
// dead entries here.
const DYNAMIC_PREFIXES = [
	'/checkout',
	'/account',
	'/sign-in',
	'/api/',
	'/cache-debug',
	'/cache',
	'/track-order',
	'/newsletter-signup',
	'/subscriber',
	'/newsletter/',
	'/affiliate',
	'/verify',
	'/forgot-password',
	'/verify-email-address-change',
	'/password-reset',
];

// Documents that render stock-derived state (manifest `inStock`, PDP availability and JSON-LD, search and collection
// cards, the home page's product cards). Classified separately from other documents only for the x-route-class
// diagnostic header; the cache header is identical.
const STOCK_BEARING_PREFIXES = [
	'/',
	'/shop',
	'/products',
	'/search',
	'/collections',
];

const startsWithAny = (pathname: string, prefixes: string[]) => {
	if (pathname === '/') {
		return prefixes.includes('/');
	}
	return prefixes.some((prefix) => prefix !== '/' && pathname.startsWith(prefix));
};

export const getRouteCacheProfile = (pathname: string): RouteCacheProfile => {
	if (startsWithAny(pathname, DYNAMIC_PREFIXES)) {
		return { routeClass: 'dynamic', responseCacheControl: NO_STORE_CACHE_CONTROL };
	}
	if (startsWithAny(pathname, STOCK_BEARING_PREFIXES)) {
		return { routeClass: 'stock_bearing', responseCacheControl: NO_STORE_CACHE_CONTROL };
	}
	// Any other document (contact, legal pages, blog, unknown paths): still never stored.
	return { routeClass: 'document', responseCacheControl: NO_STORE_CACHE_CONTROL };
};

/**
 * Qwik Router rc.2 serves loader data from `{route}/q-loader-{id}.{hash}.json` and strips that suffix from
 * `url.pathname` before handlers run, so a page-path profile would wrongly classify the data response as the
 * page ('/' => shared s-maxage). Router flags set on `sharedMap`: `@isQLoader`, `@isQAction`
 * (router lib/chunks/request-path.mjs, user-response.mjs createRequestEvent).
 */
const INTERNAL_DATA_FLAGS = ['@isQLoader', '@isQAction'];

export const isInternalDataRequest = (sharedMap: { has(key: string): boolean }) =>
	INTERNAL_DATA_FLAGS.some((flag) => sharedMap.has(flag));

/** Loader/action data is cookie-dependent and stock-bearing (identity, auth, country, maintenance, catalog): never stored. */
export const getDataRequestCacheProfile = (): RouteCacheProfile => ({
	routeClass: 'dynamic',
	responseCacheControl: NO_STORE_CACHE_CONTROL,
});

/** Every response is private no-store; loader/action data requests get the data profile under any page path. */
export const resolveRouteCacheProfile = (
	pathname: string,
	sharedMap: { has(key: string): boolean },
): RouteCacheProfile =>
	isInternalDataRequest(sharedMap) ? getDataRequestCacheProfile() : getRouteCacheProfile(pathname);
