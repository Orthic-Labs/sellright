import { describe, expect, it } from 'vitest';
import { getRouteCacheProfile, resolveRouteCacheProfile } from './route-cache-policy';

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
		for (const pathname of ['/', '/shop', '/contact', '/terms', '/privacy', '/returns']) {
			expect(getRouteCacheProfile(pathname).routeClass).toBe('public_high_traffic');
		}
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
		expect(resolveRouteCacheProfile('/', new Map()).cacheControl.sMaxAge).toBeGreaterThan(0);
	});
});
