import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as confirmRoute from './confirm/[subscriber]/index';
import * as unsubscribeRoute from './unsubscribe/[subscriber]/index';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// The SellRight API (not Listmonk) is the only upstream: it answers the legacy-link POST.
const upstream = vi.fn(async (_url: string, _init?: RequestInit) => json(200, { result: 'confirmed', email: 'jo@x.test' }));

type Out = { status?: number; html?: string; noStore?: boolean };
async function call(handler: unknown, headers: Record<string, string>, method: 'GET' | 'POST' = 'GET'): Promise<Out> {
	const out: Out = {};
	await (handler as (ev: unknown) => Promise<void>)({
		params: { subscriber: UUID },
		request: new Request('http://internal.invalid/x', { method, headers }),
		html: (status: number, html: string) => Object.assign(out, { status, html }),
		cacheControl: (o: { noStore?: boolean }) => Object.assign(out, { noStore: o.noStore }),
	});
	return out;
}

describe.each([
	['confirm', confirmRoute],
	['unsubscribe', unsubscribeRoute],
] as const)('legacy newsletter %s route', (action, route) => {
	beforeEach(() => {
		upstream.mockClear();
		vi.stubGlobal('fetch', upstream);
		// No LISTMONK_STORES anywhere: the links must work from the API's store config alone.
		vi.stubEnv('LISTMONK_STORES', '');
		vi.stubEnv('SELLRIGHT_API_URL', 'http://api.internal:3300/');
		vi.stubEnv('SELLRIGHT_TRUST_FORWARDED_HOST', '');
		vi.stubEnv('VITE_SELLRIGHT_STORE_SLUG', '');
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it('GET shows a confirmation form and makes no upstream call at all', async () => {
		const r = await call(route.onGet, { host: 'a.example' });
		expect(r.status).toBe(200);
		expect(r.noStore).toBe(true);
		expect(r.html).toContain(`<form method="post" action="/newsletter/${action}/${UUID}">`);
		expect(upstream).not.toHaveBeenCalled();
	});

	it('POST asks the API to apply the action for the request host, with no Listmonk env needed', async () => {
		upstream.mockResolvedValueOnce(json(200, { result: action === 'confirm' ? 'confirmed' : 'unsubscribed', email: 'jo@x.test' }));
		const r = await call(route.onPost, { host: 'a.example', origin: 'https://a.example' }, 'POST');
		expect(r.status).toBe(200);
		expect(r.html).toContain('jo@x.test');
		expect(upstream).toHaveBeenCalledTimes(1);
		const [url, init] = upstream.mock.calls[0]!;
		expect(url).toBe(`http://api.internal:3300/v1/shop/newsletter/legacy/${action}/${UUID}`);
		expect(init?.method).toBe('POST');
		expect(init?.headers).toEqual({ 'x-forwarded-host': 'a.example' });
	});

	it('Host a + forged X-Forwarded-Host b without a trusted proxy uses a, never b', async () => {
		await call(route.onPost, { host: 'a.example', 'x-forwarded-host': 'b.example', origin: 'https://a.example' }, 'POST');
		expect(upstream.mock.calls[0]![1]?.headers).toEqual({ 'x-forwarded-host': 'a.example' });
	});

	it('a trusted proxy (SELLRIGHT_TRUST_FORWARDED_HOST=1) selects by X-Forwarded-Host', async () => {
		vi.stubEnv('SELLRIGHT_TRUST_FORWARDED_HOST', '1');
		await call(route.onPost, { host: 'internal.invalid', 'x-forwarded-host': 'b.example', origin: 'https://b.example' }, 'POST');
		expect(upstream.mock.calls[0]![1]?.headers).toEqual({ 'x-forwarded-host': 'b.example' });
	});

	it('a pinned deployment sends its store slug instead of a host', async () => {
		vi.stubEnv('VITE_SELLRIGHT_STORE_SLUG', 'store-a');
		await call(route.onPost, { host: 'a.example', origin: 'https://a.example' }, 'POST');
		expect(upstream.mock.calls[0]![1]?.headers).toEqual({ 'x-store-slug': 'store-a' });
	});

	it('a store without a Listmonk connection (API 404) shows a not-valid page', async () => {
		upstream.mockResolvedValueOnce(json(404, { error: { code: 'NOT_FOUND' } }));
		const r = await call(route.onPost, { host: 'c.example', origin: 'https://c.example' }, 'POST');
		expect(r.status).toBe(404);
	});

	it('API or upstream failure is a 502 page', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		upstream.mockResolvedValueOnce(json(502, {}));
		expect((await call(route.onPost, { host: 'a.example', origin: 'https://a.example' }, 'POST')).status).toBe(502);
		upstream.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		expect((await call(route.onPost, { host: 'a.example', origin: 'https://a.example' }, 'POST')).status).toBe(502);
		spy.mockRestore();
	});

	it('POST without a same-origin Origin is refused and contacts nothing', async () => {
		for (const origin of [undefined, 'https://b.example', 'null']) {
			const r = await call(route.onPost, origin ? { host: 'a.example', origin } : { host: 'a.example' }, 'POST');
			expect(r.status).toBe(403);
		}
		expect(upstream).not.toHaveBeenCalled();
	});
});
