export type RouteClass = 'dynamic' | 'stock_bearing' | 'public_high_traffic' | 'public_standard';

export interface RouteCacheProfile {
	routeClass: RouteClass;
	cacheControl: {
		maxAge: number;
		sMaxAge: number;
		staleWhileRevalidate: number;
	};
	responseCacheControl?: string;
}

export const CACHE_POLICY_VERSION = '2026-10-10.1';

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
	'/affiliate',
	'/verify',
	'/forgot-password',
	'/verify-email-address-change',
	'/password-reset',
];

// Documents that render stock-derived state (manifest `inStock`, PDP availability and JSON-LD, search and collection
// cards, the home page's product cards). A shared cache in front of them is a stock cache (CLAUDE.md "Stock
// Architecture"): they must be `private, no-cache`, with no CDN cache header. Checkout is dynamic above.
const STOCK_BEARING_PREFIXES = [
	'/',
	'/shop',
	'/products',
	'/search',
	'/collections',
];

const HIGH_TRAFFIC_PUBLIC_PREFIXES = [
	'/contact',
	'/terms',
	'/privacy',
	'/returns',
	'/search',
];

const startsWithAny = (pathname: string, prefixes: string[]) => {
	if (pathname === '/') {
		return prefixes.includes('/');
	}
	return prefixes.some((prefix) => prefix !== '/' && pathname.startsWith(prefix));
};

export const getRouteCacheProfile = (pathname: string): RouteCacheProfile => {
	if (startsWithAny(pathname, DYNAMIC_PREFIXES)) {
		return {
			routeClass: 'dynamic',
			cacheControl: { maxAge: 0, sMaxAge: 0, staleWhileRevalidate: 0 },
			responseCacheControl: 'private, no-store, no-cache, must-revalidate',
		};
	}

	if (startsWithAny(pathname, STOCK_BEARING_PREFIXES)) {
		return {
			routeClass: 'stock_bearing',
			cacheControl: { maxAge: 0, sMaxAge: 0, staleWhileRevalidate: 0 },
			responseCacheControl: 'private, no-cache',
		};
	}

	if (startsWithAny(pathname, HIGH_TRAFFIC_PUBLIC_PREFIXES)) {
		return {
			routeClass: 'public_high_traffic',
			cacheControl: { maxAge: 0, sMaxAge: 60 * 60 * 4, staleWhileRevalidate: 60 * 60 * 24 * 7 },
		};
	}

	return {
		routeClass: 'public_standard',
		cacheControl: { maxAge: 0, sMaxAge: 60 * 5, staleWhileRevalidate: 60 },
	};
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

/** Loader/action data is cookie-dependent (identity, auth, country, maintenance): never shared-cacheable. */
export const getDataRequestCacheProfile = (): RouteCacheProfile => ({
	routeClass: 'dynamic',
	cacheControl: { maxAge: 0, sMaxAge: 0, staleWhileRevalidate: 0 },
	responseCacheControl: 'private, no-store, no-cache, must-revalidate',
});

/** Page profile for HTML documents; private no-store for loader/action data requests under any page path. */
export const resolveRouteCacheProfile = (
	pathname: string,
	sharedMap: { has(key: string): boolean },
): RouteCacheProfile =>
	isInternalDataRequest(sharedMap) ? getDataRequestCacheProfile() : getRouteCacheProfile(pathname);
