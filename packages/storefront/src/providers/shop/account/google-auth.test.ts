import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleClientId, googleIdentityCsp, googleSignInClientId, googleSignInClientIdForHost, googleSignInHosts, googleSignInRefusedForMissingPin } from '~/config/google-signin';

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
		expect(page).toMatch(/googleClientId\.value && \(\s*<>[\s\S]*?id="google-signin-button"/);
		expect(page).toContain('if (!clientId || current !== \'signin\') return;');
		expect(page).toMatch(/loginWithGoogle\(credential\);\s*if \(result\.ok\) \{\s*navigate\('\/account'\)/);
	});

	it('the CSP is built per request with the nonce and only adds Google sources through the switch', () => {
		const entry = read('src/entry.express.tsx');
		expect(entry).toContain('buildCsp({');
		expect(entry).toMatch(/buildCsp\(\{\s*nonce,/);
		expect(entry).toContain('const socialIds = await socialSignInIdsForHost(validatedRequestHost(req.headers))');
		expect(entry).toContain('google: googleIdentityCsp(socialIds.google)');
		expect(entry).not.toMatch(/^const googleCsp\b/m); // no process-wide Google CSP
		expect(entry).not.toContain('accounts.google.com'); // origins live only in config/google-signin.ts
		expect(entry).toContain('getOrigin: getRouterOrigin'); // CSRF origin from the trusted boundary
	});
});

describe('Google sign-in: one configuration source, pinned to one store', () => {
	it('is off without a store pin even when a client id is set (never deployment-wide for an unpinned base)', () => {
		expect(googleSignInClientId('abc.apps.googleusercontent.com', '')).toBe('');
		expect(googleSignInClientId('abc.apps.googleusercontent.com', undefined)).toBe('');
		expect(googleSignInClientId('abc.apps.googleusercontent.com', '  ')).toBe('');
		expect(googleSignInRefusedForMissingPin('abc.apps.googleusercontent.com', '')).toBe(true);
		expect(googleIdentityCsp(googleSignInClientId('abc.apps.googleusercontent.com', ''))).toEqual({ script: [], connect: [], frame: [], style: [] });
	});

	it('is on with a client id and a pin, and off with no client id', () => {
		expect(googleSignInClientId(' abc.apps.googleusercontent.com ', 'store-a')).toBe('abc.apps.googleusercontent.com');
		expect(googleSignInRefusedForMissingPin('abc.apps.googleusercontent.com', 'store-a')).toBe(false);
		expect(googleSignInClientId('', 'store-a')).toBe('');
		expect(googleSignInRefusedForMissingPin('', '')).toBe(false);
	});

	it('the button and the CSP read the same function, and the CSP never reads a runtime-only variable', () => {
		const entry = read('src/entry.express.tsx');
		const page = read('src/routes/sign-in/index.tsx');
		expect(entry).toContain('const socialIds = await socialSignInIdsForHost(validatedRequestHost(req.headers))');
		expect(entry).toContain('googleIdentityCsp(socialIds.google)');
		expect(page).toMatch(/useGoogleClientId = routeLoader\$[\s\S]*?socialSignInIdsForHost\(/);
		expect(page).toContain('validatedRequestHost(');
		expect(entry).not.toContain('process.env.VITE_GOOGLE_CLIENT_ID');
	});
});

describe('Google sign-in: resolved per validated request host, not per process', () => {
	const ID = 'abc.apps.googleusercontent.com';
	const HOSTS = 'a.example, A2.example:8443';

	it('only a host listed for the pinned store gets the client id; a second host gets none (and so no CSP origins)', () => {
		expect(googleSignInClientIdForHost('a.example', ID, 'store-a', HOSTS)).toBe(ID);
		expect(googleSignInClientIdForHost('a2.example', ID, 'store-a', HOSTS)).toBe(ID);
		expect(googleSignInClientIdForHost('b.example', ID, 'store-a', HOSTS)).toBe('');
		expect(googleIdentityCsp(googleSignInClientIdForHost('b.example', ID, 'store-a', HOSTS))).toEqual({ script: [], connect: [], frame: [], style: [] });
		expect(googleIdentityCsp(googleSignInClientIdForHost('a.example', ID, 'store-a', HOSTS)).script).toEqual(['https://accounts.google.com/gsi/client']);
	});

	it('fails closed: no host list, no pin, no client id or an unusable host means no Google sign-in', () => {
		expect(googleSignInClientIdForHost('a.example', ID, 'store-a', '')).toBe('');
		expect(googleSignInClientIdForHost('a.example', ID, 'store-a', undefined)).toBe('');
		expect(googleSignInClientIdForHost('a.example', ID, '', HOSTS)).toBe('');
		expect(googleSignInClientIdForHost('a.example', '', 'store-a', HOSTS)).toBe('');
		expect(googleSignInClientIdForHost('', ID, 'store-a', HOSTS)).toBe('');
		expect(googleSignInHosts(' , ')).toEqual([]);
	});

	it('the request host comes from the trusted boundary: a forged X-Forwarded-Host cannot turn Google on', async () => {
		const { validatedRequestHost } = await import('~/utils/trusted-request.server');
		const forged = { host: 'b.example', 'x-forwarded-host': 'a.example' };
		expect(googleSignInClientIdForHost(validatedRequestHost(forged, {}), ID, 'store-a', HOSTS)).toBe('');
		const trusted = { SELLRIGHT_TRUST_FORWARDED_HOST: '1' };
		expect(googleSignInClientIdForHost(validatedRequestHost({ host: 'internal', 'x-forwarded-host': 'a.example' }, trusted), ID, 'store-a', HOSTS)).toBe(ID);
		expect(googleSignInClientIdForHost(validatedRequestHost({ host: 'internal', 'x-forwarded-host': 'b.example' }, trusted), ID, 'store-a', HOSTS)).toBe('');
	});
});

describe('Google sign-in: 409 shows the API explanation', () => {
	beforeEach(() => vi.resetModules());
	afterEach(() => vi.unstubAllGlobals());

	it('surfaces the message for an existing account Google cannot vouch for, with a fallback when it is empty', async () => {
		const msg = 'an account with this email already exists — sign in with your password or a sign-in link first';
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, { error: { code: 'EMAIL_TAKEN', message: msg } })));
		const { loginWithGoogle } = await import('./google-auth');
		const r = await loginWithGoogle('g'.repeat(40));
		expect(r).toMatchObject({ ok: false });
		if (!r.ok) expect(r.message).toMatch(/sign in with your password or a sign-in link/i);
	});
});

