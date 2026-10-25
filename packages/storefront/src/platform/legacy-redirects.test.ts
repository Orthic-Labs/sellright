import { describe, expect, it, vi } from 'vitest';
import { compileRedirects, createLegacyRedirects, redirectTarget } from './legacy-redirects';
import { validateJson } from './brand-data/json-schema';
import routesSchema from './brand-data/routes.schema.json';

const MAP = { '/sidekick-pry/': '/shop/', '/product/tombstone': '/products/tombstone-bead/', '/product/*': '/shop/', '/product/old/*': '/blog/' };

describe('legacy redirects', () => {
	const r = compileRedirects(MAP);

	it('matches exact paths with or without the trailing slash', () => {
		expect(redirectTarget(r, '/sidekick-pry/')).toBe('/shop/');
		expect(redirectTarget(r, '/sidekick-pry')).toBe('/shop/');
		expect(redirectTarget(r, '/product/tombstone/')).toBe('/products/tombstone-bead/');
	});

	it('exact entries win over prefixes, then the longest prefix; a prefix never matches its bare root', () => {
		expect(redirectTarget(r, '/product/oni-xl/')).toBe('/shop/');
		expect(redirectTarget(r, '/product/old/x/')).toBe('/blog/');
		expect(redirectTarget(r, '/product/')).toBeNull();
		expect(redirectTarget(r, '/products/oni/')).toBeNull();
	});

	it('301s page GET/HEAD only and passes everything else through', () => {
		const mw = createLegacyRedirects(MAP);
		const res = { redirect: vi.fn() };
		const next = vi.fn();
		mw({ method: 'GET', path: '/sidekick-pry/' } as never, res as never, next);
		expect(res.redirect).toHaveBeenCalledWith(301, '/shop/');
		mw({ method: 'POST', path: '/sidekick-pry/' } as never, res as never, next);
		mw({ method: 'GET', path: '/shop/' } as never, res as never, next);
		expect(res.redirect).toHaveBeenCalledTimes(1);
		expect(next).toHaveBeenCalledTimes(2);
	});

	it('routes.json schema accepts the shapes and refuses off-site targets', () => {
		const ok = (redirects: Record<string, string>) => validateJson({ version: 1, redirects }, routesSchema as never);
		expect(ok(MAP)).toEqual([]);
		expect(ok({ '/shop/short-sleeve/': '/shop/?style=short' })).toEqual([]);
		expect(ok({ '/x/': '//evil.example/' }).length).toBeGreaterThan(0);
		expect(ok({ '/x/': 'https://evil.example/' }).length).toBeGreaterThan(0);
		expect(ok({ '/x/': '/\\evil.example' }).length).toBeGreaterThan(0);
		expect(ok({ 'x/': '/shop/' }).length).toBeGreaterThan(0);
	});
});
