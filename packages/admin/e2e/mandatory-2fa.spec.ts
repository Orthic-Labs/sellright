import type { Page } from '@playwright/test';
import { test, expect, field } from './fixtures';
import { AdminApi, totpAt, totpStep, uniq } from './support/api';
import { ADMIN_URL, OWNER_EMAIL, OWNER_PASSWORD } from './support/env.mjs';
import { inviteTokenFor } from './support/mailbox';

/**
 * Issue #333 — mandatory 2FA enrolment right after sign-in: passkey first (a passkey alone satisfies the requirement and
 * then signs in with no password and no code), the authenticator app second (QR, code only, the secret rotates until
 * confirmed), recovery codes once.
 *
 * Independent of file order: a DEDICATED second owner (with its own authenticator, so only its own sessions are
 * affected) turns the store's "require 2FA" policy on for this file and off again in afterAll. While it is on, the
 * harness owner is only enrolment-restricted (its sessions are never deleted) and every other spec is unaffected after.
 */
test.describe.configure({ mode: 'serial' });
test.use({ storageState: { cookies: [], origins: [] } });

const PASSWORD = 'mandatory-2fa-e2e-password';
let policyOwner: AdminApi;
let recovery: string[] = [];

async function manager(prefix: string) {
	const email = `${uniq(prefix)}@example.net`;
	await policyOwner.post('/staff/invites', { email, role: 'manager' });
	const accepted = await fetch(`${new URL(ADMIN_URL).origin}/v1/admin/staff/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await inviteTokenFor(email), password: PASSWORD }) });
	expect(accepted.status).toBe(200);
	return email;
}
async function signIn(page: Page, email: string) {
	await page.goto('/login');
	await field(page, 'Email').fill(email);
	await field(page, 'Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test.beforeAll(async () => {
	const harnessOwner = await AdminApi.login(OWNER_EMAIL, OWNER_PASSWORD);
	const email = `${uniq('policy-owner')}@example.net`;
	await harnessOwner.post('/staff/invites', { email, role: 'owner' });
	const accepted = await fetch(`${new URL(ADMIN_URL).origin}/v1/admin/staff/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await inviteTokenFor(email), password: PASSWORD }) });
	expect(accepted.status).toBe(200);
	policyOwner = await AdminApi.login(email, PASSWORD);
	const { secret } = await policyOwner.post<{ secret: string }>('/2fa/setup');
	({ recoveryCodes: recovery } = await policyOwner.post<{ recoveryCodes: string[] }>('/2fa/enable', { secret, code: totpAt(secret, totpStep()), password: PASSWORD }));
	await policyOwner.post('/step-up', { password: PASSWORD, totp: recovery[0] });
	await policyOwner.patch('/settings/security', { requireTotp: true });
});

test.afterAll(async () => {
	await policyOwner.post('/step-up', { password: PASSWORD, totp: recovery[1] });
	await policyOwner.patch('/settings/security', { requireTotp: false });
});

test('a 2FA-required account enrols a passkey (recommended, first) and reaches the admin without an authenticator app; the passkey then signs in alone', async ({ page }) => {
	const email = await manager('mpk');
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

	await signIn(page, email);
	await expect(page.getByRole('heading', { name: 'Secure your account' })).toBeVisible();
	const options = page.locator('section');
	await expect(options.nth(0)).toContainText('Set up a passkey');
	await expect(options.nth(0)).toContainText('Recommended');
	await expect(options.nth(1)).toContainText('Use an authenticator app instead');
	await expect(page.getByRole('button', { name: 'Sign out' })).toHaveClass(/auth-link/);

	await page.getByRole('button', { name: 'Set up a passkey' }).click();
	await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
	await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10);
	await expect(page.getByRole('button', { name: 'Download .txt' })).toBeVisible();
	await page.getByLabel('I’ve saved my recovery codes').check();
	await page.getByRole('button', { name: 'Continue to admin' }).click();
	await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
	const me = await page.evaluate(async () => (await fetch('/v1/admin/me', { credentials: 'include' })).json());
	expect(me).toMatchObject({ email, totpEnabled: false, passkeyEnabled: true, totpEnrollmentRequired: false });

	// Reload stays signed out: only an explicit click starts the passkey ceremony, with no password or code.
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login$/);
	const passkeyRequests: string[] = [];
	page.on('request', request => {
		const path = new URL(request.url()).pathname;
		if (request.method() === 'POST' && /^\/v1\/admin\/passkeys\/login\/(options|verify)$/.test(path)) passkeyRequests.push(path);
	});
	await page.reload();
	const passkeySignIn = page.getByRole('button', { name: 'Sign in with a passkey', exact: true });
	await expect(passkeySignIn).toBeVisible();
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
	await expect(field(page, 'Email')).toHaveValue('');
	await expect(field(page, 'Password')).toHaveValue('');
	expect(await page.evaluate(async () => (await fetch('/v1/admin/me', { credentials: 'include' })).status)).toBe(401);
	expect(passkeyRequests).toEqual([]);
	await passkeySignIn.click();
	await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({ timeout: 15_000 });
	expect(passkeyRequests).toEqual(['/v1/admin/passkeys/login/options', '/v1/admin/passkeys/login/verify']);
	const passkeyMe = await page.evaluate(async () => (await fetch('/v1/admin/me', { credentials: 'include' })).json());
	expect(passkeyMe).toMatchObject({ email, totpEnabled: false, passkeyEnabled: true, totpEnrollmentRequired: false });

	// the password alone is no longer enough for this account: step 2 offers the passkey or a recovery code
	const step1 = await fetch(`${new URL(ADMIN_URL).origin}/v1/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
	expect(await step1.json()).toMatchObject({ twoFactorRequired: true, methods: ['passkey', 'recovery_code'] });
});

test('the authenticator alternative: QR, key in fours, the secret rotates on every visit, and only the code is asked right after sign-in', async ({ page }) => {
	const email = await manager('mtotp');
	await signIn(page, email);
	await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
	await expect(page.locator('.auth-qr img')).toBeVisible();
	const key1 = (await page.getByLabel('Setup key').innerText()).trim();
	expect(key1).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);

	// leave and come back: a NEW pending secret every visit until it is confirmed
	await page.getByRole('button', { name: 'Use a passkey instead' }).click();
	await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
	const key2 = (await page.getByLabel('Setup key').innerText()).trim();
	expect(key2).not.toBe(key1);

	await expect(page.locator('input[autocomplete="current-password"]')).toHaveCount(0); // fresh sign-in: code only
	const enable = page.getByRole('button', { name: 'Enable', exact: true });
	await expect(enable).toBeDisabled();
	const code = page.locator('input[autocomplete="one-time-code"]');
	await expect(code).toHaveAttribute('inputmode', 'numeric');
	await code.fill(totpAt(key1.replace(/ /g, ''), totpStep()).slice(0, 5));
	await expect(enable).toBeDisabled();
	await code.fill(totpAt(key1.replace(/ /g, ''), totpStep())); // the superseded secret no longer confirms
	await enable.click();
	await expect(page.getByText('That code didn’t match.', { exact: false })).toBeVisible();
	await code.fill(totpAt(key2.replace(/ /g, ''), totpStep()));
	await enable.click();
	await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10);
	await page.getByLabel('I’ve saved my recovery codes').check();
	await page.getByRole('button', { name: 'Continue to admin' }).click();
	await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
});
