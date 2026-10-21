import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const CUSTOMER = { id: 'c1', email: 'a@b.com', firstName: null, lastName: null, phone: null, emailVerified: true, isMigrated: false };

describe('Apple sign-in provider', () => {
	beforeEach(() => vi.resetModules());
	afterEach(() => vi.unstubAllGlobals());

	it('posts the identity token to /v1/shop/auth/apple and a success signs the shopper in', async () => {
		const mockedFetch = vi.fn(async () => jsonResponse(200, { token: 't', customer: CUSTOMER }));
		vi.stubGlobal('fetch', mockedFetch);
		const { loginWithApple } = await import('./apple-auth');
		expect(await loginWithApple('a'.repeat(40))).toEqual({ ok: true, customer: expect.objectContaining({ id: 'c1' }) });
		const [input] = mockedFetch.mock.calls[0] as unknown as [Request];
		expect(new URL(input.url).pathname).toBe('/v1/shop/auth/apple');
		expect(await input.clone().json()).toEqual({ identityToken: 'a'.repeat(40) });
	});

	it('202 (link mailed) is not a sign-in; 401 and 409 return messages, never ok', async () => {
		const { loginWithApple } = await import('./apple-auth');
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(202, { verificationRequired: true, nonce: 'n' })));
		const mailed = await loginWithApple('a'.repeat(40));
		expect(mailed.ok).toBe(false);
		if (!mailed.ok) expect(mailed.message).toMatch(/check your email/i);
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: { code: 'APPLE_TOKEN_INVALID', message: 'bad' } })));
		const bad = await loginWithApple('a'.repeat(40));
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.message).not.toMatch(/password/i);
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, { error: { code: 'X', message: 'not configured' } })));
		expect((await loginWithApple('a'.repeat(40))).ok).toBe(false);
	});
});

describe('Apple SDK loader', () => {
	const scripts = () => Array.from(document.head.querySelectorAll<HTMLScriptElement>('script[src*="appleid.cdn-apple.com"]'));
	const setApple = (auth: unknown) => ((window as unknown as { AppleID?: unknown }).AppleID = auth ? { auth } : undefined);

	beforeEach(() => {
		vi.resetModules();
		setApple(undefined);
		document.head.innerHTML = '';
	});
	afterEach(() => {
		vi.useRealTimers();
		setApple(undefined);
		document.head.innerHTML = '';
	});

	it('loads the SDK on demand, initialises it for a popup on this origin, and returns the identity token', async () => {
		const auth = { init: vi.fn(), signIn: vi.fn(async () => ({ authorization: { id_token: 'IDT' } })) };
		const { signInWithApple } = await import('./apple-auth');
		const p = signInWithApple('com.example.web');
		expect(scripts()).toHaveLength(1);
		setApple(auth);
		scripts()[0].onload?.(new Event('load'));
		expect(await p).toEqual({ status: 'token', identityToken: 'IDT' });
		expect(auth.init).toHaveBeenCalledWith({ clientId: 'com.example.web', scope: 'name email', redirectURI: `${window.location.origin}/sign-in`, usePopup: true });
	});

	it('a closed popup is cancelled; a missing token or a failed download is unavailable (and a retry reloads)', async () => {
		const { signInWithApple } = await import('./apple-auth');
		const failed = signInWithApple('c');
		scripts()[0].onerror?.(new Event('error'));
		expect(await failed).toEqual({ status: 'unavailable' });
		expect(scripts()).toHaveLength(0);

		const auth = { init: vi.fn(), signIn: vi.fn() };
		setApple(auth);
		auth.signIn.mockRejectedValueOnce({ error: 'popup_closed_by_user' });
		expect(await signInWithApple('c')).toEqual({ status: 'cancelled' });
		auth.signIn.mockResolvedValueOnce({});
		expect(await signInWithApple('c')).toEqual({ status: 'unavailable' });
	});
});
