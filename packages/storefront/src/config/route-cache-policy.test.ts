import { describe, expect, it } from 'vitest';
import { CACHE_POLICY_VERSION, getRouteCacheProfile, resolveRouteCacheProfile } from './route-cache-policy';

describe('getRouteCacheProfile', () => {
	it('classifies mutating/personalized content routes as dynamic (no-store)', () => {
		for (const pathname of ['/track-order', '/newsletter-signup', '/subscriber/confirm/abc', '/subscriber/unsubscribe/abc', '/affiliate']) {
			expect(getRouteCacheProfile(pathname).routeClass).toBe('dynamic');
			expect(getRouteCacheProfile(pathname).responseCacheControl).toContain('no-store');
		}
	});

	it('no longer treats the dead legacy GraphQL prefixes as dynamic', () => {
		// This storefront never serves /shop-api or /admin-api — the native
		// SellRight API lives entirely under /v1, reached server-side via
		// ~/sellright/client, never through a Qwik route. These prefixes fell
		// through to public_standard (a real bug if they'd ever mattered — a
		// cacheable "dynamic" API prefix — but since nothing routes through
		// them, this just proves the dead entries are gone).
		expect(getRouteCacheProfile('/shop-api/anything').routeClass).not.toBe('dynamic');
		expect(getRouteCacheProfile('/admin-api/anything').routeClass).not.toBe('dynamic');
	});

	it('still classifies the high-traffic public content routes as such', () => {
		for (const pathname of ['/contact', '/terms', '/privacy', '/returns']) {
			expect(getRouteCacheProfile(pathname).routeClass).toBe('public_high_traffic');
		}
	});

	it('classifies every stock-bearing document as stock_bearing: private, no-cache, never shared-cacheable', () => {
		for (const pathname of ['/', '/shop', '/shop/', '/products/some-knife', '/products/a/b', '/search', '/collections/new']) {
			const profile = getRouteCacheProfile(pathname);
			expect(profile.routeClass, pathname).toBe('stock_bearing');
			expect(profile.responseCacheControl, pathname).toBe('private, no-cache');
			expect(profile.cacheControl, pathname).toEqual({ maxAge: 0, sMaxAge: 0, staleWhileRevalidate: 0 });
			expect(Object.keys(profile).filter((key) => /cdn/i.test(key)), pathname).toEqual([]);
		}
	});

	it('keeps checkout and account dynamic (no-store) and other public routes on their shared-cache policy', () => {
		expect(getRouteCacheProfile('/checkout').routeClass).toBe('dynamic');
		expect(getRouteCacheProfile('/checkout/confirmation/ABC').responseCacheControl).toContain('no-store');
		expect(getRouteCacheProfile('/account/orders').routeClass).toBe('dynamic');
		expect(getRouteCacheProfile('/contact').cacheControl.sMaxAge).toBe(60 * 60 * 4);
		expect(getRouteCacheProfile('/contact').responseCacheControl).toBeUndefined();
		expect(getRouteCacheProfile('/blog').cacheControl.sMaxAge).toBe(60 * 5);
	});

	it('exposes a policy version string for the x-cache-policy-version header', () => {
		expect(CACHE_POLICY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
	});

	it('falls back to public_standard for everything else (e.g. blog, about)', () => {
		expect(getRouteCacheProfile('/blog').routeClass).toBe('public_standard');
		expect(getRouteCacheProfile('/about').routeClass).toBe('public_standard');
	});
});

describe('resolveRouteCacheProfile', () => {
	const flags = (...keys: string[]) => new Map(keys.map((k) => [k, true]));

	it('makes loader data requests private no-store under any page path', () => {
		for (const pathname of ['/', '/shop', '/contact', '/blog', '/products/x']) {
			const profile = resolveRouteCacheProfile(pathname, flags('@isQLoader'));
			expect(profile.routeClass).toBe('dynamic');
			expect(profile.cacheControl.sMaxAge).toBe(0);
			expect(profile.responseCacheControl).toBe('private, no-store, no-cache, must-revalidate');
		}
	});

	it('makes action data requests private no-store', () => {
		const profile = resolveRouteCacheProfile('/shop', flags('@isQAction'));
		expect(profile.responseCacheControl).toContain('no-store');
	});

	it('leaves HTML document profiles unchanged', () => {
		for (const pathname of ['/', '/shop', '/blog', '/checkout']) {
			expect(resolveRouteCacheProfile(pathname, new Map())).toEqual(getRouteCacheProfile(pathname));
		}
		// on this branch '/' is stock-bearing (private, no shared cache); a non-stock document keeps its shared profile
		expect(resolveRouteCacheProfile('/', new Map()).cacheControl.sMaxAge).toBe(0);
		expect(resolveRouteCacheProfile('/blog', new Map()).cacheControl.sMaxAge).toBeGreaterThan(0);
	});
});
