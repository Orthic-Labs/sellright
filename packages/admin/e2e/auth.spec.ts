import { test, expect } from './fixtures';
import { AdminApi, totpAt, totpStep, uniq } from './support/api';
import { field } from './fixtures';
import { ADMIN_URL, OWNER_EMAIL, OWNER_PASSWORD } from './support/env.mjs';
import { inviteTokenFor } from './support/mailbox';

/**
 * Sign-in, sign-out and 2FA (the harness's own login path, plus the TOTP secret flow the plan asked for).
 * Supersedes: admin-login-schema.test.ts, the login/2FA cases of auth.route.test.ts (admin half).
 */
test.describe('admin sign-in', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('wrong password is refused with a generic message; the right one lands on the dashboard; sign out returns to /login', async ({ page }) => {
		// 'commit': the SPA bounces to /login itself (location.assign on a 401), which would otherwise abort goto()
		await page.goto('/orders', { waitUntil: 'commit' });
		await expect(page).toHaveURL(/\/login$/); // unauthenticated deep links bounce to sign-in

		await field(page, 'Email').fill(OWNER_EMAIL);
		await field(page, 'Password').fill('not-the-password');
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.getByText('invalid email, password, or 2FA code')).toBeVisible(); // no hint which part was wrong
		await expect(page).toHaveURL(/\/login$/);

		await field(page, 'Password').fill(OWNER_PASSWORD);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(`${ADMIN_URL}/`);
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

		await page.getByRole('button', { name: 'Sign out' }).click();
		await expect(page).toHaveURL(/\/login$/);
		await page.goto('/orders', { waitUntil: 'commit' });
		await expect(page).toHaveURL(/\/login$/);
	});

	test('an admin with 2FA enabled can sign in by supplying the authenticator code', async ({ page, api }) => {
		// The API's login answers a 2FA account that sent no code with the same plain 401 as a bad password (WP1.5 — it
		// never says "2FA required"), so the screen always offers the optional authentication-code field and sends it
		// together with the password. First attempt without a code is refused generically; the second carries the code.
		const email = `${uniq('tf')}@example.net`;
		const password = 'twofa-e2e-password-1';
		await api.post('/staff/invites', { email, role: 'manager' });
		const inv = { token: await inviteTokenFor(email) };
		const accepted = await fetch(`${new URL(ADMIN_URL).origin}/v1/admin/staff/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: inv.token, password }) });
		expect(accepted.status).toBe(200);

		// enable TOTP the way Settings > Security does: setup -> code from the secret -> enable
		const mine = await AdminApi.login(email, password);
		const { secret } = await mine.post<{ secret: string }>('/2fa/setup');
		await mine.post('/2fa/enable', { secret, code: totpAt(secret, totpStep()), password });
		expect((await mine.get<{ enabled: boolean }>('/2fa')).enabled).toBe(true);

		await page.goto('/login');
		await field(page, 'Email').fill(email);
		await field(page, 'Password').fill(password);
		await expect(field(page, 'Authentication code')).toBeVisible();
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.getByText('invalid email, password, or 2FA code')).toBeVisible(); // no code: generic 401, no oracle
		// a different 30s step than the one used for /2fa/enable, so replay protection is not what we measure
		const code = totpAt(secret, totpStep() + 1);
		await field(page, 'Authentication code').fill(code);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(`${ADMIN_URL}/`);
	});

	test('API contract: 2FA login needs password AND code together; a wrong or missing code is the same generic 401', async ({ api }) => {
		const email = `${uniq('tc')}@example.net`;
		const password = 'twofa-api-password-1';
		await api.post('/staff/invites', { email, role: 'staff' });
		const inv = { token: await inviteTokenFor(email) };
		await fetch(`${new URL(ADMIN_URL).origin}/v1/admin/staff/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: inv.token, password }) });
		const mine = await AdminApi.login(email, password);
		const { secret } = await mine.post<{ secret: string }>('/2fa/setup');
		await mine.post('/2fa/enable', { secret, code: totpAt(secret, totpStep()), password });

		const post = (body: Record<string, unknown>) => fetch(`${new URL(ADMIN_URL).origin}/v1/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		const missing = await post({ email, password });
		expect(missing.status).toBe(401);
		const wrong = await post({ email, password, totp: '000000' });
		expect(wrong.status).toBe(401);
		expect((await missing.json()).error.message).toBe((await wrong.json()).error.message); // no 2FA-enabled oracle
		const good = await post({ email, password, totp: totpAt(secret, totpStep() + 1) });
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
		await page.getByRole('button', { name: 'Sign in' }).click();
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
		const secret = (await page.locator('div.font-mono').first().innerText()).trim();
		await field(page, 'Verification code').fill(totpAt(secret, totpStep()));
		await field(page, 'Your current password').fill(newPassword);
		await page.getByRole('button', { name: 'Enable', exact: true }).click();
		await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10);
		await page.getByRole('button', { name: 'I have saved my recovery codes' }).click();
		await expect(page.getByText('10 unused recovery code(s) left.')).toBeVisible();
	});
});
