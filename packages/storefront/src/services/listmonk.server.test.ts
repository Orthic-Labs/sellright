import { describe, expect, it, vi } from 'vitest';
import { handleListmonkLink, isSameOriginPost, newsletterRequestHost, normalizeHost, renderListmonkConfirmPage } from './listmonk.server';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const API = 'http://api.internal:3300';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const api = (status: number, body: unknown) => vi.fn(async (_u: string, _i?: RequestInit) => json(status, body));
const link = (action: 'confirm' | 'unsubscribe', fetchImpl: ReturnType<typeof api>, extra: Record<string, unknown> = {}) =>
	handleListmonkLink(action, { host: 'a.example', uuid: UUID, apiBase: API, fetchImpl: fetchImpl as unknown as typeof fetch, ...extra });

describe('listmonk legacy links (via the SellRight API)', () => {
	it('posts to the API legacy endpoint with the validated host; no Listmonk credential or URL is involved', async () => {
		const f = api(200, { result: 'confirmed', email: 'jo@x.test' });
		const r = await link('confirm', f);
		expect(r.status).toBe(200);
		expect(r.html).toContain('jo@x.test');
		const [url, init] = f.mock.calls[0]!;
		expect(url).toBe(`${API}/v1/shop/newsletter/legacy/confirm/${UUID}`);
		expect(init?.method).toBe('POST');
		expect(init?.headers).toEqual({ 'x-forwarded-host': 'a.example' });
	});

	it('a store pin is sent as x-store-slug instead of the host', async () => {
		const f = api(200, { result: 'unsubscribed', email: 'jo@x.test' });
		await link('unsubscribe', f, { storePin: 'store-a', apiBase: API + '/' });
		expect(f.mock.calls[0]![0]).toBe(`${API}/v1/shop/newsletter/legacy/unsubscribe/${UUID}`);
		expect(f.mock.calls[0]![1]?.headers).toEqual({ 'x-store-slug': 'store-a' });
	});

	it('renders each API outcome and escapes the address', async () => {
		expect((await link('confirm', api(200, { result: 'already_confirmed', email: 'jo@x.test' }))).html).toContain('You&#39;re already in');
		expect((await link('confirm', api(200, { result: 'already_unsubscribed', email: 'jo@x.test' }))).html).toContain('Sign up again');
		const un = await link('unsubscribe', api(200, { result: 'unsubscribed', email: 'a<b>@x.test' }));
		expect(un.html).toContain('You&#39;re unsubscribed');
		expect(un.html).toContain('a&lt;b&gt;@x.test');
	});

	it('unusable host, malformed id or an API 404: 404, and the API is not asked for the first two', async () => {
		const f = api(200, { result: 'confirmed', email: 'jo@x.test' });
		expect((await link('confirm', f, { host: '' })).status).toBe(404);
		expect((await link('confirm', f, { uuid: 'not-a-uuid' })).status).toBe(404);
		expect(f).not.toHaveBeenCalled();
		expect((await link('confirm', api(404, { error: {} }))).status).toBe(404);
	});

	it('API failure, bad payload or network error: 502', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect((await link('unsubscribe', api(502, {}))).status).toBe(502);
		expect((await link('unsubscribe', api(200, { nope: true }))).status).toBe(502);
		const down = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
		expect((await link('unsubscribe', down as unknown as ReturnType<typeof api>)).status).toBe(502);
		spy.mockRestore();
	});
});

describe('listmonk host validation and confirmation page', () => {
	it('uses the connection Host unless a trusted proxy is declared; never a lone X-Forwarded-Host', () => {
		const h = { host: 'a.example:4100', forwardedHost: 'b.example' };
		expect(newsletterRequestHost(h, {})).toBe('a.example');
		expect(newsletterRequestHost(h, { SELLRIGHT_TRUST_FORWARDED_HOST: '0' })).toBe('a.example');
		expect(newsletterRequestHost(h, { SELLRIGHT_TRUST_FORWARDED_HOST: 'true' })).toBe('a.example'); // only '1' opts in
		expect(newsletterRequestHost(h, { SELLRIGHT_TRUST_FORWARDED_HOST: '1' })).toBe('b.example');
		expect(newsletterRequestHost({ host: 'a.example' }, { SELLRIGHT_TRUST_FORWARDED_HOST: '1' })).toBe('a.example');
		expect(newsletterRequestHost({ host: null, forwardedHost: 'b.example' }, {})).toBe('');
	});

	it('rejects a host with unusable characters', () => {
		for (const bad of ['a.example/evil', 'a b', '[::1]', '-a.example', 'a.example\n', '__proto__x_']) expect(normalizeHost(bad)).toBe('');
	});

	it('GET page: a form that POSTs, no upstream call; 404 for a malformed id', () => {
		const r = renderListmonkConfirmPage('unsubscribe', { uuid: UUID });
		expect(r.status).toBe(200);
		expect(r.html).toContain(`<form method="post" action="/newsletter/unsubscribe/${UUID}">`);
		expect(renderListmonkConfirmPage('confirm', { uuid: UUID }).html).toContain(`action="/newsletter/confirm/${UUID}"`);
		expect(renderListmonkConfirmPage('confirm', { uuid: 'x"><script>' }).status).toBe(404);
	});

	it('same-origin POST check fails closed', () => {
		expect(isSameOriginPost('https://a.example', 'a.example')).toBe(true);
		expect(isSameOriginPost('https://a.example:8443', 'a.example')).toBe(true);
		expect(isSameOriginPost('https://b.example', 'a.example')).toBe(false);
		expect(isSameOriginPost(null, 'a.example')).toBe(false);
		expect(isSameOriginPost('null', 'a.example')).toBe(false);
		expect(isSameOriginPost('https://a.example', '')).toBe(false);
	});
});
