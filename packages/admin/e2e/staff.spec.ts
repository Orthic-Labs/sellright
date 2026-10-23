import type { Browser, Page } from '@playwright/test';
import { test, expect, row, toast, field, gotoStable } from './fixtures';
import { AdminApi, createOrder, createPendingOrder, totpAt, totpStep, uniq } from './support/api';
import { ADMIN_URL } from './support/env.mjs';
import { inviteLinkFor, inviteTokenFor } from './support/mailbox';

/**
 * Plan 1.3 #18 — Staff: owner invites in the UI -> invitee accepts -> signs in -> role + per-action permissions are
 * enforced on sensitive routes; granting a permission in the UI takes effect; revoking sessions logs the member out.
 * Supersedes: admin-settings-advanced.staff.db.test.ts, admin-settings-advanced.staff-accept-409.test.ts,
 * app.staff-accept-csrf.db.test.ts (HTTP paths), admin-rbac-sensitive.test.ts (route permission matrix).
 */
const PASSWORD = 'staff-e2e-password-1';

async function inviteViaUi(page: Page, email: string, roleLabel: 'Staff' | 'Read-only' | 'Manager'): Promise<string> {
	await page.goto('/staff');
	await page.getByRole('button', { name: '+ New invite' }).click();
	await page.getByPlaceholder('team@example.com').fill(email);
	await field(page, 'Role').selectOption({ label: roleLabel });
	await page.getByRole('button', { name: 'Send invite' }).click();
	await expect(page.getByText(`Invitation e-mailed to ${email}.`)).toBeVisible();
	// the accept token is never shown to the inviter (P0): it only travels to the invitee's mailbox
	await expect(page.locator('input[readonly]')).toHaveCount(0);
	return inviteTokenFor(email);
}

async function acceptInvite(token: string): Promise<void> {
	// Most specs accept through the public endpoint directly (fast); the accept-invite screen has its own test below.
	const res = await fetch(`${new URL(ADMIN_URL).origin}/v1/admin/staff/accept`, {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: PASSWORD }),
	});
	expect(res.status).toBe(200);
}

