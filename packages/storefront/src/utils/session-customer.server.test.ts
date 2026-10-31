import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ boot: vi.fn() }));
vi.mock('~/providers/shop/account/bootstrap.server', () => ({ bootstrapCustomer: api.boot }));
import { resolveSessionCustomer } from './session-customer.server';

function request(cookies: Record<string, string>, opts: { isDemo?: boolean; protocol?: string } = {}) {
	const set = vi.fn();
	const append = vi.fn();
	return {
		set, append,
		req: {
			cookie: { get: (n: string) => (n in cookies ? { value: cookies[n] } : null), set },
			headers: { append },
			url: new URL(`${opts.protocol ?? 'https:'}//shop.example/api/session/`),
			sharedMap: new Map<string, unknown>(),
			isDemo: !!opts.isDemo,
		},
	};
}

beforeEach(() => { api.boot.mockReset(); });

describe('GET /api/session/ (ADR-0001 I-2: identity leaves the page HTML)', () => {
	it('answers anonymous without an API read when the browser holds no credentials, and sets no cookie', async () => {
		const { req, set } = request({ countryCode: 'DE', sr_cart: 't' });
		expect(await resolveSessionCustomer(req)).toEqual({ customer: null });
		expect(api.boot).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
	});

	it('never reads a session on the demo', async () => {
		const { req } = request({ sr_cust: 'x' }, { isDemo: true });
		expect(await resolveSessionCustomer(req)).toEqual({ customer: null });
		expect(api.boot).not.toHaveBeenCalled();
	});

	it('returns the API-validated customer and forwards adoption through the response headers', async () => {
		api.boot.mockResolvedValue({ id: 'c1', firstName: 'Ada', lastName: null, email: 'ada@example.com' });
		const { req, set } = request({ sr_cust: 'opaque' });
		expect(await resolveSessionCustomer(req)).toEqual({ customer: { id: 'c1', firstName: 'Ada', lastName: '', emailAddress: 'ada@example.com' } });
		expect(api.boot).toHaveBeenCalledWith(req.headers, req.sharedMap);
		expect(set).not.toHaveBeenCalled();
	});

	it('sets the sr_legacy_cart hint (moved from the root layout) only for legacy transport without sr_cust', async () => {
		api.boot.mockResolvedValue({ id: 'c2', firstName: 'B', lastName: 'C', email: 'b@example.com' });
		for (const name of ['authToken', '__vendure_session']) {
			const { req, set } = request({ [name]: 'legacy' });
			await resolveSessionCustomer(req);
			expect(set).toHaveBeenCalledWith('sr_legacy_cart', '1', { path: '/', maxAge: 3600, sameSite: 'lax', secure: true });
		}
		const http = request({ authToken: 'legacy' }, { protocol: 'http:' });
		await resolveSessionCustomer(http.req);
		expect(http.set).toHaveBeenCalledWith('sr_legacy_cart', '1', expect.objectContaining({ secure: false }));
		const both = request({ authToken: 'legacy', sr_cust: 'x' });
		await resolveSessionCustomer(both.req);
		expect(both.set).not.toHaveBeenCalled();
	});

	it('treats a 401 as signed out and rethrows any other failure', async () => {
		api.boot.mockRejectedValueOnce(Object.assign(new Error('revoked'), { status: 401 }));
		expect(await resolveSessionCustomer(request({ sr_cust: 'x' }).req)).toEqual({ customer: null });
		const down = new Error('unavailable');
		api.boot.mockRejectedValueOnce(down);
		await expect(resolveSessionCustomer(request({ sr_cust: 'x' }).req)).rejects.toBe(down);
	});
});
