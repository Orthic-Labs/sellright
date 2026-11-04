// ADR-0001: the Link preload header (Cloudflare Early Hints) of the /shop/ and /checkout/ shells, through the real express shell layer
// (request strip, hash CSP, I-6) and the real route `onRequest` (earlyHintsOnRequest) with a fake renderer. What matters: the header is
// there on a shell render and identical for every visitor; absent on SHELL_CACHE_EXCLUDE / switch off / dynamic / data requests.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCsp } from '~/utils/csp';
import * as policy from '~/config/route-cache-policy';
import { shellRenderContext } from './shell-render-context.server';
import { earlyHintsOnRequest, shellEarlyHintsLink } from './early-reads.server';

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('base64');
const VISITORS: Record<string, Record<string, string>> = {
	anonymous: {},
	signedIn: { cookie: 'sr_cust=abc; sr_cust_csrf=x; sr_cart=tok-secret; countryCode=DE; authToken=t', authorization: 'Bearer secret', 'cf-ipcountry': 'DE' },
	otherCountry: { cookie: 'sr_cart=another-token; countryCode=IN', 'cf-ipcountry': 'IN' },
};

let savedEnv: string | undefined;
beforeEach(() => { savedEnv = process.env.SHELL_CACHE; process.env.SHELL_CACHE = '1'; });
afterEach(() => { if (savedEnv === undefined) delete process.env.SHELL_CACHE; else process.env.SHELL_CACHE = savedEnv; });

async function serve(enabled: boolean, exclude: string[], run: (get: (path: string, headers?: Record<string, string>) => Promise<Response>) => Promise<void>, sharedMapFlags: string[] = []) {
	const express = (await import('express')).default;
	const app = express();
	app.use(policy.createShellRequestMiddleware({ enabled, exclude }) as never);
	app.use((_req, res, next) => shellRenderContext.run(policy.isShellRender(res), next));
	app.use((_req, res, next) => { res.setHeader('Content-Security-Policy', buildCsp({ nonce: undefined })); next(); });
	app.use((_req, res, next) => { res.setHeader('Cache-Control', policy.NO_STORE_CACHE_CONTROL); next(); });
	app.use(policy.createShellCacheMiddleware({ enabled, ttlSeconds: 300, sha256Base64: sha }) as never);
	app.use(policy.shellRenderUrl as never);
	app.use((req, res) => {
		// The route's own onRequest, as Qwik Router calls it (url without the query a shell render has no use for, method, headers, sharedMap).
		const ev = { url: new URL(req.originalUrl, 'http://x'), method: req.method, headers: { set: (k: string, v: string) => res.setHeader(k, v) }, sharedMap: new Map(sharedMapFlags.map((k) => [k, true])) };
		void earlyHintsOnRequest(ev as never);
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.end('<html><head></head><body><script>window.a=1</script></body></html>');
	});
	const server = await new Promise<import('node:http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
	try {
		const { port } = server.address() as import('node:net').AddressInfo;
		await run((path, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'GET', headers, redirect: 'manual' }));
	} finally { await new Promise((resolve) => server.close(resolve)); }
}

describe('shell Link preload header', () => {
	it('/shop/ and /checkout/ shells carry it, identical for every visitor, and it names only fixed URLs', async () => {
		await serve(true, [], async (get) => {
			for (const path of ['/shop/', '/checkout/']) {
				const links: Record<string, string | null> = {};
				for (const [who, headers] of Object.entries(VISITORS)) {
					const r = await get(path, headers);
					expect(r.headers.get('x-sr-edge'), `${path} ${who}`).toBe('cacheable');
					links[who] = r.headers.get('link');
				}
				expect(links.anonymous, path).toMatch(/rel=preload; as=fetch; crossorigin=use-credentials/);
				expect(links.signedIn, path).toBe(links.anonymous);
				expect(links.otherCountry, path).toBe(links.anonymous);
				expect(links.anonymous, path).not.toMatch(/tok-secret|another-token|shipCountry|countryCode|authToken|sr_cust/);
				expect(links.anonymous, path).toBe(shellEarlyHintsLink(path));
			}
			const checkout = (await get('/checkout/')).headers.get('link')!;
			expect(checkout.split(', ')[0]).toBe('</api/live/checkout-summary/>; rel=preload; as=fetch; crossorigin=use-credentials');
		});
	});
	it('a tracking query on a shell path (still the shell) carries the same header', async () => {
		await serve(true, [], async (get) => {
			expect((await get('/checkout/?utm_source=x')).headers.get('link')).toBe((await get('/checkout/')).headers.get('link'));
		});
	});
	it('rollback: SHELL_CACHE_EXCLUDE paths carry NO Link header (the dynamic render, byte-identical to before); the other path keeps it', async () => {
		await serve(true, policy.shellExcludedPaths({ SHELL_CACHE_EXCLUDE: '/shop/, /checkout/' }), async (get) => {
			for (const path of ['/shop/', '/checkout/']) {
				for (const headers of Object.values(VISITORS)) {
					const r = await get(path, headers);
					expect(r.headers.get('x-sr-edge'), path).toBe('bypass:excluded');
					expect(r.headers.get('link'), path).toBeNull();
					expect(r.headers.get('cache-control'), path).toBe(policy.NO_STORE_CACHE_CONTROL);
				}
			}
		});
		await serve(true, ['/checkout'], async (get) => {
			expect((await get('/checkout/')).headers.get('link')).toBeNull();
			expect((await get('/shop/')).headers.get('link')).not.toBeNull();
		});
		await serve(true, ['/shop'], async (get) => {
			expect((await get('/shop/')).headers.get('link')).toBeNull();
			expect((await get('/checkout/')).headers.get('link')).not.toBeNull();
		});
	});
	it('switch off: no Link header on any path', async () => {
		process.env.SHELL_CACHE = '0';
		await serve(false, [], async (get) => {
			for (const path of ['/shop/', '/checkout/']) expect((await get(path)).headers.get('link'), path).toBeNull();
		});
	});
	it('a dynamic request (query other than tracking) and every other page carry none', async () => {
		await serve(true, [], async (get) => {
			for (const path of ['/shop/?facets=x', '/shop/?style=long', '/checkout/?conformance=1', '/checkout/payment/', '/', '/products/x/', '/account/']) {
				expect((await get(path, VISITORS.signedIn)).headers.get('link'), path).toBeNull();
			}
		});
	});
	it('a loader/action data request gets none even on a shell path', async () => {
		await serve(true, [], async (get) => {
			expect((await get('/shop/')).headers.get('link')).not.toBeNull();
		});
		await serve(true, [], async (get) => {
			expect((await get('/shop/')).headers.get('link')).toBeNull();
		}, ['@isQLoader']);
	});
});
