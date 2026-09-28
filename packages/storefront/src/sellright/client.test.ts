import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('SellRightError.code extraction', () => {
	beforeEach(() => {
		vi.resetModules();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('reads `code` from the top level, sibling to a string `error` message (the API\'s actual error envelope)', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { error: 'please verify your email', code: 'not_verified' })));

		const { sellright, SellRightError } = await import('./client');
		try {
			await sellright().POST('/v1/shop/auth/login', { body: { email: 'a@b.com', password: 'x' } });
			throw new Error('expected sellright() to throw');
		} catch (e) {
			expect(e).toBeInstanceOf(SellRightError);
			const err = e as InstanceType<typeof SellRightError>;
			expect(err.status).toBe(403);
			expect(err.code).toBe('not_verified');
			expect(err.message).toBe('please verify your email');
		}
	});

	it('leaves `code` undefined when the API response carries none', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'invalid credentials' })));

		const { sellright, SellRightError } = await import('./client');
		try {
			await sellright().POST('/v1/shop/auth/login', { body: { email: 'a@b.com', password: 'x' } });
			throw new Error('expected sellright() to throw');
		} catch (e) {
			expect(e).toBeInstanceOf(SellRightError);
			const err = e as InstanceType<typeof SellRightError>;
			expect(err.code).toBeUndefined();
			expect(err.message).toBe('invalid credentials');
		}
	});

	it('falls back to a generic HTTP message when the body has no error/code at all', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));

		const { sellright, SellRightError } = await import('./client');
		try {
			await sellright().GET('/v1/shop/auth/me');
			throw new Error('expected sellright() to throw');
		} catch (e) {
			expect(e).toBeInstanceOf(SellRightError);
			const err = e as InstanceType<typeof SellRightError>;
			expect(err.status).toBe(500);
			expect(err.message).toBe('HTTP 500');
		}
	});
});