async function signInAs(browser: Browser, email: string) {
	const context = await browser.newContext({ baseURL: ADMIN_URL, storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	await page.goto('/login');
	await field(page, 'Email').fill(email);
	await field(page, 'Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page).toHaveURL(`${ADMIN_URL}/`, { timeout: 15_000 });
	return { context, page };
}

test.describe('staff', () => {
	test('invite -> accept -> sign in; staff role is blocked from staff admin, cancels and refunds until granted', async ({ page, browser, api }) => {
		const email = `${uniq('st')}@example.net`;
		const token = await inviteViaUi(page, email, 'Staff');

		// pending until accepted
		await page.getByRole('button', { name: 'Done' }).click();
		await expect(row(page, email)).toContainText('pending');
		await acceptInvite(token);
		await page.reload();
		const member = row(page, email).first();
		await expect(member).toContainText('Staff');
		await expect(page.getByText('No pending invites')).toBeVisible(); // accepted invites drop out of the pending table
		// an invite token is single-use
		const replay = await fetch(`${new URL(ADMIN_URL).origin}/v1/admin/staff/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: PASSWORD }) });
		expect(replay.status).toBe(409);

		const unpaid = (await createPendingOrder(api, { email: `${uniq('sc')}@example.net` })).code;
		const paid = (await createOrder(api, { email: `${uniq('sp')}@example.net` })).code;
		const staff = await signInAs(browser, email);
		const sp = staff.page;

		// 1) the Staff admin screen is manager/owner only
		await gotoStable(sp, '/staff');
		await expect(sp.getByText("role 'staff' cannot manage settings/staff")).toBeVisible();

		// 2) day-to-day writes work (notes), cancel/refund need explicit grants
		await gotoStable(sp, `/orders/${paid}`);
		await sp.getByLabel('Add an internal note').fill('staff note');
		await sp.getByRole('button', { name: 'Add note' }).click();
		await expect(toast(sp, 'Note added')).toBeVisible();

		await gotoStable(sp, `/orders/${unpaid}`);
		await sp.getByRole('button', { name: 'Cancel order' }).click();
		await sp.getByRole('alertdialog').getByRole('button', { name: 'Cancel order' }).click();
		await expect(sp.getByText("role 'staff' lacks the 'cancel_orders' permission").first()).toBeVisible();
		expect((await api.order(unpaid)).state).toBe('PendingPayment');

		await gotoStable(sp, `/orders/${paid}`);
		await sp.getByRole('button', { name: 'Issue refund' }).click();
		await sp.getByRole('alertdialog').getByRole('button', { name: 'Issue refund' }).click();
		await expect(sp.getByText("role 'staff' lacks the 'refunds' permission").first()).toBeVisible();
		expect((await api.order(paid)).state).toBe('Paid');

		// 3) the owner grants cancel_orders in the UI -> takes effect on the member's next request
		await page.goto('/staff');
		await row(page, email).getByRole('button', { name: 'Permissions' }).click();
		await page.getByLabel(/Cancel orders/).check();
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(row(page, email).getByRole('button', { name: 'Permissions' })).toContainText('1');

		await gotoStable(sp, `/orders/${unpaid}`);
		await sp.getByRole('button', { name: 'Cancel order' }).click();
		await sp.getByRole('alertdialog').getByRole('button', { name: 'Cancel order' }).click();
		await expect(toast(sp, 'Order cancelled')).toBeVisible();
		expect((await api.order(unpaid)).state).toBe('Cancelled');
		// …but refunds are still not granted
		await gotoStable(sp, `/orders/${paid}`);
		await sp.getByRole('button', { name: 'Issue refund' }).click();
		await sp.getByRole('alertdialog').getByRole('button', { name: 'Issue refund' }).click();
		await expect(sp.getByText("role 'staff' lacks the 'refunds' permission").first()).toBeVisible();

		// 4) revoke sessions force-logs the member out
		await page.goto('/staff');
		await row(page, email).getByRole('button', { name: 'Revoke sessions' }).click();
		await expect.poll(async () => {
			const r = await sp.evaluate(async () => (await fetch('/v1/admin/me', { credentials: 'include' })).status);
			return r;
		}).toBe(401);
		await sp.reload();
		await expect(sp).toHaveURL(/\/login$/);
		await staff.context.close();
	});

	test('a read-only member can look but every write is refused', async ({ page, browser, api }) => {
		const email = `${uniq('ro')}@example.net`;
		await acceptInvite(await inviteViaUi(page, email, 'Read-only'));
		const { code } = await createOrder(api, { email: `${uniq('rc')}@example.net` });

		const ro = await signInAs(browser, email);
		await gotoStable(ro.page, '/orders');
		await ro.page.getByLabel('Search code or email').fill(code);
		await expect(row(ro.page, code)).toHaveCount(1); // can read

		await gotoStable(ro.page, `/orders/${code}`);
		await ro.page.getByLabel('Add an internal note').fill('should be refused');
		await ro.page.getByRole('button', { name: 'Add note' }).click();
		await expect(ro.page.getByText("role 'read_only' is read-only").first()).toBeVisible();
		const detail = await api.order(code);
		expect(detail.events.some((e: { action: string }) => e.action === 'note')).toBe(false);

		// the same member cannot mutate through the API either
		const roApi = await AdminApi.login(email, PASSWORD);
		const res = await roApi.raw('POST', '/customers', { email: `${uniq('x')}@example.net` });
		expect(res.status).toBe(403);
		await ro.context.close();
	});

	test('the emailed accept link opens an accept-invite screen that sets the password and signs the invitee in', async ({ browser, api }) => {
		const email = `${uniq('ai')}@example.net`;
		const sent = await api.post<Record<string, unknown>>('/staff/invites', { email, role: 'staff' });
		expect(sent).not.toHaveProperty('token'); // e-mail only
		// navigate the link exactly as it arrived in the mailbox (ADMIN_PUBLIC_URL + /accept-invite)
		const link = await inviteLinkFor(email);
		expect(link.startsWith(`${ADMIN_URL}/accept-invite?token=`)).toBe(true);
		const inv = { token: new URL(link).searchParams.get('token')! };
		const context = await browser.newContext({ baseURL: ADMIN_URL, storageState: { cookies: [], origins: [] } });
		const page = await context.newPage();
		await page.goto(link);
		await field(page, 'Email').fill(email);
		await field(page, 'Password').fill('short');
		await field(page, 'Confirm password').fill('short');
		await page.getByRole('button', { name: 'Accept invitation' }).click();
		await expect(page.getByText('Use at least 8 characters.')).toBeVisible();
		await field(page, 'Password').fill(PASSWORD);
		await field(page, 'Confirm password').fill(`${PASSWORD}x`);
		await page.getByRole('button', { name: 'Accept invitation' }).click();
		await expect(page.getByText('The passwords don’t match.')).toBeVisible();
		await field(page, 'Confirm password').fill(PASSWORD);
		await page.getByRole('button', { name: 'Accept invitation' }).click();
		await expect(page).toHaveURL(`${ADMIN_URL}/`, { timeout: 15_000 });
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

		// the invite is single-use: re-opening the same link is refused with the API's message
		const again = await context.newPage();
		await again.goto(`/accept-invite?token=${inv.token}`);
		await field(again, 'Email').fill(email);
		await field(again, 'Password').fill(PASSWORD);
		await field(again, 'Confirm password').fill(PASSWORD);
		await again.getByRole('button', { name: 'Accept invitation' }).click();
		await expect(again.getByText('invite is invalid, already used, or expired')).toBeVisible();
		await context.close();
	});

	test('an invite to an address that already has an account asks for the CURRENT password and never changes it', async ({ browser, api }) => {
		const email = `${uniq('ex')}@example.net`;
		await api.post('/staff/invites', { email, role: 'staff' });
		await acceptInvite(await inviteTokenFor(email)); // account now exists with PASSWORD
		const id = (await api.get<{ items: { adminUserId: string; email: string }[] }>('/staff')).items.find((m) => m.email === email)!.adminUserId;
		await api.raw('DELETE', `/staff/${id}`);

		await api.post('/staff/invites', { email, role: 'manager' });
		const token = await inviteTokenFor(email);
		// the token alone cannot set a new password for an existing account
		const blind = await fetch(`${new URL(ADMIN_URL).origin}/v1/admin/staff/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: 'someone-elses-pass' }) });
		expect(blind.status).toBe(401);

		const context = await browser.newContext({ baseURL: ADMIN_URL, storageState: { cookies: [], origins: [] } });
		const page = await context.newPage();
		await page.goto(await inviteLinkFor(email));
		await field(page, 'Email').fill(email);
		await field(page, 'Password').fill('a-brand-new-pass');
		await field(page, 'Confirm password').fill('a-brand-new-pass');
		await page.getByRole('button', { name: 'Accept invitation' }).click();
		await expect(page.getByRole('heading', { name: 'Join with your existing account' })).toBeVisible();
		await field(page, 'Current password').fill(PASSWORD);
		await page.getByRole('button', { name: 'Sign in and accept' }).click();
		await expect(page).toHaveURL(`${ADMIN_URL}/`, { timeout: 15_000 });
		await context.close();
		// password unchanged: the old one still signs in, the attempted new one does not
		await AdminApi.login(email, PASSWORD);
		const bad = await fetch(`${new URL(ADMIN_URL).origin}/v1/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'a-brand-new-pass' }) });
		expect(bad.status).toBe(401);
	});

	test('an existing account WITH 2FA accepts by signing in once (the code is used a single time) and lands signed in', async ({ browser, api }) => {
		const email = `${uniq('e2fa')}@example.net`;
		await api.post('/staff/invites', { email, role: 'staff' });
		await acceptInvite(await inviteTokenFor(email));
		const mine = await AdminApi.login(email, PASSWORD);
		const { secret } = await mine.post<{ secret: string }>('/2fa/setup');
		await mine.post('/2fa/enable', { secret, code: totpAt(secret, totpStep()), password: PASSWORD });
		const id = (await api.get<{ items: { adminUserId: string; email: string }[] }>('/staff')).items.find((m) => m.email === email)!.adminUserId;
		await api.raw('DELETE', `/staff/${id}`);
		await api.post('/staff/invites', { email, role: 'manager' });

		const context = await browser.newContext({ baseURL: ADMIN_URL, storageState: { cookies: [], origins: [] } });
		const page = await context.newPage();
		await page.goto(await inviteLinkFor(email));
		await field(page, 'Email').fill(email);
		await field(page, 'Password').fill('irrelevant-new-pass');
		await field(page, 'Confirm password').fill('irrelevant-new-pass');
		await page.getByRole('button', { name: 'Accept invitation' }).click();
		await expect(page.getByRole('heading', { name: 'Join with your existing account' })).toBeVisible();
		await field(page, 'Current password').fill(PASSWORD);
		await page.getByRole('button', { name: 'Sign in and accept' }).click();
		// #333: the code step follows the verified password; a different step than /2fa/enable used; auto-submits at 6 digits
		await field(page, 'Authentication code').fill(totpAt(secret, totpStep() + 1));
		await expect(page).toHaveURL(`${ADMIN_URL}/`, { timeout: 15_000 });
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
		await context.close();
		const members = (await api.get<{ items: { email: string; role: string }[] }>('/staff')).items;
		expect(members.find((m) => m.email === email)?.role).toBe('manager');
	});

	test('the accept-invite screen without a token explains how to get one', async ({ page }) => {
		await page.goto('/accept-invite');
		await expect(page.getByRole('heading', { name: 'This invitation link is incomplete' })).toBeVisible();
	});
});
