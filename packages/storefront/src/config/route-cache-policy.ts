export type RouteClass = 'dynamic' | 'public_high_traffic' | 'public_standard';

export interface RouteCacheProfile {
	routeClass: RouteClass;
	cacheControl: {
		maxAge: number;
		sMaxAge: number;
		staleWhileRevalidate: number;
	};
	responseCacheControl?: string;
}

export const CACHE_POLICY_VERSION = '2026-03-19.2';

const DYNAMIC_PREFIXES = [
	'/checkout',
	'/account',
	'/sign-in',
	'/api/',
	'/shop-api',
	'/admin-api',
	'/cache-debug',
	'/cache',
	'/track-order',
	'/verify',
	'/forgot-password',
	'/verify-email-address-change',
	'/password-reset',
];

const HIGH_TRAFFIC_PUBLIC_PREFIXES = [
	'/',
	'/shop',
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
