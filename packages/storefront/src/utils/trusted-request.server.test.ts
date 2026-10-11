// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRouterOrigin, trustedRequestOrigin, validatedRequestHost } from './trusted-request.server';

const TRUSTED = { SELLRIGHT_TRUST_FORWARDED_HOST: '1' };
const plainSocket = { encrypted: false };

describe('trustedRequestOrigin (framework form-POST origin check behind a TLS-terminating proxy)', () => {
	it('trusted proxy: forwarded https + forwarded host yield the browser-visible origin though the socket is http', () => {
		const req = { headers: { host: 'storefront:4100', 'x-forwarded-host': 'Shop.Example', 'x-forwarded-proto': 'https' }, socket: plainSocket };
		expect(trustedRequestOrigin(req, TRUSTED)).toBe('https://shop.example');
	});

	it('trusted proxy: takes the first hop, keeps a non-default port, falls back to the Host and socket when a header is absent', () => {
		expect(trustedRequestOrigin({ headers: { host: 'i:1', 'x-forwarded-host': 'shop.example:8443, evil.example', 'x-forwarded-proto': 'https, http' }, socket: plainSocket }, TRUSTED)).toBe('https://shop.example:8443');
		expect(trustedRequestOrigin({ headers: { host: 'shop.example', 'x-forwarded-proto': 'https' }, socket: plainSocket }, TRUSTED)).toBe('https://shop.example');
		expect(trustedRequestOrigin({ headers: { host: 'i:1', 'x-forwarded-host': 'shop.example' }, socket: { encrypted: true } }, TRUSTED)).toBe('https://shop.example');
		expect(trustedRequestOrigin({ headers: { host: 'i:1', 'x-forwarded-host': 'shop.example' }, socket: plainSocket }, TRUSTED)).toBe('http://shop.example');
	});

	it('trusted proxy: malformed values are ignored, never injected into the origin', () => {
		expect(trustedRequestOrigin({ headers: { host: 'h.example', 'x-forwarded-proto': 'javascript' }, socket: plainSocket }, TRUSTED)).toBeUndefined();
		expect(trustedRequestOrigin({ headers: { host: 'h.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'a.example/evil?x' }, socket: plainSocket }, TRUSTED)).toBe('https://h.example');
		expect(trustedRequestOrigin({ headers: { host: 'h.example', 'x-forwarded-host': 'a b.example\r\nx: y' }, socket: plainSocket }, TRUSTED)).toBeUndefined();
	});

	it('untrusted peer: forwarded headers are never honoured (framework default is kept)', () => {
		const req = { headers: { host: 'storefront:4100', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }, socket: plainSocket };
		expect(trustedRequestOrigin(req, {})).toBeUndefined();
		expect(trustedRequestOrigin(req, { SELLRIGHT_TRUST_FORWARDED_HOST: '0' })).toBeUndefined();
		expect(trustedRequestOrigin(req, { SELLRIGHT_TRUST_FORWARDED_HOST: 'true' })).toBeUndefined();
	});
});

describe('validatedRequestHost', () => {
	it('uses the connection Host unless a trusted proxy is declared', () => {
		const h = { host: 'a.example:4100', 'x-forwarded-host': 'b.example' };
		expect(validatedRequestHost(h, {})).toBe('a.example');
		expect(validatedRequestHost(h, TRUSTED)).toBe('b.example');
	});
});

describe('form POST through an HTTPS-terminating proxy, driven through the real Qwik router', () => {
	afterEach(() => vi.unstubAllEnvs());

	// createQwikRouter with the SAME getOrigin entry.express.tsx passes and an empty route trie: the framework's own CSRF
	// middleware runs first on every POST, so 403 = origin check failed, anything else (404 here) = it passed. A change
	// in how the framework derives or compares the origin changes these results.
	async function post(headers: Record<string, string>): Promise<number> {
		// @internal export, not in the public typings.
		const { _setRouterConfig } = (await import('@qwik.dev/router')) as unknown as { _setRouterConfig: (config: unknown) => void };
		_setRouterConfig({ routes: {}, serverPlugins: [], cacheModules: true, trailingSlash: false, basePathname: '/' });
		const { createQwikRouter } = await import('@qwik.dev/router/middleware/node');
		const { router } = createQwikRouter({ render: (async () => ({})) as never, getOrigin: getRouterOrigin });
		const { createServer, request } = await import('node:http');
		const server = createServer((req, res) => {
			void router(req, res, (err?: unknown) => {
				res.statusCode = err ? 500 : 404;
				res.end();
			});
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const { port } = server.address() as { port: number };
		try {
			return await new Promise<number>((resolve, reject) => {
				const r = request({ host: '127.0.0.1', port, method: 'POST', path: '/newsletter/confirm/x', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } }, (res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				});
				r.on('error', reject);
				r.end('a=b');
			});
		} finally {
			server.close();
		}
	}
	const viaProxy = { 'x-forwarded-host': 'shop.example', 'x-forwarded-proto': 'https', origin: 'https://shop.example' };

	it('succeeds when the proxy is trusted: forwarded proto https, socket http', async () => {
		vi.stubEnv('SELLRIGHT_TRUST_FORWARDED_HOST', '1');
		expect(await post(viaProxy)).toBe(404);
	});

	it('is rejected without the trust declaration (an untrusted forwarded header is not honoured)', async () => {
		vi.stubEnv('SELLRIGHT_TRUST_FORWARDED_HOST', '');
		expect(await post(viaProxy)).toBe(403);
	});

	it('a cross-site Origin is still rejected through a trusted proxy', async () => {
		vi.stubEnv('SELLRIGHT_TRUST_FORWARDED_HOST', '1');
		expect(await post({ ...viaProxy, origin: 'https://evil.example' })).toBe(403);
	});
});

describe('SSR store-resolution host (entry.express.tsx) uses the same trusted boundary', () => {
	it('never reads X-Forwarded-Host itself: the host threaded to sr() comes from validatedRequestHost', async () => {
		const { readFileSync } = await import('node:fs');
		const entry = readFileSync(`${process.cwd()}/src/entry.express.tsx`, 'utf8');
		expect(entry).toContain('const host = validatedRequestHost(req.headers) || undefined;');
		expect(entry).not.toMatch(/req\.headers\[['"]x-forwarded-host['"]\]/);
	});

	it('a forged X-Forwarded-Host yields the connection host unless a trusted proxy is declared; the port is dropped', () => {
		const h = { host: 'a.example:4100', 'x-forwarded-host': 'b.example' };
		expect(validatedRequestHost(h, {})).toBe('a.example');
		expect(validatedRequestHost(h, { SELLRIGHT_TRUST_FORWARDED_HOST: '1' })).toBe('b.example');
		expect(validatedRequestHost({ host: 'a.example', 'x-forwarded-host': 'bad host\r\n' }, { SELLRIGHT_TRUST_FORWARDED_HOST: '1' })).toBe(''); // unusable forwarded host fails closed
	});
});
