import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalUrlRedirect, createCanonicalUrlMiddleware, parseCanonicalSections } from './canonical-url';

const SECTIONS = parseCanonicalSections('shop, Blog,about,contact');
const req = (path: string, method = 'GET', query = '') => ({ method, path, originalUrl: path + query });

describe('parseCanonicalSections', () => {
	it('is OFF (empty) when unset or blank', () => {
		expect(parseCanonicalSections(undefined)).toEqual([]);
		expect(parseCanonicalSections('')).toEqual([]);
		expect(parseCanonicalSections(' , ')).toEqual([]);
	});

	it('lowercases, trims and drops invalid or never-canonicalised names', () => {
		expect(parseCanonicalSections('Shop, /blog/ ,x y,checkout,api,assets,v1,account')).toEqual(['shop', 'blog']);
	});
});

describe('canonicalUrlRedirect', () => {
	it('GET /SHOP/ redirects to /shop/', () => {
		expect(canonicalUrlRedirect(req('/SHOP/'), SECTIONS)).toBe('/shop/');
	});

	it('adds the trailing slash and keeps the query string', () => {
		expect(canonicalUrlRedirect(req('/contact', 'GET', '?a=B&c=1'), SECTIONS)).toBe('/contact/?a=B&c=1');
		expect(canonicalUrlRedirect(req('/Blog/Some-Post', 'HEAD'), SECTIONS)).toBe('/blog/some-post/');
	});

	it('leaves an already canonical URL alone', () => {
		expect(canonicalUrlRedirect(req('/shop/'), SECTIONS)).toBeNull();
		expect(canonicalUrlRedirect(req('/blog/some-post/'), SECTIONS)).toBeNull();
	});

	it('leaves a mixed-case checkout or account URL untouched (case-sensitive order codes), even if listed', () => {
		expect(canonicalUrlRedirect(req('/checkout/Confirmation/AbC123'), SECTIONS)).toBeNull();
		expect(canonicalUrlRedirect(req('/checkout/Confirmation/AbC123'), ['checkout'])).toBeNull();
		expect(canonicalUrlRedirect(req('/account/orders/AbC123'), ['account'])).toBeNull();
	});

	it('never redirects pages outside the configured sections, or the home page', () => {
		expect(canonicalUrlRedirect(req('/Products/Knife'), SECTIONS)).toBeNull();
		expect(canonicalUrlRedirect(req('/'), SECTIONS)).toBeNull();
	});

	it('never redirects assets, API, loader data, documents or files', () => {
		for (const p of ['/build/q-ABC.js', '/assets/Logo.png', '/fonts/A.woff2', '/v1/shop/cart', '/api/country', '/shop/q-data.json', '/shop/q-loader-abc.123.json',
			'/shop/index.html', '/shop/Photo.JPG', '/blog/feed.xml']) {
			expect(canonicalUrlRedirect(req(p), ['build', 'assets', 'fonts', 'v1', 'api', 'shop', 'blog'].concat(SECTIONS)), p).toBeNull();
		}
	});

	it('never redirects actions, server$ calls or non-page methods', () => {
		expect(canonicalUrlRedirect(req('/SHOP/', 'POST'), SECTIONS)).toBeNull();
		expect(canonicalUrlRedirect(req('/Contact', 'GET', '?qaction=abc'), SECTIONS)).toBeNull();
		expect(canonicalUrlRedirect(req('/Contact', 'GET', '?x=1&qfunc=abc'), SECTIONS)).toBeNull();
		expect(canonicalUrlRedirect(req('/Contact', 'PUT'), SECTIONS)).toBeNull();
	});

	it('does nothing at all when no sections are configured (default OFF)', () => {
		expect(canonicalUrlRedirect(req('/SHOP/'), [])).toBeNull();
	});
});

describe('createCanonicalUrlMiddleware', () => {
	it('answers 301 with the canonical URL, otherwise passes through', () => {
		const mw = createCanonicalUrlMiddleware(SECTIONS);
		const redirect = vi.fn();
		const next = vi.fn();
		mw(req('/SHOP/'), { redirect }, next);
		expect(redirect).toHaveBeenCalledWith(301, '/shop/');
		expect(next).not.toHaveBeenCalled();
		mw(req('/shop/'), { redirect }, next);
		expect(next).toHaveBeenCalledTimes(1);
	});

	it('the entry is wired from config, default OFF, after the snapshot guard and static handlers and inside the no-store default', () => {
		const src = readFileSync(join(process.cwd(), 'src/entry.express.tsx'), 'utf8');
		const rootStatic = src.indexOf('rootStatic(req, res, next)');
		const failClosed = src.indexOf("res.setHeader('Cache-Control', NO_STORE_CACHE_CONTROL)");
		const canonical = src.indexOf('createCanonicalUrlMiddleware(parseCanonicalSections(process.env.STOREFRONT_CANONICAL_SECTIONS))');
		const router = src.indexOf('app.use(router)');
		expect(canonical).toBeGreaterThan(-1);
		expect(canonical).toBeGreaterThan(rootStatic);
		expect(canonical).toBeGreaterThan(failClosed);
		expect(canonical).toBeLessThan(router);
		expect(src).toContain('neverServedFromDisk(req.path) ? next() : rootStatic(req, res, next)');
	});
});
