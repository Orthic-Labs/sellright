import { describe, expect, it } from 'vitest';
import {
	CACHE_POLICY_VERSION,
	NO_STORE_CACHE_CONTROL,
	getRouteCacheProfile,
	resolveRouteCacheProfile,
} from './route-cache-policy';

const flags = (...keys: string[]) => new Map(keys.map((k) => [k, true]));

/** Header-level assertions shared by every document and data response: private, no-store, no shared-cache directive. */
const expectNoStore = (value: string | undefined, what: string) => {
	expect(value, what).toBeTruthy();
	expect(value, what).toMatch(/\bprivate\b/);
	expect(value, what).toMatch(/\bno-store\b/);
	expect(value, what).not.toMatch(/s-maxage|max-age=[1-9]|stale-while-revalidate|\bpublic\b/);
};

const DOCUMENT_PATHS = [
	'/',
	'/shop',
	'/shop/',
	'/shop/some-knife/',
	'/products/some-knife',
	'/search',
	'/collections/new',
	'/contact',
	'/contact/',
	'/terms',
	'/privacy',
	'/returns',
	'/blog',
	'/about',
	'/definitely/not/a/route/',
	'/shop-api/anything',
	'/checkout',
	'/account/orders',
];

describe('getRouteCacheProfile', () => {
	it('makes every HTML document private no-store, including /, /shop/, /contact/ and unknown paths', () => {
		for (const pathname of DOCUMENT_PATHS) {
			const profile = getRouteCacheProfile(pathname);
			expect(profile.responseCacheControl, pathname).toBe(NO_STORE_CACHE_CONTROL);
			expectNoStore(profile.responseCacheControl, pathname);
		}
	});

	it('emits no CDN cache directive or shared lifetime anywhere in a profile', () => {
		for (const pathname of DOCUMENT_PATHS) {
			const profile = getRouteCacheProfile(pathname) as unknown as Record<string, unknown>;
			expect(Object.keys(profile).filter((key) => /cdn|maxage|swr|staleWhile|^cacheControl$/i.test(key)), pathname).toEqual([]);
			expect(JSON.stringify(profile), pathname).not.toMatch(/s-maxage/i);
		}
	});

	it('keeps the x-route-class diagnostic classification', () => {
		for (const pathname of ['/', '/shop', '/shop/', '/products/some-knife', '/search', '/collections/new']) {
			expect(getRouteCacheProfile(pathname).routeClass, pathname).toBe('stock_bearing');
		}
		for (const pathname of ['/track-order', '/newsletter-signup', '/subscriber/confirm/abc', '/affiliate', '/checkout', '/checkout/confirmation/ABC', '/account/orders']) {
			expect(getRouteCacheProfile(pathname).routeClass, pathname).toBe('dynamic');
		}
		for (const pathname of ['/contact', '/contact/', '/terms', '/blog', '/about', '/nope/nope', '/admin-api/anything']) {
			expect(getRouteCacheProfile(pathname).routeClass, pathname).toBe('document');
		}
		// Prefix matching is deliberately loose: a path that merely starts with a stock prefix is treated as stock-bearing.
		// The class is only a diagnostic label; every class answers no-store.
		expect(getRouteCacheProfile('/shop-api/anything').routeClass).toBe('stock_bearing');
	});

	it('exposes a policy version string for the x-cache-policy-version header', () => {
		expect(CACHE_POLICY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
	});
});

describe('resolveRouteCacheProfile', () => {
	it('makes loader data (q-loader-{id}.{hash}.json) private no-store under any page path', () => {
		for (const pathname of ['/', '/shop', '/shop/', '/shop/some-knife/', '/contact/', '/blog', '/products/x', '/unknown/']) {
			const profile = resolveRouteCacheProfile(pathname, flags('@isQLoader'));
			expect(profile.routeClass, pathname).toBe('dynamic');
			expect(profile.responseCacheControl, pathname).toBe(NO_STORE_CACHE_CONTROL);
			expectNoStore(profile.responseCacheControl, pathname);
		}
	});

	it('makes action responses private no-store under any page path', () => {
		for (const pathname of ['/', '/shop', '/shop/', '/contact/', '/unknown/']) {
			const profile = resolveRouteCacheProfile(pathname, flags('@isQAction'));
			expectNoStore(profile.responseCacheControl, pathname);
		}
	});

	it('gives documents the same private no-store header when no data flag is set', () => {
		for (const pathname of DOCUMENT_PATHS) {
			expect(resolveRouteCacheProfile(pathname, new Map()).responseCacheControl, pathname).toBe(NO_STORE_CACHE_CONTROL);
		}
	});
});

describe('hashed build assets', () => {
	// Asset caching is not decided by the route policy: /build and /assets are served by express.static (immutable,
	// 1y) because every file there is content-hashed (rolldown `[name]-[hash]`, Qwik `build/q-[hash].js`). The policy
	// must therefore never be applied to them, i.e. the express fail-closed default is registered AFTER the static
	// handlers. This guards the ordering in entry.express.tsx.
	it('keeps the static handlers ahead of the no-store default in entry.express.tsx', async () => {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		// jsdom gives this module a non-file URL; tests run from the package directory.
		const src = readFileSync(join(process.cwd(), 'src/entry.express.tsx'), 'utf8');
		const build = src.indexOf("app.use(`/build`");
		const assets = src.indexOf("app.use(`/assets`");
		const rootStatic = src.indexOf('rootStatic(req, res, next)');
		const failClosed = src.indexOf('res.setHeader(\'Cache-Control\', NO_STORE_CACHE_CONTROL)');
		const router = src.indexOf('app.use(router)');
		expect(build).toBeGreaterThan(-1);
		expect(assets).toBeGreaterThan(-1);
		expect(rootStatic).toBeGreaterThan(-1);
		expect(failClosed).toBeGreaterThan(Math.max(build, assets, rootStatic));
		expect(failClosed).toBeLessThan(router);
		expect(src).toMatch(/express\.static\(buildDir, \{ immutable: true, maxAge:"1y" \}\)/);
		expect(src).toMatch(/express\.static\(assetsDir, \{ immutable: true, maxAge:"1y" \}\)/);
	});

	it('never serves a document or route-data file from disk, including encoded and precompressed forms', async () => {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const src = readFileSync(join(process.cwd(), 'src/entry.express.tsx'), 'utf8');
		const m = /const NEVER_STATIC = (\/.+\/i);/.exec(src);
		expect(m, 'NEVER_STATIC pattern present').toBeTruthy();
		const pattern = new RegExp(m![1]!.slice(1, m![1]!.lastIndexOf('/')), 'i');
		// Same steps as neverServedFromDisk in the entry file (which cannot be imported here: it starts a server).
		const { posix } = await import('node:path');
		const never = (raw: string) => { let d: string; try { d = decodeURIComponent(raw); } catch { return true; } return pattern.test(posix.normalize(d.replace(/\\/g, '/')).replace(/\/+$/, '')); };
		for (const p of ['/index.html', '/shop/index.html', '/products/some-knife/index.html', '/about.htm', '/shop/q-data.json', '/q-loader-abc.123.json',
			'/shop/q-loader-x.y.json', '/shop/index%2ehtml', '/shop/index%2Ehtml', '/shop/index.html.gz', '/shop/index.html.br', '/q-loader-a.b.json.gz', '/shop/%E0%A4%A',
			'/shop/index.html%2f.', '/shop/index.html/', '/x/%2e%2e/shop/index.html', '/shop/q-loader-a.b.json%2F.', '/shop//index.html', '/shop/index.html.gz%2f.']) {
			expect(never(p), p).toBe(true);
		}
		for (const p of ['/favicon.ico', '/logo.png', '/q-manifest.json', '/service-worker.js', '/robots.txt', '/fonts/a.woff2', '/q-manifest.json.gz']) {
			expect(never(p), p).toBe(false);
		}
		expect(src).toMatch(/decodeURIComponent\(rawPath\)/);
		expect(src).toMatch(/posix\.normalize\(decoded/);
		expect(src).toMatch(/neverServedFromDisk\(req\.path\) \? next\(\) : rootStatic\(req, res, next\)/);
	});

	it('the service worker stores image responses only, never a document or data response', async () => {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const sw = readFileSync(join(process.cwd(), 'src/routes/service-worker.ts'), 'utf8');
		expect(sw).toMatch(/request\.destination !== 'image'\) return false/);
		expect(sw).toMatch(/isImageRequest\(event\.request\)/);
		expect(sw).toMatch(/if \(isStorableImage\(response\)\) \{\s*cache\.put/);
		expect(sw).toMatch(/\^image\\\//);
		expect(sw).toMatch(/no-store/);
		expect(sw).not.toMatch(/storefront-images-v3/);
		// No other cache.put in the worker.
		expect(sw.match(/cache\.put\(/g)?.length).toBe(1);
	});

	it('prerenders no document in any build (adapter ssg include is empty)', async () => {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const cfg = readFileSync(join(process.cwd(), 'adapters/express/vite.config.mts'), 'utf8');
		expect(cfg).toMatch(/ssg: \{ include: \[\] \},/);
		expect(cfg).not.toMatch(/include: \[\s*["']\/\*["']/);
	});
});
