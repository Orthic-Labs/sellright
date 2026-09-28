import { describe, expect, it } from 'vitest';
import { getRouteCacheProfile } from './route-cache-policy';

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