describe('Google script loader', () => {
	const scripts = () => Array.from(document.head.querySelectorAll<HTMLScriptElement>('script[src*="accounts.google.com/gsi/client"]'));
	const ready = () => ({ initialize: vi.fn(), renderButton: vi.fn() });
	const setGoogle = (id: unknown) => ((window as unknown as { google?: unknown }).google = id ? { accounts: { id } } : undefined);

	beforeEach(() => {
		vi.resetModules();
		setGoogle(undefined);
		document.head.innerHTML = '';
	});
	afterEach(() => {
		vi.useRealTimers();
		setGoogle(undefined);
		document.head.innerHTML = '';
	});

	it('a failed download resolves false, removes the script, and a retry loads again', async () => {
		const { renderGoogleButton } = await import('./google-auth');
		const el = document.createElement('div');
		const first = renderGoogleButton(el, 'cid', () => {});
		expect(scripts()).toHaveLength(1);
		scripts()[0].onerror?.(new Event('error'));
		expect(await first).toBe(false);
		expect(scripts()).toHaveLength(0);

		const id = ready();
		const second = renderGoogleButton(el, 'cid', () => {});
		expect(scripts()).toHaveLength(1); // a fresh script, not the dead pending one
		setGoogle(id);
		scripts()[0].onload?.(new Event('load'));
		expect(await second).toBe(true);
		expect(id.renderButton).toHaveBeenCalledOnce();
	});

	it('a hanging download times out, resolves false, and clears the pending loader', async () => {
		vi.useFakeTimers();
		const { renderGoogleButton, GOOGLE_SCRIPT_TIMEOUT_MS } = await import('./google-auth');
		const el = document.createElement('div');
		const first = renderGoogleButton(el, 'cid', () => {});
		await vi.advanceTimersByTimeAsync(GOOGLE_SCRIPT_TIMEOUT_MS);
		expect(await first).toBe(false);
		expect(scripts()).toHaveLength(0);

		const second = renderGoogleButton(el, 'cid', () => {});
		expect(scripts()).toHaveLength(1);
		setGoogle(ready());
		scripts()[0].onload?.(new Event('load'));
		expect(await second).toBe(true);
	});

	it('a script that loads without defining Google Identity counts as unavailable', async () => {
		const { renderGoogleButton } = await import('./google-auth');
		const p = renderGoogleButton(document.createElement('div'), 'cid', () => {});
		scripts()[0].onload?.(new Event('load'));
		expect(await p).toBe(false);
	});

	it("the inserted script carries the document's CSP nonce, and none when the document has none", async () => {
		const own = document.createElement('script');
		own.setAttribute('nonce', 'abc123');
		document.head.appendChild(own);
		const { renderGoogleButton } = await import('./google-auth');
		void renderGoogleButton(document.createElement('div'), 'cid', () => {});
		expect(scripts()[0].nonce || scripts()[0].getAttribute('nonce')).toBe('abc123');
	});

	it('the sign-in page shows an unavailable message with a retry that re-runs the loader', () => {
		const page = read('src/routes/sign-in/index.tsx');
		expect(page).toContain('googleUnavailable.value = !(await renderGoogleButton(');
		expect(page).toMatch(/googleUnavailable\.value && \([\s\S]*?Try again/);
		expect(page).toContain('googleAttempt.value++');
		expect(page).toContain('track(() => googleAttempt.value)');
	});
});

describe('Google sign-in verification link', () => {
	beforeEach(() => vi.resetModules());
	afterEach(() => vi.unstubAllGlobals());

	it('a 202 (link mailed) is a message, never a sign-in, and says nothing account-specific', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(202, { verificationRequired: true })));
		const { loginWithGoogle } = await import('./google-auth');
		const r = await loginWithGoogle('g'.repeat(40));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toMatch(/check your email/i);
	});

	it('confirm posts the token and signs the shopper in; an invalid link is a message', async () => {
		const mockedFetch = vi.fn(async () => jsonResponse(200, { token: 't', customer: CUSTOMER }));
		vi.stubGlobal('fetch', mockedFetch);
		const { confirmFederatedSignIn } = await import('./google-auth');
		expect(await confirmFederatedSignIn('t'.repeat(40))).toEqual({ ok: true, customer: expect.objectContaining({ id: 'c1' }) });
		const [input] = mockedFetch.mock.calls[0] as unknown as [Request];
		expect(new URL(input.url).pathname).toBe('/v1/shop/auth/federated/confirm');

		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: { code: 'TOKEN_INVALID', message: 'x' } })));
		const bad = await confirmFederatedSignIn('t'.repeat(40));
		expect(bad).toMatchObject({ ok: false, terminal: true });
		if (!bad.ok) expect(bad.message).toMatch(/^We couldn't confirm this link\. It may have expired, already been used, or been opened in a different browser or device/);
		expect(bad.ok).toBe(false);
	});
});

