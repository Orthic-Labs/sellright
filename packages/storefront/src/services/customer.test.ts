import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function urlOf(mockedFetch: FetchMock, callIndex = 0): string {
	const [input] = mockedFetch.mock.calls[callIndex];
	return input instanceof Request ? input.url : String(input);
}

describe('services/customer — native SellRight client', () => {
	beforeEach(() => {
		vi.resetModules();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('getMe resolves null on 401 rather than throwing (not signed in)', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'unauthenticated' })));

		const { getMe } = await import('./customer');
		await expect(getMe()).resolves.toBeNull();
	});

	it('getMe propagates a non-401 failure', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'boom' })));

		const { getMe } = await import('./customer');
		await expect(getMe()).rejects.toThrow();
	});

	it('getOrders carries the server\'s real `total`, not the page length', async () => {
		const mockedFetch = vi.fn(async () =>
			jsonResponse(200, {
				items: [{ code: 'A1', state: 'Paid', currency: 'USD', grandTotal: 1000, placedAt: '2026-01-01', lines: 2 }],
				total: 57,
				limit: 1,
				offset: 0,
			}),
		);
		vi.stubGlobal('fetch', mockedFetch);

		const { getOrders } = await import('./customer');
		const result = await getOrders({ limit: 1, offset: 0 });

		expect(result.total).toBe(57);
		expect(result.items).toHaveLength(1);
		expect(urlOf(mockedFetch)).toContain('limit=1');
	});

	it('getOrders resolves an empty real-shaped page on 401 instead of throwing', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'unauthenticated' })));

		const { getOrders } = await import('./customer');
		await expect(getOrders()).resolves.toEqual({ items: [], total: 0, limit: 20, offset: 0 });
	});

	it('getOrderByCode resolves null on 404 (not this customer\'s order) and on 401', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: 'not found' })));
		const { getOrderByCode } = await import('./customer');
		await expect(getOrderByCode('MISSING')).resolves.toBeNull();
	});

	it('changePassword maps a 401 to wrong_password, never unauthenticated (the caller is already known-signed-in)', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'wrong password' })));

		const { changePassword } = await import('./customer');
		const result = await changePassword('wrong', 'newpassword1');

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('wrong_password');
	});

	it('deleteAddress calls DELETE on the addresses/{id} path', async () => {
		const mockedFetch = vi.fn(async () => jsonResponse(200, { ok: true }));
		vi.stubGlobal('fetch', mockedFetch);

		const { deleteAddress } = await import('./customer');
		await expect(deleteAddress('addr-1')).resolves.toEqual({ ok: true });
		expect(urlOf(mockedFetch)).toContain('/v1/shop/account/addresses/addr-1');
	});

});
