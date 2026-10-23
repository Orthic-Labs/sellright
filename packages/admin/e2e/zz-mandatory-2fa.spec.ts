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
 * Runs LAST (file name): turning on the store's "require 2FA" policy needs the owner to hold a factor, and enabling one
 * signs out the owner's other sessions. The spec restores the policy and the owner's factor before it ends.
 */
test.describe.configure({ mode: 'serial' });
test.use({ storageState: { cookies: [], origins: [] } });

const PASSWORD = 'mandatory-2fa-e2e-password';
let owner: AdminApi;
let ownerRecovery: string[] = [];

async function manager(api: AdminApi, prefix: string) {
	const email = `${uniq(prefix)}@example.net`;
	await api.post('/staff/invites', { email, role: 'manager' });
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
	owner = await AdminApi.login(OWNER_EMAIL, OWNER_PASSWORD);
	const { secret } = await owner.post<{ secret: string }>('/2fa/setup');
	({ recoveryCodes: ownerRecovery } = await owner.post<{ recoveryCodes: string[] }>('/2fa/enable', { secret, code: totpAt(secret, totpStep()), password: OWNER_PASSWORD }));
	await owner.post('/step-up', { password: OWNER_PASSWORD, totp: ownerRecovery[0] });
	await owner.patch('/settings/security', { requireTotp: true });
});

test.afterAll(async () => {
	await owner.post('/step-up', { password: OWNER_PASSWORD, totp: ownerRecovery[1] });
	await owner.patch('/settings/security', { requireTotp: false });
	await owner.post('/2fa/disable', { password: OWNER_PASSWORD, code: ownerRecovery[2] });
});

test('a 2FA-required account enrols a passkey (recommended, first) and reaches the admin without an authenticator app; the passkey then signs in alone', async ({ page }) => {
	const email = await manager(owner, 'mpk');
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

	// sign out; the passkey alone (autofill on the email field) signs back in — no password, no code
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login$/);
	await page.reload();
	await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({ timeout: 15_000 });

	// the password alone is no longer enough for this account: step 2 offers the passkey or a recovery code
	const step1 = await fetch(`${new URL(ADMIN_URL).origin}/v1/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
	expect(await step1.json()).toMatchObject({ twoFactorRequired: true, methods: ['passkey', 'recovery_code'] });
});

test('the authenticator alternative: QR, key in fours, the secret rotates on every visit, and only the code is asked right after sign-in', async ({ page }) => {
	const email = await manager(owner, 'mtotp');
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
