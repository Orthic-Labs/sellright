import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as confirmRoute from './confirm/[subscriber]/index';
import * as unsubscribeRoute from './unsubscribe/[subscriber]/index';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const entry = (name: string, extra: Record<string, unknown> = {}) => ({ baseUrl: `http://listmonk-${name}:9000`, user: 'u', token: `secret-${name}`, listId: 7, brandName: `Store ${name.toUpperCase()}`, ...extra });
const stores = (extra: Record<string, Record<string, unknown>> = {}) => JSON.stringify({ 'a.example': entry('a', extra.a), 'b.example': entry('b', extra.b) });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const upstream = vi.fn(async (_url: string, init?: RequestInit) =>
	init?.method === 'PUT' ? json({ data: true }) : json({ data: { results: [{ id: 42, uuid: UUID, email: 'jo@x.test', lists: [{ id: 7, subscription_status: 'confirmed' }] }] } }));

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
		vi.stubEnv('LISTMONK_STORES', stores());
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

	it('POST performs the action upstream (the store list only) and is idempotent', async () => {
		const r = await call(route.onPost, { host: 'a.example', origin: 'https://a.example' }, 'POST');
		expect(r.status).toBe(200);
		const methods = upstream.mock.calls.map((c) => c[1]?.method ?? 'GET');
		// A subscriber already confirmed / still subscribed gets lookup (+ a PUT only when the state has to change).
		expect(methods[0]).toBe('GET');
		expect(methods.filter((m) => m === 'PUT').length).toBe(action === 'unsubscribe' ? 1 : 0);
	});

	it('Host a + forged X-Forwarded-Host b without a trusted proxy uses a, never b', async () => {
		const g = await call(route.onGet, { host: 'a.example', 'x-forwarded-host': 'b.example' });
		expect(g.html).toContain('Store A');
		expect(g.html).not.toContain('Store B');
		await call(route.onPost, { host: 'a.example', 'x-forwarded-host': 'b.example', origin: 'https://a.example' }, 'POST');
		expect(upstream).toHaveBeenCalled();
		for (const [url, init] of upstream.mock.calls) {
			expect(url.startsWith('http://listmonk-a:9000/')).toBe(true);
			expect(String((init?.headers as Record<string, string>).Authorization)).toBe('Basic ' + Buffer.from('u:secret-a').toString('base64'));
		}
	});

	it('a trusted proxy (SELLRIGHT_TRUST_FORWARDED_HOST=1) selects by X-Forwarded-Host', async () => {
		vi.stubEnv('SELLRIGHT_TRUST_FORWARDED_HOST', '1');
		const g = await call(route.onGet, { host: 'internal.invalid', 'x-forwarded-host': 'b.example' });
		expect(g.status).toBe(200);
		expect(g.html).toContain('Store B');
	});

	it('an unknown host is 404 with no upstream call, on GET and POST, even with a forged X-Forwarded-Host', async () => {
		const cases: Array<Record<string, string>> = [{ host: 'c.example' }, { host: 'c.example', 'x-forwarded-host': 'a.example' }, { host: 'internal.invalid', 'x-forwarded-host': 'a.example' }];
		for (const headers of cases) {
			expect((await call(route.onGet, headers)).status).toBe(404);
			expect((await call(route.onPost, { ...headers, origin: `https://${headers.host}` }, 'POST')).status).toBe(404);
		}
		expect(upstream).not.toHaveBeenCalled();
	});

	it('POST without a same-origin Origin is refused and contacts nothing', async () => {
		for (const origin of [undefined, 'https://b.example', 'null']) {
			const r = await call(route.onPost, origin ? { host: 'a.example', origin } : { host: 'a.example' }, 'POST');
			expect(r.status).toBe(403);
		}
		expect(upstream).not.toHaveBeenCalled();
	});

	it('a pinned deployment serves only the entry for the pinned store', async () => {
		vi.stubEnv('VITE_SELLRIGHT_STORE_SLUG', 'store-a');
		vi.stubEnv('LISTMONK_STORES', stores({ a: { storeSlug: 'store-a' } }));
		expect((await call(route.onGet, { host: 'a.example' })).status).toBe(200);
		expect((await call(route.onGet, { host: 'b.example' })).status).toBe(404);
		expect(upstream).not.toHaveBeenCalled();
	});
});
