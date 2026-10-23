import { test, expect } from './fixtures';
import { AdminApi, totpAt, totpStep, uniq } from './support/api';
import { field, gotoStable } from './fixtures';
import { ADMIN_URL, OWNER_EMAIL, OWNER_PASSWORD } from './support/env.mjs';
import { inviteTokenFor } from './support/mailbox';

/**
 * Sign-in, sign-out and 2FA (the harness's own login path, plus the TOTP secret flow the plan asked for).
 * Supersedes: admin-login-schema.test.ts, the login/2FA cases of auth.route.test.ts (admin half).
 */
test.describe('admin sign-in', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	/** A staff account (via the real invite flow), optionally with 2FA enabled the way Settings > Security does. */
	async function makeAccount(api: AdminApi, prefix: string, withTotp: boolean) {
		const email = `${uniq(prefix)}@example.net`;
		const password = `${prefix}-e2e-password-1`;
		await api.post('/staff/invites', { email, role: 'manager' });
		const accepted = await fetch(`${new URL(ADMIN_URL).origin}/v1/admin/staff/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await inviteTokenFor(email), password }) });
		expect(accepted.status).toBe(200);
		let secret: string | null = null;
		const enabledAtStep = totpStep();
		if (withTotp) {
			const mine = await AdminApi.login(email, password);
			({ secret } = await mine.post<{ secret: string }>('/2fa/setup'));
			await mine.post('/2fa/enable', { secret, code: totpAt(secret!, enabledAtStep), password });
		}
		return { email, password, secret, enabledAtStep };
	}

	test('wrong password is refused with one generic message; the right one lands on the dashboard; sign out returns to /login', async ({ page }) => {
		// 'commit': the SPA bounces to /login itself (location.assign on a 401), which would otherwise abort goto()
		await page.goto('/orders', { waitUntil: 'commit' });
		await expect(page).toHaveURL(/\/login$/); // unauthenticated deep links bounce to sign-in

		await field(page, 'Email').fill(OWNER_EMAIL);
		await field(page, 'Password').fill('not-the-password');
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(page.getByText('Incorrect email or password.')).toBeVisible(); // no hint which part was wrong
		await expect(page).toHaveURL(/\/login$/);

		await field(page, 'Password').fill(OWNER_PASSWORD);
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(page).toHaveURL(`${ADMIN_URL}/`);
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

		await page.getByRole('button', { name: 'Sign out' }).click();
		await expect(page).toHaveURL(/\/login$/);
		await page.goto('/orders', { waitUntil: 'commit' });
		await expect(page).toHaveURL(/\/login$/);
	});

	test('#333: an account WITHOUT 2FA only ever sees email and password', async ({ page, api }) => {
		const a = await makeAccount(api, 'no2fa', false);
		await page.goto('/login');
		await expect(page.locator('input:visible')).toHaveCount(2);
		await expect(page.locator('input[autocomplete="one-time-code"]')).toHaveCount(0);
		await expect(page.getByText(/Optional|Authentication code/)).toHaveCount(0);
		await expect(field(page, 'Email')).toHaveAttribute('autocomplete', 'username webauthn');
		await expect(field(page, 'Password')).toHaveAttribute('autocomplete', 'current-password');
		await field(page, 'Email').fill(a.email);
		await field(page, 'Password').fill(a.password);
		await field(page, 'Password').press('Enter'); // Enter submits
		await expect(page).toHaveURL(`${ADMIN_URL}/`);
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
	});

	test('#333: an account WITH 2FA gets the code step only after the correct password, and signs in with the code', async ({ page, api }) => {
		const a = await makeAccount(api, 'tf', true);
		await page.goto('/login');
		await field(page, 'Email').fill(a.email);
		await field(page, 'Password').fill('not-the-password');
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(page.getByText('Incorrect email or password.')).toBeVisible();
		await expect(page.locator('input[autocomplete="one-time-code"]')).toHaveCount(0); // a wrong password reveals nothing

		await field(page, 'Password').fill(a.password);
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(page.getByText('Enter the 6-digit code from your authenticator app')).toBeVisible();
		const code = page.locator('input[autocomplete="one-time-code"]');
		await expect(code).toHaveAttribute('inputmode', 'numeric');
		await expect(page.getByRole('button', { name: 'Use a recovery code' })).toBeVisible();
		await code.fill('000000'); // auto-submits at 6 digits
		await expect(page.getByText('That code didn’t work.', { exact: false })).toBeVisible();
		// a different 30s step than the one used for /2fa/enable, so replay protection is not what we measure
		await code.fill(totpAt(a.secret!, a.enabledAtStep + 1));
		await expect(page).toHaveURL(`${ADMIN_URL}/`);
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
	});

	test('#333: passkey sign-in through autofill (conditional mediation) with a Chromium virtual authenticator', async ({ page, api, browserName }) => {
		test.skip(browserName !== 'chromium', 'virtual authenticator is a Chromium CDP feature');
		test.setTimeout(120_000);
		const a = await makeAccount(api, 'pk', true);
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('WebAuthn.enable');
		await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

		// enrol a passkey from Settings > Security (password step, then the code step, then step-up for passkey management)
		await page.goto('/login');
		await field(page, 'Email').fill(a.email);
		await field(page, 'Password').fill(a.password);
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await page.locator('input[autocomplete="one-time-code"]').fill(totpAt(a.secret!, a.enabledAtStep + 1));
		await expect(page).toHaveURL(`${ADMIN_URL}/`);
		await gotoStable(page, '/settings');
		await page.getByRole('button', { name: 'Security' }).click();
		await field(page, 'Passkey name').fill('E2E virtual key');
		await page.getByRole('button', { name: 'Add a passkey' }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		await field(dialog, 'Password').fill(a.password);
		// TOTP replay guard: every accepted step must be newer than the last; the sign-in used enable+1, so wait until
		// enable+2 is inside the ±1-step window.
		while (totpStep() < a.enabledAtStep + 1) await page.waitForTimeout(1000);
		await field(dialog, '2FA code (if enabled)').fill(totpAt(a.secret!, a.enabledAtStep + 2));
		await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
		await expect(page.getByRole('list', { name: 'Passkeys' }).getByText('E2E virtual key')).toBeVisible();
		await page.getByRole('button', { name: 'Sign out' }).click();
		await expect(page).toHaveURL(/\/login$/);

		// back on /login the email field carries "username webauthn" and the page has started a conditional request;
		// the virtual authenticator answers it, so the admin signs in with no password and no code.
		await page.reload();
		await expect(page).toHaveURL(`${ADMIN_URL}/`, { timeout: 15_000 });
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
		expect((await page.evaluate(async () => (await fetch('/v1/admin/me', { credentials: 'include' })).json())).email).toBe(a.email);
	});

	test('API contract: the single-request form still needs password AND code together; a wrong or missing code is refused', async ({ api }) => {
		const a = await makeAccount(api, 'tc', true);
		const post = (body: Record<string, unknown>) => fetch(`${new URL(ADMIN_URL).origin}/v1/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		const missing = await post({ email: a.email, password: a.password });
		expect(missing.status).toBe(200); // step 1: a challenge, never a session
		const body = await missing.json();
		expect(body).toMatchObject({ twoFactorRequired: true });
		expect(missing.headers.get('set-cookie') ?? '').not.toMatch(/sr_admin=/);
		const wrong = await post({ email: a.email, password: a.password, totp: '000000' });
		expect(wrong.status).toBe(401);
		const good = await post({ email: a.email, password: a.password, totp: totpAt(a.secret!, a.enabledAtStep + 1) });
		expect(good.status).toBe(200);
	});
});

