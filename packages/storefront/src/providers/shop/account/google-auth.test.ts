import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleClientId, googleIdentityCsp } from '~/config/google-signin';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const CUSTOMER = { id: 'c1', email: 'a@b.com', firstName: null, lastName: null, phone: null, emailVerified: true, isMigrated: false };

describe('Google sign-in provider', () => {
	beforeEach(() => vi.resetModules());
	afterEach(() => vi.unstubAllGlobals());

	it('posts the Google credential to /v1/shop/auth/google and a success signs the shopper in', async () => {
		const mockedFetch = vi.fn(async () => jsonResponse(200, { token: 't', customer: CUSTOMER }));
		vi.stubGlobal('fetch', mockedFetch);
		const { loginWithGoogle } = await import('./google-auth');
		const result = await loginWithGoogle('g'.repeat(40));

		expect(result).toEqual({ ok: true, customer: expect.objectContaining({ id: 'c1' }) });
		const [input] = mockedFetch.mock.calls[0] as unknown as [Request];
		expect(new URL(input.url).pathname).toBe('/v1/shop/auth/google');
		expect(input.method).toBe('POST');
		expect(await input.clone().json()).toEqual({ credential: 'g'.repeat(40) });
	});

	it('rejected or unconfigured Google sign-in returns a message, never ok', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: { code: 'GOOGLE_TOKEN_INVALID', message: 'invalid or unverified Google token' } })));
		const { loginWithGoogle } = await import('./google-auth');
		const bad = await loginWithGoogle('g'.repeat(40));
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.message).not.toMatch(/password/i);

		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, { error: { code: 'GOOGLE_SIGNIN_NOT_CONFIGURED', message: 'Google sign-in is not configured for this store' } })));
		expect((await loginWithGoogle('g'.repeat(40))).ok).toBe(false);
	});
});

describe('Google sign-in switch', () => {
	it('is off with no client id: no CSP origins', () => {
		expect(googleClientId('')).toBe('');
		expect(googleClientId(undefined)).toBe('');
		expect(googleIdentityCsp('')).toEqual({ script: [], connect: [], frame: [], style: [] });
	});

	it('is on with a client id: exactly the origins Google Identity documents', () => {
		expect(googleIdentityCsp(googleClientId(' abc.apps.googleusercontent.com '))).toEqual({
			script: ['https://accounts.google.com/gsi/client'],
			connect: ['https://accounts.google.com/gsi/'],
			frame: ['https://accounts.google.com/gsi/'],
			style: ['https://accounts.google.com/gsi/style'],
		});
	});

	it('the sign-in page renders the button only when enabled, and a successful credential navigates to the account', () => {
		const page = read('src/routes/sign-in/index.tsx');
		expect(page).toMatch(/GOOGLE_CLIENT_ID && \(\s*<>[\s\S]*?id="google-signin-button"/);
		expect(page).toContain('if (!GOOGLE_CLIENT_ID || current !== \'signin\') return;');
		expect(page).toMatch(/loginWithGoogle\(credential\);\s*if \(result\.ok\) \{\s*navigate\('\/account'\)/);
	});

	it('the CSP is built per request with the nonce and only adds Google sources through the switch', () => {
		const entry = read('src/entry.express.tsx');
		expect(entry).toContain("'nonce-${nonce}'");
		for (const k of ['script', 'style', 'connect', 'frame']) expect(entry).toContain(`googleCsp.${k}`);
		expect(entry).not.toContain('accounts.google.com'); // origins live only in config/google-signin.ts
	});
});
