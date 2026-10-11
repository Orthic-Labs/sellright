import { describe, expect, it } from 'vitest';
import { trustedRequestOrigin, validatedRequestHost } from './trusted-request.server';

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

describe('form POST through an HTTPS-terminating proxy (real HTTP socket, the framework CSRF rule)', () => {
	// Mirrors @qwik.dev/router's csrfCheckMiddleware: a form POST is allowed only when its Origin header equals the
	// request URL's origin, and that origin is what getOrigin (entry.express.tsx) returns, else socket + Host.
	async function post(env: Record<string, string | undefined>, headers: Record<string, string>): Promise<number> {
		const { createServer, request } = await import('node:http');
		const server = createServer((req, res) => {
			const origin = trustedRequestOrigin(req, env) ?? `${(req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'}://${req.headers.host}`;
			const url = new URL(req.url ?? '/', origin);
			res.statusCode = req.headers.origin === url.origin ? 200 : 403;
			res.end();
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
		expect(await post(TRUSTED, viaProxy)).toBe(200);
	});

	it('is still rejected without the trust declaration (an untrusted forwarded header is not honoured)', async () => {
		expect(await post({}, viaProxy)).toBe(403);
	});

	it('a cross-site Origin is still rejected through a trusted proxy', async () => {
		expect(await post(TRUSTED, { ...viaProxy, origin: 'https://evil.example' })).toBe(403);
	});
});
