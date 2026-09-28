import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FetchMock = ReturnType<typeof vi.fn>;

async function bodyOf(mockedFetch: FetchMock, callIndex = 0): Promise<any> {
	const [input] = mockedFetch.mock.calls[callIndex];
	const text = input instanceof Request ? await input.clone().text() : String((input as RequestInit)?.body ?? '{}');
	return JSON.parse(text || '{}');
}

function urlOf(mockedFetch: FetchMock, callIndex = 0): string {
	const [input] = mockedFetch.mock.calls[callIndex];
	return input instanceof Request ? input.url : String(input);
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('providers/shop/account/account — native SellRight client', () => {
	beforeEach(() => {
		vi.resetModules();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('login forwards rememberMe to the API (not silently dropped)', async () => {
		const mockedFetch = vi.fn(async () =>
			jsonResponse(200, { token: 't', customer: { id: 'c1', email: 'a@b.com', firstName: null, lastName: null, phone: null, emailVerified: true, isMigrated: false } }),
		);
		vi.stubGlobal('fetch', mockedFetch);

		const { login } = await import('./account');
		const result = await login('a@b.com', 'pw', { rememberMe: false, turnstileToken: 'tok' });

		expect(result).toEqual({ ok: true, customer: expect.objectContaining({ id: 'c1', email: 'a@b.com' }) });
		const body = await bodyOf(mockedFetch);
		expect(body.rememberMe).toBe(false);
		expect(body.turnstileToken).toBe('tok');
	});

	it('login surfaces the not_verified case via SellRightError.code, not a __typename union', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { error: 'email not verified', code: 'not_verified' })));

		const { login } = await import('./account');
		const result = await login('a@b.com', 'wrongish');

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('not_verified');
			expect(result).not.toHaveProperty('__typename');
			expect(result).not.toHaveProperty('errorCode');
		}
	});

	it('login maps a 401 to invalid_credentials', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'bad credentials' })));

		const { login } = await import('./account');
		const result = await login('a@b.com', 'wrong');

		expect(result).toEqual({ ok: false, code: 'invalid_credentials', message: 'Invalid email or password.' });
	});

	it('login maps a 429 to rate_limited', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(429, { error: 'slow down' })));

		const { login } = await import('./account');
		const result = await login('a@b.com', 'x');

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('rate_limited');
	});

	it('logout reports ok:true on a clean 200', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: true })));

		const { logout } = await import('./account');
		await expect(logout()).resolves.toEqual({ ok: true });
	});

	it('logout surfaces a real CSRF failure (403) instead of pretending success', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { error: 'csrf mismatch' })));

		const { logout } = await import('./account');
		const result = await logout();

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBeTruthy();
	});

	it('logout surfaces a transport failure rather than swallowing it', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

		const { logout } = await import('./account');
		const result = await logout();

		expect(result).toEqual({ ok: false, error: 'network down' });
	});

	it('register maps a 409 to email_taken', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, { error: 'email taken' })));

		const { register } = await import('./account');
		const result = await register({ email: 'a@b.com', password: 'password123' });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('email_taken');
	});

	it('register forwards turnstileToken', async () => {
		const mockedFetch = vi.fn(async () =>
			jsonResponse(200, { token: 't', customer: { id: 'c1', email: 'a@b.com', firstName: 'A', lastName: 'B', phone: null, emailVerified: false, isMigrated: false } }),
		);
		vi.stubGlobal('fetch', mockedFetch);

		const { register } = await import('./account');
		await register({ email: 'a@b.com', password: 'password123', turnstileToken: 'reg-tok' });

		const body = await bodyOf(mockedFetch);
		expect(body.turnstileToken).toBe('reg-tok');
	});

	it('resendVerification is enumeration-safe: resolves ok:true even on failure', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'boom' })));

		const { resendVerification } = await import('./account');
		await expect(resendVerification('a@b.com')).resolves.toEqual({ ok: true });
	});

	it('requestPasswordReset is enumeration-safe: resolves ok:true even on failure', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'boom' })));

		const { requestPasswordReset } = await import('./account');
		await expect(requestPasswordReset('a@b.com')).resolves.toEqual({ ok: true });
	});

	it('resetPassword maps a 409 to invalid_token', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, { error: 'expired' })));

		const { resetPassword } = await import('./account');
		const result = await resetPassword('tok', 'newpassword1');

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('invalid_token');
	});

	it('verifyEmail resolves ok:true on success and posts the token', async () => {
		const mockedFetch = vi.fn(async () => jsonResponse(200, { ok: true }));
		vi.stubGlobal('fetch', mockedFetch);

		const { verifyEmail } = await import('./account');
		await expect(verifyEmail('verify-tok')).resolves.toEqual({ ok: true });
		expect((await bodyOf(mockedFetch)).token).toBe('verify-tok');
	});

	it('requestEmailChange maps 401 to wrong_password and 409 to email_unavailable', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'bad password' })));
		let { requestEmailChange } = await import('./account');
		let result = await requestEmailChange('new@b.com', 'wrongpw');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('wrong_password');

		vi.resetModules();
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, { error: 'taken' })));
		({ requestEmailChange } = await import('./account'));
		result = await requestEmailChange('new@b.com', 'pw');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('email_unavailable');
	});

	it('requestEmailChange posts newEmail + password to the request-email-change endpoint', async () => {
		const mockedFetch = vi.fn(async () => jsonResponse(200, { ok: true }));
		vi.stubGlobal('fetch', mockedFetch);

		const { requestEmailChange } = await import('./account');
		await requestEmailChange('new@b.com', 'currentpw');

		expect(urlOf(mockedFetch)).toContain('/v1/shop/auth/request-email-change');
		const body = await bodyOf(mockedFetch);
		expect(body).toEqual({ newEmail: 'new@b.com', password: 'currentpw' });
	});

	it('verifyEmailChange posts the token to verify-email-change and maps 409 to invalid_token', async () => {
		const mockedFetch = vi.fn(async () => jsonResponse(409, { error: 'expired' }));
		vi.stubGlobal('fetch', mockedFetch);

		const { verifyEmailChange } = await import('./account');
		const result = await verifyEmailChange('change-tok');

		expect(urlOf(mockedFetch)).toContain('/v1/shop/auth/verify-email-change');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('invalid_token');
	});

	it('updateProfile PATCHes /v1/shop/account/me and returns the updated profile', async () => {
		const mockedFetch = vi.fn(async () =>
			jsonResponse(200, { id: 'c1', email: 'a@b.com', firstName: 'New', lastName: 'Name', phone: '555' }),
		);
		vi.stubGlobal('fetch', mockedFetch);

		const { updateProfile } = await import('./account');
		const result = await updateProfile({ firstName: 'New', lastName: 'Name', phone: '555' });

		expect(result.firstName).toBe('New');
		expect(urlOf(mockedFetch)).toContain('/v1/shop/account/me');
	});
});