describe('federated confirm landing page', () => {
	it('redeems only on an explicit click, never on load', () => {
		const page = read('src/routes/sign-in/confirm/index.tsx');
		expect(page).toContain('onClick$={confirm}');
		// the only call to the API helper lives inside the click handler, not in useVisibleTask$
		const task = /useVisibleTask\$\(\(\) => \{[\s\S]*?\n\t\}\);/.exec(page)![0];
		expect(task).not.toContain('confirmFederatedSignIn');
		expect(page.match(/confirmFederatedSignIn\(/g)).toHaveLength(1);
	});
});

describe('federated confirm error copy and terminal state', () => {
	beforeEach(() => vi.resetModules());
	afterEach(() => vi.unstubAllGlobals());

	it('401 says to go back to the original browser; 409 unverified names both providers; both are terminal', async () => {
		const { confirmFederatedSignIn } = await import('./google-auth');
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: { code: 'TOKEN_INVALID', message: 'x' } })));
		const r401 = await confirmFederatedSignIn('t'.repeat(40));
		expect(r401).toMatchObject({ ok: false, terminal: true });
		if (!r401.ok) expect(r401.message).toBe("We couldn't confirm this link. It may have expired, already been used, or been opened in a different browser or device from the one where you started signing in. Go back to that browser and start signing in again; a new link will be sent.");

		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, { error: { code: 'EMAIL_TAKEN_UNVERIFIED', message: 'server wording' } })));
		const r409 = await confirmFederatedSignIn('t'.repeat(40));
		expect(r409).toMatchObject({ ok: false, terminal: true });
		if (!r409.ok) expect(r409.message).toBe("An account with this email already exists, but its email address hasn't been verified. Sign in with your password and verify your email first, then try Google or Apple sign-in again.");
	});

	it('a malformed token (400) is terminal with the link-failed copy', async () => {
		const { confirmFederatedSignIn } = await import('./google-auth');
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: { code: 'VALIDATION_ERROR', message: 'x' } })));
		const r = await confirmFederatedSignIn('short');
		expect(r).toMatchObject({ ok: false, terminal: true });
		if (!r.ok) expect(r.message).toMatch(/^We couldn't confirm this link\./);
	});

	it('a network failure is not terminal (the button stays so the shopper can retry)', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
		const { confirmFederatedSignIn } = await import('./google-auth');
		const r = await confirmFederatedSignIn('t'.repeat(40));
		expect(r.ok).toBe(false);
		expect('terminal' in r && r.terminal).toBeFalsy();
	});

	it('the page swaps Confirm for a primary Back to sign in after a terminal error, and shows a busy spinner instead of a faded button', () => {
		const page = read('src/routes/sign-in/confirm/index.tsx');
		expect(page).toMatch(/terminal\.value \? \(\s*<a href="\/sign-in" id="back-to-sign-in" class=\{PRIMARY\}>/);
		expect(page).toContain('aria-busy={busy.value}');
		expect(page).toContain('Signing you in…');
		expect(page).not.toMatch(/\sdisabled=\{|disabled:opacity/);
		expect(page).toContain('rounded-2xl p-8 shadow-sm'); // same card as /sign-in
		expect(page).toContain('text-2xl font-bold text-gray-900');
	});
});
