import { describe, expect, it, vi } from 'vitest';
import { handleListmonkLink, isSameOriginPost, newsletterRequestHost, normalizeHost, renderListmonkConfirmPage, resolveListmonkConfig } from './listmonk.server';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const STORES = JSON.stringify({
	'a.example': { baseUrl: 'http://listmonk-a:9000/', user: 'ua', token: 'secret-a', listId: 7, brandName: 'Store A' },
	'b.example': { baseUrl: 'http://listmonk-b:9000', user: 'ub', token: 'secret-b', listId: 9 },
});
const env = { LISTMONK_STORES: STORES };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const subscriber = (status: 'confirmed' | 'unconfirmed' | 'unsubscribed' | null, listId = 7) => ({
	data: { results: [{ id: 42, uuid: UUID, email: 'jo@x.test', lists: status ? [{ id: listId, subscription_status: status }] : [] }] },
});

describe('listmonk legacy links', () => {
	it('not configured: 404 and nothing is contacted (no map, unknown host, broken map)', async () => {
		const fetchImpl = vi.fn();
		for (const e of [{}, env, { LISTMONK_STORES: '{nope' }]) {
			const host = e === env ? 'other.example' : 'a.example';
			const r = await handleListmonkLink('confirm', { host, uuid: UUID, env: e, fetchImpl });
			expect(r.status).toBe(404);
		}
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("resolves per host: one store's endpoint and list are never used for another", async () => {
		expect(resolveListmonkConfig('a.example:443', env)).toMatchObject({ baseUrl: 'http://listmonk-a:9000', listId: 7, rootUrl: 'https://a.example' });
		expect(resolveListmonkConfig('B.example', env)).toMatchObject({ baseUrl: 'http://listmonk-b:9000', listId: 9 });
		expect(resolveListmonkConfig('c.example', env)).toBeNull();
		expect(resolveListmonkConfig('__proto__', env)).toBeNull();
		const fetchImpl = vi.fn(async () => json(200, subscriber('confirmed', 9)));
		await handleListmonkLink('confirm', { host: 'b.example', uuid: UUID, env, fetchImpl });
		const [url] = fetchImpl.mock.calls[0] as unknown as [string];
		expect(url.startsWith('http://listmonk-b:9000/api/subscribers')).toBe(true);
	});

	it('confirm: adds the subscriber to this store list as confirmed', async () => {
		const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => (init?.method === 'PUT' ? json(200, { data: true }) : json(200, subscriber('unconfirmed'))));
		const r = await handleListmonkLink('confirm', { host: 'a.example', uuid: UUID, env, fetchImpl: fetchImpl as unknown as typeof fetch });
		expect(r.status).toBe(200);
		expect(r.html).toContain('jo@x.test');
		const put = fetchImpl.mock.calls[1];
		expect(JSON.parse(String(put[1]?.body))).toEqual({ ids: [42], action: 'add', target_list_ids: [7], status: 'confirmed' });
		expect((put[1]?.headers as Record<string, string>).Authorization).toBe('Basic ' + Buffer.from('ua:secret-a').toString('base64'));
		expect(r.html).not.toContain('secret-a');
	});

	it('unsubscribe: removes from this list only, and is idempotent', async () => {
		const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => (init?.method === 'PUT' ? json(200, {}) : json(200, subscriber('confirmed'))));
		expect((await handleListmonkLink('unsubscribe', { host: 'a.example', uuid: UUID, env, fetchImpl: fetchImpl as unknown as typeof fetch })).status).toBe(200);
		expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toMatchObject({ action: 'unsubscribe', target_list_ids: [7] });
		const again = vi.fn(async () => json(200, subscriber('unsubscribed')));
		const r = await handleListmonkLink('unsubscribe', { host: 'a.example', uuid: UUID, env, fetchImpl: again });
		expect(r.status).toBe(200);
		expect(again).toHaveBeenCalledTimes(1); // lookup only, no write
	});

	it('malformed or unknown id: 404', async () => {
		const none = vi.fn(async () => json(200, { data: { results: [] } }));
		expect((await handleListmonkLink('confirm', { host: 'a.example', uuid: 'not-a-uuid', env, fetchImpl: none })).status).toBe(404);
		expect(none).not.toHaveBeenCalled();
		expect((await handleListmonkLink('confirm', { host: 'a.example', uuid: UUID, env, fetchImpl: none })).status).toBe(404);
	});

	it('upstream failure: 502 without leaking the credential', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		for (const fetchImpl of [vi.fn(async () => json(500, {})), vi.fn(async () => { throw new Error('ECONNREFUSED'); })]) {
			const r = await handleListmonkLink('unsubscribe', { host: 'a.example', uuid: UUID, env, fetchImpl: fetchImpl as unknown as typeof fetch });
			expect(r.status).toBe(502);
			expect(r.html).not.toContain('secret-a');
		}
		spy.mockRestore();
	});
});

describe('listmonk host validation, confirmation page and pin', () => {
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
		for (const bad of ['a.example/evil', 'a b', '[::1]', '-a.example', 'a.example\n', '__proto__']) expect(normalizeHost(bad)).toBe('');
	});

	it('a pinned deployment serves only the entry that declares the pinned store', () => {
		const pinned = { LISTMONK_STORES: JSON.stringify({ 'a.example': { baseUrl: 'http://l:9000', user: 'u', token: 't', listId: 1, storeSlug: 'store-a' }, 'b.example': { baseUrl: 'http://l:9000', user: 'u', token: 't', listId: 2 } }) };
		expect(resolveListmonkConfig('a.example', pinned, 'store-a')).toMatchObject({ listId: 1 });
		expect(resolveListmonkConfig('a.example', pinned, 'other')).toBeNull();
		expect(resolveListmonkConfig('b.example', pinned, 'store-a')).toBeNull();
		expect(resolveListmonkConfig('b.example', pinned, '')).toMatchObject({ listId: 2 }); // no pin: unchanged
		expect(resolveListmonkConfig('a.example', { ...pinned, VITE_SELLRIGHT_STORE_SLUG: 'other' })).toBeNull(); // pin read from env too
	});

	it('GET page: a form that POSTs, no upstream call; 404 for an unconfigured host or malformed id', () => {
		const r = renderListmonkConfirmPage('unsubscribe', { host: 'a.example', uuid: UUID, env });
		expect(r.status).toBe(200);
		expect(r.html).toContain(`<form method="post" action="/newsletter/unsubscribe/${UUID}">`);
		expect(r.html).not.toContain('jo@x.test');
		expect(renderListmonkConfirmPage('confirm', { host: 'a.example', uuid: UUID, env }).html).toContain(`action="/newsletter/confirm/${UUID}"`);
		expect(renderListmonkConfirmPage('confirm', { host: 'c.example', uuid: UUID, env }).status).toBe(404);
		expect(renderListmonkConfirmPage('confirm', { host: 'a.example', uuid: 'x"><script>', env }).status).toBe(404);
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
