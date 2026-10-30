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

describe('P4b edge HTML policy (default off)', async () => {
	const { createHash } = await import('node:crypto');
	const m = await import('./route-cache-policy');
	const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('base64');
	const base = { method: 'GET', pathname: '/blog/', search: '', cookie: undefined as string | undefined, enabled: true };

	it('is off unless SELLRIGHT_EDGE_HTML_CACHE=1', () => {
		expect(m.edgeHtmlCacheEnabled({})).toBe(false);
		expect(m.edgeHtmlCacheEnabled({ SELLRIGHT_EDGE_HTML_CACHE: 'true' })).toBe(false);
		expect(m.edgeHtmlCacheEnabled({ SELLRIGHT_EDGE_HTML_CACHE: '1' })).toBe(true);
		expect(m.edgeRequestEligibility({ ...base, enabled: false })).toEqual({ ok: false, reason: 'disabled' });
	});

	it('admits only stock-free content documents', () => {
		for (const p of ['/blog', '/blog/', '/blog/a-post/', '/about/', '/press', '/privacy/', '/returns/', '/contact/']) expect(m.edgeRequestEligibility({ ...base, pathname: p }).ok, p).toBe(true);
		for (const p of ['/', '/shop/', '/shop/x/', '/products/x/', '/collections/x/', '/search/', '/checkout/', '/account/', '/blog/a/b/', '/blog/q-loader-abc.1.json', '/aboutx/'])
			expect(m.edgeRequestEligibility({ ...base, pathname: p }).ok, p).toBe(false);
		expect(m.edgeRequestEligibility({ ...base, method: 'POST' }).ok).toBe(false);
		expect(m.edgeRequestEligibility({ ...base, method: 'HEAD' }).ok).toBe(false);
	});

	it('refuses any non-tracking query (preview tokens, pagination) and any session/cart/preview/country/unknown cookie', () => {
		expect(m.edgeRequestEligibility({ ...base, search: 'utm_source=x&gclid=1&fbclid=2' }).ok).toBe(true);
		expect(m.edgeRequestEligibility({ ...base, search: 'preview_token=abc' })).toEqual({ ok: false, reason: 'query' });
		expect(m.edgeRequestEligibility({ ...base, search: 'page=2' }).ok).toBe(false);
		expect(m.edgeRequestEligibility({ ...base, cookie: '_ga=GA1.1.1; _ga_ABC=x; _gcl_au=1; __cf_bm=z; sr_vid=abc' }).ok).toBe(true);
		for (const c of ['sr_cust=1', 'sr_cust_csrf=1', 'sr_preview_token=t', 'countryCode=US', 'sr_cart=1', 'sr_legacy_cart=1', 'authToken=x', 'sr_admin=1', 'whatever=1'])
			expect(m.edgeRequestEligibility({ ...base, cookie: `_ga=1; ${c}` })).toEqual({ ok: false, reason: 'cookie' });
	});

	it('promotes only a clean 200 HTML response', () => {
		const ok = { status: 200, contentType: 'text/html; charset=utf-8', setCookie: undefined, veto: undefined, bytes: 10 };
		expect(m.edgeResponseEligibility(ok).ok).toBe(true);
		expect(m.edgeResponseEligibility({ ...ok, status: 404 }).ok).toBe(false);
		expect(m.edgeResponseEligibility({ ...ok, status: 301 }).ok).toBe(false);
		expect(m.edgeResponseEligibility({ ...ok, contentType: 'application/json' }).ok).toBe(false);
		expect(m.edgeResponseEligibility({ ...ok, setCookie: ['a=b'] }).ok).toBe(false);
		expect(m.edgeResponseEligibility({ ...ok, veto: 'identity-fallback' })).toEqual({ ok: false, reason: 'veto:identity-fallback' });
		expect(m.edgeResponseEligibility({ ...ok, bytes: m.EDGE_MAX_BODY_BYTES + 1 }).ok).toBe(false);
		expect(m.EDGE_HTML_CACHE_CONTROL).toMatch(/^public, max-age=0, s-maxage=\d+/);
		expect(m.EDGE_HTML_CACHE_CONTROL).not.toMatch(/stale-if-error/);
	});

	it('replaces the nonce with hashes of exactly the executable inline scripts', () => {
		const loader = 'window.qwikevents=1;';
		const gtm = "(function(){var c=document.currentScript;})();";
		const html = `<html><head><script nonce="N1">${gtm}</script><script type="application/ld+json">{"@type":"Product"}</script>`
			+ `<script src="/build/q-1.js" nonce="N1"></script></head><body><script type="qwik/json">{}</script><script type="qwik/vnode">x</script>`
			+ `<script id="qwikloader" type="module" async nonce="N1">${loader}</script><script type='module'>${loader}</script></body></html>`;
		expect(m.executableInlineScripts(html)).toEqual([gtm, loader, loader]);
		const csp = "default-src 'self'; script-src 'self' 'nonce-N1abc+/=' https://js.stripe.com; style-src 'self' 'unsafe-inline'";
		const out = m.cspWithScriptHashes(csp, html, sha)!;
		expect(out).not.toMatch(/nonce-/);
		expect(out).toContain(`script-src 'self' 'sha256-${sha(gtm)}' 'sha256-${sha(loader)}' https://js.stripe.com;`);
		expect(out.match(/sha256-/g)).toHaveLength(2);
		expect(m.cspWithScriptHashes("script-src 'self'", html, sha)).toBeNull();
		expect(m.cspWithScriptHashes("script-src 'self' 'nonce-a'", '<p>no scripts</p>', sha)).toBe("script-src 'self'");
	});

	it('the express layer wires the middleware after the no-store default and before the router', async () => {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const src = readFileSync(join(process.cwd(), 'src/entry.express.tsx'), 'utf8');
		const failClosed = src.indexOf("res.setHeader('Cache-Control', NO_STORE_CACHE_CONTROL)");
		const edge = src.indexOf('app.use(createEdgeHtmlMiddleware(');
		expect(edge).toBeGreaterThan(failClosed);
		expect(edge).toBeLessThan(src.indexOf('app.use(router)'));
		expect(src).toMatch(/enabled: edgeHtmlCacheEnabled\(process\.env\)/);
	});

	describe('middleware over a real HTTP response (Qwik-like writer)', async () => {
		const express = (await import('express')).default;
		const serve = async (opts: { enabled?: boolean; status?: number; setCookie?: boolean; veto?: string; body?: string; chunks?: number }) => {
			const app = express();
			let seenCountry: unknown = 'unset';
			app.use((_req, res, next) => { res.setHeader('Content-Security-Policy', "script-src 'self' 'nonce-REQ1'"); res.setHeader('Cache-Control', m.NO_STORE_CACHE_CONTROL); next(); });
			app.use(m.createEdgeHtmlMiddleware({ enabled: opts.enabled ?? true, sha256Base64: sha }) as never);
			app.use((req, res) => {
				seenCountry = req.headers['cf-ipcountry'];
				res.statusCode = opts.status ?? 200;
				res.setHeader('Content-Type', 'text/html; charset=utf-8');
				if (opts.setCookie) res.setHeader('Set-Cookie', ['a=b']);
				if (opts.veto) res.setHeader(m.EDGE_VETO_HEADER, opts.veto);
				const body = opts.body ?? '<html><script nonce="REQ1">go()</script></html>';
				const n = opts.chunks ?? 2;
				const size = Math.ceil(body.length / n);
				let i = 0;
				const next = () => {
					if (i >= body.length) { res.end(); return; }
					const part = body.slice(i, i + size); i += size;
					res.write(part, () => next());
				};
				next();
			});
			const server = await new Promise<import('node:http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
			try {
				const { port } = server.address() as import('node:net').AddressInfo;
				const r = await fetch(`http://127.0.0.1:${port}/blog/post/`, { headers: { 'cf-ipcountry': 'DE', cookie: '_ga=1' } });
				return { r, text: await r.text(), seenCountry };
			} finally { await new Promise((resolve) => server.close(resolve)); }
		};

		it('promotes an eligible page: public edge header, hashed CSP, no nonce, no country, no veto header, body intact', async () => {
			const { r, text, seenCountry } = await serve({});
			expect(text).toBe('<html><script nonce="REQ1">go()</script></html>');
			expect(r.headers.get('cache-control')).toBe(m.EDGE_HTML_CACHE_CONTROL);
			expect(r.headers.get('content-security-policy')).toBe(`script-src 'self' 'sha256-${sha('go()')}'`);
			expect(r.headers.get('x-sr-edge')).toBe('eligible');
			expect(seenCountry).toBeUndefined();
		});

		for (const [name, opts, reason] of [
			['a vetoed render', { veto: 'identity-fallback' }, 'veto:identity-fallback'],
			['a Set-Cookie response', { setCookie: true }, 'set-cookie'],
			['a 404', { status: 404 }, 'status'],
			['an oversize body', { body: `<p>${'x'.repeat(2 * 1024 * 1024 + 10)}</p>`, chunks: 4 }, 'size'],
		] as const) {
			it(`leaves ${name} no-store with the nonce CSP`, async () => {
				const { r } = await serve(opts);
				expect(r.headers.get('cache-control')).toBe(m.NO_STORE_CACHE_CONTROL);
				expect(r.headers.get('content-security-policy')).toContain("'nonce-REQ1'");
				expect(r.headers.get('x-sr-edge')).toBe(`bypass:${reason}`);
				expect(r.headers.get(m.EDGE_VETO_HEADER)).toBeNull();
			});
		}

		it('is inert when the flag is off', async () => {
			const { r, seenCountry } = await serve({ enabled: false });
			expect(r.headers.get('cache-control')).toBe(m.NO_STORE_CACHE_CONTROL);
			expect(r.headers.get('x-sr-edge')).toBeNull();
			expect(seenCountry).toBe('DE');
		});
	});
});
