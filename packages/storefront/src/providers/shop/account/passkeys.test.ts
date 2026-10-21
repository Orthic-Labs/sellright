import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@qwik.dev/core/build', () => ({ isServer: false, isBrowser: true, isDev: false }));
const startAuthentication = vi.fn();
const startRegistration = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: (a: unknown) => startAuthentication(a), startRegistration: (a: unknown) => startRegistration(a) }));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const envelope = (code: string) => ({ error: { code, message: 'server text', requestId: 'r1' } });
const CUSTOMER = { id: 'c1', email: 'a@b.com', firstName: null, lastName: null, phone: null, emailVerified: true, isMigrated: false };
const OPTIONS = { challenge: 'abc' };
const ITEM = { id: 'p1', label: 'Laptop', deviceType: 'multiDevice', backedUp: true, createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null };

type Call = { path: string; method: string; body: unknown; headers: Headers };
let calls: Call[];
const route = (handlers: Record<string, () => Response>) =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | Request, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input.url;
			const path = new URL(url, 'http://x').pathname;
			calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) });
			const h = handlers[`${init?.method ?? 'GET'} ${path}`];
			if (!h) throw new Error(`unexpected ${init?.method} ${path}`);
			return h();
		}),
	);

describe('passkeys provider', () => {
	beforeEach(() => {
		vi.resetModules();
		calls = [];
		startAuthentication.mockReset();
		startRegistration.mockReset();
		document.cookie = 'sr_cust_csrf=csrf-1';
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		document.cookie = 'sr_cust_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
	});

	it('sign-in: options, then the browser ceremony, then verify, in that order, signing the shopper in', async () => {
		route({
			'POST /v1/shop/auth/passkey/login/options': () => json(200, { options: OPTIONS }),
			'POST /v1/shop/auth/passkey/login/verify': () => json(200, { token: 't', customer: CUSTOMER }),
		});
		startAuthentication.mockResolvedValue({ id: 'cred' });
		const { loginWithPasskey } = await import('./passkeys');
		const r = await loginWithPasskey({ useBrowserAutofill: true });
		expect(r).toEqual({ ok: true, customer: expect.objectContaining({ id: 'c1' }) });
		expect(calls.map((c) => c.path)).toEqual(['/v1/shop/auth/passkey/login/options', '/v1/shop/auth/passkey/login/verify']);
		expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: OPTIONS, useBrowserAutofill: true });
		expect(calls[1].body).toEqual({ response: { id: 'cred' } });
		expect(calls[1].headers.get('x-csrf-token')).toBe('csrf-1');
	});

	it('sign-in: a cancelled prompt is flagged cancelled with a friendly message and never calls verify', async () => {
		route({ 'POST /v1/shop/auth/passkey/login/options': () => json(200, { options: OPTIONS }) });
		startAuthentication.mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
		const { loginWithPasskey, PASSKEY_CANCELLED_MESSAGE } = await import('./passkeys');
		const r = await loginWithPasskey();
		expect(r).toMatchObject({ ok: false, cancelled: true, message: PASSKEY_CANCELLED_MESSAGE });
		expect(calls).toHaveLength(1);
	});

	it('sign-in: PASSKEY_INVALID (401) shows the generic passkey message, not the server text', async () => {
		route({
			'POST /v1/shop/auth/passkey/login/options': () => json(200, { options: OPTIONS }),
			'POST /v1/shop/auth/passkey/login/verify': () => json(401, envelope('PASSKEY_INVALID')),
		});
		startAuthentication.mockResolvedValue({ id: 'cred' });
		const { loginWithPasskey, PASSKEY_MESSAGES } = await import('./passkeys');
		const r = await loginWithPasskey();
		expect(r).toMatchObject({ ok: false, message: PASSKEY_MESSAGES.PASSKEY_INVALID });
		expect(r).not.toHaveProperty('cancelled');
	});

	it('grants: password, mailbox request and confirm hit their routes and return the grant', async () => {
		route({
			'POST /v1/shop/auth/passkey/grant/password': () => json(200, { grant: 'g-pw' }),
			'POST /v1/shop/auth/passkey/grant/request': () => json(202, { ok: true }),
			'POST /v1/shop/auth/passkey/grant/confirm': () => json(200, { grant: 'g-mail' }),
		});
		const m = await import('./passkeys');
		expect(await m.requestGrantWithPassword('pw')).toEqual({ ok: true, grant: 'g-pw' });
		expect(await m.requestMailboxGrant()).toEqual({ ok: true });
		expect(await m.confirmMailboxGrant('tok')).toEqual({ ok: true, grant: 'g-mail' });
		expect(calls.map((c) => c.body)).toEqual([{ password: 'pw' }, {}, { token: 'tok' }]);
	});

	it('grant with an existing passkey: manage options, ceremony, manage verify', async () => {
		route({
			'POST /v1/shop/auth/passkey/manage/options': () => json(200, { options: OPTIONS }),
			'POST /v1/shop/auth/passkey/manage/verify': () => json(200, { grant: 'g-pk' }),
		});
		startAuthentication.mockResolvedValue({ id: 'cred' });
		const { grantWithPasskey } = await import('./passkeys');
		expect(await grantWithPasskey()).toEqual({ ok: true, grant: 'g-pk' });
		expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: OPTIONS });
		expect(calls.map((c) => c.path)).toEqual(['/v1/shop/auth/passkey/manage/options', '/v1/shop/auth/passkey/manage/verify']);
	});

	it('register: options carry the grant, the ceremony runs, verify carries response and trimmed label', async () => {
		route({
			'POST /v1/shop/auth/passkey/register/options': () => json(200, { options: OPTIONS }),
			'POST /v1/shop/auth/passkey/register/verify': () => json(200, ITEM),
		});
		startRegistration.mockResolvedValue({ id: 'new' });
		const { registerPasskey } = await import('./passkeys');
		expect(await registerPasskey('g1', '  Laptop ')).toEqual({ ok: true, passkey: ITEM });
		expect(calls[0].body).toEqual({ grant: 'g1' });
		expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: OPTIONS });
		expect(calls[1].body).toEqual({ response: { id: 'new' }, label: 'Laptop' });
	});

	it('register: cancel, duplicate and limit errors map to friendly messages', async () => {
		route({ 'POST /v1/shop/auth/passkey/register/options': () => json(200, { options: OPTIONS }), 'POST /v1/shop/auth/passkey/register/verify': () => json(409, envelope('CREDENTIAL_EXISTS')) });
		const { registerPasskey, PASSKEY_MESSAGES } = await import('./passkeys');
		startRegistration.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
		expect(await registerPasskey('g', 'a')).toMatchObject({ ok: false, cancelled: true });
		startRegistration.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'InvalidStateError' }));
		expect(await registerPasskey('g', 'a')).toMatchObject({ ok: false, code: 'CREDENTIAL_EXISTS' });
		startRegistration.mockResolvedValueOnce({ id: 'n' });
		expect(await registerPasskey('g', 'a')).toMatchObject({ ok: false, message: PASSKEY_MESSAGES.CREDENTIAL_EXISTS });
		route({ 'POST /v1/shop/auth/passkey/register/options': () => json(409, envelope('TOO_MANY_PASSKEYS')) });
		expect(await registerPasskey('g', 'a')).toMatchObject({ ok: false, message: PASSKEY_MESSAGES.TOO_MANY_PASSKEYS });
	});

	it('list and delete use the account routes; delete sends the grant and NO_RECOVERY_PATH reads as guidance', async () => {
		route({
			'GET /v1/shop/account/passkeys': () => json(200, { items: [ITEM] }),
			'DELETE /v1/shop/account/passkeys/p1': () => json(409, envelope('NO_RECOVERY_PATH')),
			'DELETE /v1/shop/account/passkeys/p2': () => json(200, { ok: true }),
		});
		const { listPasskeys, deletePasskey } = await import('./passkeys');
		expect(await listPasskeys()).toEqual({ ok: true, items: [ITEM] });
		expect(calls[0].headers.get('x-csrf-token')).toBeNull(); // reads carry no CSRF header
		const blocked = await deletePasskey('p1', 'g');
		expect(blocked).toMatchObject({ ok: false, code: 'NO_RECOVERY_PATH' });
		if (!blocked.ok) expect(blocked.message).toMatch(/Add a password or another sign-in method before removing your last passkey/);
		expect(await deletePasskey('p2', 'g')).toEqual({ ok: true });
		expect(calls[2].body).toEqual({ grant: 'g' });
	});

	it('FEATURE_DISABLED and rate limiting have messages; unknown failures are generic', async () => {
		const { describePasskeyError, PASSKEY_MESSAGES } = await import('./passkeys');
		route({ 'POST /v1/shop/auth/passkey/grant/password': () => json(404, envelope('FEATURE_DISABLED')) });
		const { requestGrantWithPassword } = await import('./passkeys');
		expect(await requestGrantWithPassword('x')).toMatchObject({ ok: false, message: PASSKEY_MESSAGES.FEATURE_DISABLED });
		route({ 'POST /v1/shop/auth/passkey/grant/password': () => json(429, {}) });
		expect(await requestGrantWithPassword('x')).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
		expect(describePasskeyError(new TypeError('boom'))).toMatchObject({ ok: false, code: 'UNKNOWN' });
	});

	it('never logs credential material', async () => {
		const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
		route({ 'POST /v1/shop/auth/passkey/login/options': () => json(200, { options: OPTIONS }), 'POST /v1/shop/auth/passkey/login/verify': () => json(401, envelope('PASSKEY_INVALID')) });
		startAuthentication.mockResolvedValue({ id: 'SECRET-ASSERTION' });
		const { loginWithPasskey } = await import('./passkeys');
		await loginWithPasskey();
		for (const s of spies) expect(s).not.toHaveBeenCalled();
		spies.forEach((s) => s.mockRestore());
	});
});
