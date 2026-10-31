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

	it('labels x-route-class with the ADR-0001 class (diagnostic only; the header stays no-store)', () => {
		for (const pathname of ['/', '/shop', '/shop/', '/products/some-knife', '/collections/new', '/contact', '/contact/', '/terms', '/blog', '/about', '/checkout'])
			expect(getRouteCacheProfile(pathname).routeClass, pathname).toBe('shell');
		for (const pathname of ['/search', '/track-order', '/newsletter-signup', '/subscriber/confirm/abc', '/affiliate', '/checkout/confirmation/ABC', '/account/orders', '/nope/nope', '/shop-api/anything'])
			expect(getRouteCacheProfile(pathname).routeClass, pathname).toBe('dynamic');
	});

	it('exposes a policy version string for the x-cache-policy-version header', () => {
		expect(CACHE_POLICY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
	});
});

describe('resolveRouteCacheProfile', () => {
	it('makes loader data (q-loader-{id}.{hash}.json) private no-store under any page path', () => {
		for (const pathname of ['/', '/shop', '/shop/', '/shop/some-knife/', '/contact/', '/blog', '/products/x', '/unknown/']) {
			const profile = resolveRouteCacheProfile(pathname, flags('@isQLoader'));
			expect(profile.routeClass, pathname).toBe('data');
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

describe('ADR-0001 route classes', async () => {
	const m = await import('./route-cache-policy');
	const q = (s = '') => new URLSearchParams(s);
	const TABLE: Array<[string, string, 'products' | 'shop', 'shell' | 'dynamic' | 'data']> = [
		['/', '', 'products', 'shell'],
		['/shop', '', 'products', 'shell'],
		['/shop/', '', 'products', 'shell'],
		['/products/some-knife/', '', 'products', 'shell'],
		['/products/some-knife', '', 'products', 'shell'],
		['/collections/new/', '', 'products', 'shell'],
		['/blog', '', 'products', 'shell'],
		['/blog/', '', 'products', 'shell'],
		['/blog/a-post/', '', 'products', 'shell'],
		['/about/', '', 'products', 'shell'],
		['/contact/', '', 'products', 'shell'],
		['/privacy/', '', 'products', 'shell'],
		['/terms/', '', 'products', 'shell'],
		['/returns/', '', 'products', 'shell'],
		['/press/', '', 'products', 'shell'],
		['/checkout/', '', 'products', 'shell'],
		['/checkout', '', 'products', 'shell'],
		// brand productPath /shop/:slug/
		['/shop/long-coat/', '', 'shop', 'shell'],
		['/shop/long-coat/', '', 'products', 'dynamic'],
		['/shop/a/b/', '', 'shop', 'dynamic'],
		// dynamic
		['/checkout/payment/', '', 'products', 'dynamic'],
		['/checkout/cart-link/', '', 'products', 'dynamic'],
		['/checkout/some-alias/', '', 'products', 'dynamic'],
		['/checkout/confirmation/ABC/', '', 'products', 'dynamic'],
		['/account/', '', 'products', 'dynamic'],
		['/account/orders/', '', 'products', 'dynamic'],
		['/sign-in/', '', 'products', 'dynamic'],
		['/search/', '', 'products', 'dynamic'],
		['/search', 'q=knife', 'products', 'dynamic'],
		['/track-order/', '', 'products', 'dynamic'],
		['/verify/', '', 'products', 'dynamic'],
		['/verify-email-address-change/', '', 'products', 'dynamic'],
		['/forgot-password/', '', 'products', 'dynamic'],
		['/password-reset/', '', 'products', 'dynamic'],
		['/api/country/', '', 'products', 'dynamic'],
		['/cache/', '', 'products', 'dynamic'],
		['/cache-admin/purge/', '', 'products', 'dynamic'],
		['/collections/', '', 'products', 'dynamic'],
		['/blog/a/b/', '', 'products', 'dynamic'],
		['/aboutx/', '', 'products', 'dynamic'],
		['/slow-fashion/', '', 'products', 'dynamic'],
		['/definitely/not/a/route/', '', 'products', 'dynamic'],
		['/affiliate/', '', 'products', 'dynamic'],
		// preview
		['/', 'preview_token=abc', 'products', 'dynamic'],
		['/products/x/', 'preview_token=abc', 'products', 'dynamic'],
		// I-3: query that could change output
		['/collections/new/', 'page=2', 'products', 'dynamic'],
		['/shop/', 'q=knife', 'products', 'dynamic'],
		['/shop/', 'style=long', 'products', 'dynamic'],
		['/products/x/', 'size=m', 'products', 'dynamic'],
		['/', 'trackOrder=true', 'products', 'dynamic'],
		// tracking-only query keeps shell
		['/products/x/', 'utm_source=a&gclid=1&fbclid=2', 'products', 'shell'],
		// data
		['/products/x/q-loader-abc.123.json', '', 'products', 'data'],
		['/q-data.json', '', 'products', 'data'],
		['/', 'qaction=abc', 'products', 'data'],
		['/shop/', 'qfunc=abc', 'products', 'data'],
		['/v1/shop/me', '', 'products', 'data'],
	];

	it('classifies the route table', () => {
		for (const [path, search, prefix, want] of TABLE) expect(m.routeClassFor(path, q(search), prefix), `${prefix} ${path}?${search}`).toBe(want);
	});

	it('routeClass uses the build productPath (default /products/)', () => {
		expect(m.routeClass('/products/x/', q())).toBe('shell');
		expect(m.routeClass('/nowhere/', q())).toBe('dynamic');
	});

	it('a whole request: only GET is shell; a preview cookie is a preview; data stays data', () => {
		const r = (o: Partial<{ method: string; pathname: string; search: string; cookie: string }>) =>
			m.requestRouteClass({ method: 'GET', pathname: '/', search: '', cookie: undefined, ...o });
		expect(r({})).toBe('shell');
		expect(r({ method: 'HEAD' })).toBe('dynamic');
		expect(r({ method: 'POST' })).toBe('dynamic');
		expect(r({ method: 'POST', search: 'qaction=x' })).toBe('data');
		expect(r({ cookie: '_ga=1; sr_preview_token=t' })).toBe('dynamic');
		expect(r({ cookie: 'sr_cust=abc; countryCode=US' })).toBe('shell');
	});

	it('switch and TTL: off unless SHELL_CACHE=1; TTL 300 unless a positive integer', () => {
		expect(m.shellCacheEnabled({})).toBe(false);
		expect(m.shellCacheEnabled({ SHELL_CACHE: 'true' })).toBe(false);
		expect(m.shellCacheEnabled({ SHELL_CACHE: '1' })).toBe(true);
		expect(m.shellTtlSeconds({})).toBe(300);
		expect(m.shellTtlSeconds({ SHELL_CACHE_TTL: '3600' })).toBe(3600);
		for (const bad of ['0', '-5', 'abc', '1.5', '']) expect(m.shellTtlSeconds({ SHELL_CACHE_TTL: bad }), bad).toBe(300);
		expect(m.shellCacheControl(300)).toBe('public, max-age=0, s-maxage=300');
		expect(m.shellCacheControl(300)).not.toMatch(/stale/);
	});
});

describe('ADR-0001 I-6 verdict (pure)', async () => {
	const m = await import('./route-cache-policy');
	const ok = { routeClass: 'shell' as const, anonymous: true, enabled: true, status: 200, contentType: 'text/html; charset=utf-8', setCookie: undefined, veto: undefined };
	it('only an all-clear shell response is cacheable', () => {
		expect(m.shellResponseCacheControl(ok, 300)).toBe('public, max-age=0, s-maxage=300');
		const cases: Array<[string, Record<string, unknown>]> = [
			['disabled', { enabled: false }],
			['dynamic class', { routeClass: 'dynamic' }],
			['data class', { routeClass: 'data' }],
			['signed-in context', { anonymous: false }],
			['error render', { status: 500 }],
			['catalog 503', { status: 503 }],
			['unpublished (404)', { status: 404 }],
			['redirect', { status: 301 }],
			['non-html', { contentType: 'application/json' }],
			['Set-Cookie', { setCookie: ['a=b'] }],
			['maintenance', { veto: 'maintenance' }],
			['maintenance unknown', { veto: 'maintenance-unknown' }],
			['identity fallback', { veto: 'identity-fallback' }],
			['authenticated', { veto: 'authenticated' }],
			['preview', { veto: 'preview' }],
		];
		for (const [name, patch] of cases) expect(m.shellResponseCacheControl({ ...ok, ...patch } as never, 300), name).toBe(m.NO_STORE_CACHE_CONTROL);
	});
});

describe('ADR-0001 express layer (fake renderer, real HTTP)', async () => {
	const { createHash } = await import('node:crypto');
	const express = (await import('express')).default;
	const m = await import('./route-cache-policy');
	const { buildCsp } = await import('../utils/csp');
	const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('base64');

	type Render = { status?: number; veto?: string; setCookie?: boolean };
	/** Mirrors entry.express.tsx order: request strip -> CSP/nonce -> no-store default -> response-end check -> renderer. */
	const serve = async (enabled: boolean, render: Render, run: (get: (path: string, headers?: Record<string, string>) => Promise<{ r: Response; text: string }>) => Promise<void>) => {
		const app = express();
		app.use(m.createShellRequestMiddleware({ enabled }) as never);
		app.use((req, res, next) => {
			const nonce = m.isShellRender(res) ? undefined : `N${Math.random().toString(36).slice(2)}`;
			if (nonce) req.headers['x-qwik-nonce'] = nonce; else delete req.headers['x-qwik-nonce'];
			res.setHeader('Content-Security-Policy', buildCsp({ nonce }));
			next();
		});
		app.use((_req, res, next) => { res.setHeader('Cache-Control', m.NO_STORE_CACHE_CONTROL); next(); });
		app.use(m.createShellCacheMiddleware({ enabled, ttlSeconds: 300, sha256Base64: sha }) as never);
		app.use(m.shellRenderUrl as never);
		// Fake Qwik: output depends on every per-visitor input a real loader could read, and serialises the URL like the router.
		app.use((req, res) => {
			const cookie = String(req.headers.cookie ?? '');
			const nonce = req.headers['x-qwik-nonce'];
			const na = nonce ? ` nonce="${nonce}"` : '';
			const signedIn = /(^|; )sr_cust=/.test(cookie);
			res.statusCode = render.status ?? 200;
			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			if (render.setCookie || /(^|; )authToken=/.test(cookie)) res.setHeader('Set-Cookie', ['sr_legacy_cart=1; Path=/']);
			if (render.veto) res.setHeader(m.EDGE_VETO_HEADER, render.veto);
			if (signedIn) res.setHeader(m.EDGE_VETO_HEADER, 'authenticated');
			const body = `<html q:render="ssr"><head><script${na}>window.qwikevents=[]</script><script type="application/ld+json">{}</script></head>`
				+ `<body><header>${signedIn ? 'Hi Jane' : 'Sign in'}</header><p data-co="${req.headers['cf-ipcountry'] ?? ''}" data-auth="${req.headers.authorization ?? ''}">${req.originalUrl}</p>`
				+ `<script type="qwik/json">{}</script><script id="qwikloader"${na}>(()=>{})()</script></body></html>`;
			const size = Math.ceil(body.length / 3);
			let i = 0;
			const step = () => { if (i >= body.length) { res.end(); return; } const part = body.slice(i, i + size); i += size; res.write(part, () => step()); };
			step();
		});
		const server = await new Promise<import('node:http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
		try {
			const { port } = server.address() as import('node:net').AddressInfo;
			await run(async (path, headers = {}) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: 'manual' }); return { r, text: await r.text() }; });
		} finally { await new Promise((resolve) => server.close(resolve)); }
	};

	const SHELL = ['/', '/shop/', '/products/some-knife/', '/collections/new/', '/blog/', '/blog/a-post/', '/about/', '/contact/', '/privacy/', '/terms/', '/returns/', '/press/', '/checkout/'];
	const SIGNED_IN = { cookie: 'sr_cust=abc; sr_cust_csrf=x; countryCode=DE; sr_preview_tokenx=1; authToken=t', authorization: 'Bearer secret', 'cf-ipcountry': 'DE', 'x-qwik-nonce': 'attacker' };

	it('SHELL_CACHE on: a signed-in request to every shell route gets the byte-identical body of an anonymous one, cacheable, no Set-Cookie', async () => {
		await serve(true, {}, async (get) => {
			for (const path of SHELL) {
				const anon = await get(path);
				const signed = await get(path, SIGNED_IN);
				expect(signed.text, path).toBe(anon.text);
				expect(signed.text, path).not.toMatch(/Hi Jane|nonce=|DE|Bearer|attacker/);
				for (const res of [anon, signed]) {
					expect(res.r.headers.get('cache-control'), path).toBe('public, max-age=0, s-maxage=300');
					expect(res.r.headers.get('set-cookie'), path).toBeNull();
					expect(res.r.headers.get(m.EDGE_VETO_HEADER), path).toBeNull();
					expect(res.r.headers.get('x-sr-edge'), path).toBe('cacheable');
				}
				expect(signed.r.headers.get('content-security-policy')).toBe(anon.r.headers.get('content-security-policy'));
			}
		});
	});

	it('SHELL_CACHE on: a tracking-only query renders the same bytes as the bare path (I-3)', async () => {
		await serve(true, {}, async (get) => {
			const bare = await get('/products/x/');
			const tracked = await get('/products/x/?utm_source=a&gclid=1', SIGNED_IN);
			expect(tracked.text).toBe(bare.text);
			expect(tracked.r.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=300');
		});
	});

	it('SHELL_CACHE on: the cacheable CSP is nonce-free and hashes exactly the executable inline scripts', async () => {
		await serve(true, {}, async (get) => {
			const { r } = await get('/');
			const csp = r.headers.get('content-security-policy')!;
			const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src '))!;
			expect(scriptSrc).not.toMatch(/nonce-|unsafe-inline|strict-dynamic/);
			expect(scriptSrc.startsWith(`script-src 'self' 'sha256-${sha('window.qwikevents=[]')}' 'sha256-${sha('(()=>{})()')}' https://static.cloudflareinsights.com https://js.stripe.com`)).toBe(true);
			expect(scriptSrc.match(/sha256-/g)).toHaveLength(2);
		});
	});

	for (const [name, render, reason] of [
		['an error render', { status: 500 }, 'status:500'],
		['an unpublished render (404 coming soon)', { status: 404 }, 'status:404'],
		['a maintenance render', { veto: 'maintenance' }, 'veto:maintenance'],
		['an identity-fallback render', { veto: 'identity-fallback' }, 'veto:identity-fallback'],
		['a Set-Cookie response', { setCookie: true }, 'set-cookie'],
	] as const) {
		it(`SHELL_CACHE on: ${name} on a shell path is private no-store, with a hash CSP (no nonce in the body)`, async () => {
			await serve(true, render, async (get) => {
				for (const path of ['/', '/products/x/', '/blog/']) {
					const { r, text } = await get(path);
					expect(r.headers.get('cache-control'), path).toBe(m.NO_STORE_CACHE_CONTROL);
					expect(r.headers.get('x-sr-edge'), path).toBe(`bypass:${reason}`);
					expect(r.headers.get(m.EDGE_VETO_HEADER), path).toBeNull();
					expect(r.headers.get('content-security-policy')).toContain(`'sha256-${sha('window.qwikevents=[]')}'`);
					expect(text).not.toMatch(/nonce=/);
				}
			});
		});
	}

	it('SHELL_CACHE on: preview (query or cookie), dynamic routes and non-tracking queries keep cookies, the nonce and no-store', async () => {
		await serve(true, {}, async (get) => {
			for (const [path, headers] of [
				['/?preview_token=abc', {}],
				['/products/x/', { cookie: 'sr_preview_token=abc' }],
				['/account/', { cookie: 'sr_cust=abc' }],
				['/search?q=x', {}],
				['/collections/new/?page=2', {}],
			] as Array<[string, Record<string, string>]>) {
				const { r, text } = await get(path, headers);
				expect(r.headers.get('cache-control'), path).toBe(m.NO_STORE_CACHE_CONTROL);
				expect(r.headers.get('content-security-policy'), path).toMatch(/'nonce-N/);
				expect(text, path).toMatch(/nonce="N/);
				if (headers.cookie?.includes('sr_cust')) expect(text).toContain('Hi Jane');
			}
		});
	});

	it('SHELL_CACHE off: every document is private no-store with the per-request nonce, request untouched, no diagnostic header', async () => {
		await serve(false, {}, async (get) => {
			for (const path of [...SHELL, '/account/', '/search?q=x', '/?preview_token=a', '/nope/']) {
				const { r, text } = await get(path, SIGNED_IN);
				expect(r.headers.get('cache-control'), path).toBe(m.NO_STORE_CACHE_CONTROL);
				expect(r.headers.get('content-security-policy'), path).toMatch(/'nonce-N[a-z0-9]+'/);
				expect(r.headers.get('content-security-policy'), path).not.toMatch(/sha256-/);
				expect(r.headers.get('x-sr-edge'), path).toBeNull();
				expect(text, path).toContain('Hi Jane');
				expect(text, path).toContain('data-co="DE"');
			}
		});
	});
});

describe('ADR-0001 wiring in entry.express.tsx', () => {
	it('strips before the CSP/cookie contexts, checks after the no-store default and before the router; switch read from env', async () => {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const src = readFileSync(join(process.cwd(), 'src/entry.express.tsx'), 'utf8');
		const strip = src.indexOf('app.use(createShellRequestMiddleware(');
		const nonce = src.indexOf("randomBytes(16).toString('base64')");
		const cookieCtx = src.indexOf('sellrightRequestCookie.run(');
		const failClosed = src.indexOf("res.setHeader('Cache-Control', NO_STORE_CACHE_CONTROL)");
		const check = src.indexOf('app.use(createShellCacheMiddleware(');
		const router = src.indexOf('app.use(router)');
		expect(strip).toBeGreaterThan(-1);
		expect(strip).toBeLessThan(nonce);
		expect(strip).toBeLessThan(cookieCtx);
		expect(check).toBeGreaterThan(failClosed);
		expect(check).toBeLessThan(router);
		const url = src.indexOf('app.use(shellRenderUrl)');
		expect(url).toBeGreaterThan(src.indexOf('app.use(createCanonicalUrlMiddleware('));
		expect(url).toBeLessThan(router);
		expect(src).toMatch(/const SHELL_CACHE_ON = shellCacheEnabled\(\);/);
		expect(src).toMatch(/ttlSeconds: shellTtlSeconds\(\)/);
		expect(src).not.toMatch(/SELLRIGHT_EDGE_HTML_CACHE|createEdgeHtmlMiddleware/);
	});
});