test.describe('account security (P1b)', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('Settings > Security: change password (other sessions signed out), then enrol 2FA and get recovery codes', async ({ page, api }) => {
		const email = `${uniq('sec')}@example.net`;
		const password = 'security-e2e-password-1';
		const newPassword = 'security-e2e-password-2';
		await api.post('/staff/invites', { email, role: 'staff' });
		const accepted = await fetch(`${new URL(ADMIN_URL).origin}/v1/admin/staff/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await inviteTokenFor(email), password }) });
		expect(accepted.status).toBe(200);
		const other = await AdminApi.login(email, password);

		await page.goto('/login');
		await field(page, 'Email').fill(email);
		await field(page, 'Password').fill(password);
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(page).toHaveURL(`${ADMIN_URL}/`);
		await page.goto('/settings');
		await page.getByRole('button', { name: 'Security' }).click();

		await field(page, 'Current password').fill(password);
		await field(page, 'New password').fill(newPassword);
		await field(page, 'Confirm new password').fill(newPassword);
		await page.getByRole('button', { name: 'Change password' }).click();
		await expect(page.getByText('Password changed. 1 other session(s) signed out.')).toBeVisible();
		expect((await other.raw('GET', '/me')).status).toBe(401);

		await page.getByRole('button', { name: 'Enable 2FA' }).click();
		await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
		await expect(page.locator('.auth-qr img')).toBeVisible(); // #333: QR rendered by the API, no third-party service
		const secret = (await page.getByLabel('Setup key').innerText()).replace(/\s+/g, '');
		await page.locator('input[autocomplete="one-time-code"]').fill(totpAt(secret, totpStep()));
		// the password change above re-proved the password minutes ago? No: a password change is not a step-up, and this
		// session is older than the fresh-sign-in window only in wall time; the API says which, the UI follows it.
		const pw = page.locator('input[autocomplete="current-password"]');
		if (await pw.count()) await pw.fill(newPassword);
		await page.getByRole('button', { name: 'Enable', exact: true }).click();
		await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10);
		await page.getByLabel('I’ve saved my recovery codes').check();
		await page.getByRole('button', { name: 'Done', exact: true }).click();
		await expect(page.getByText('10 unused recovery code(s) left.')).toBeVisible();
	});
});
