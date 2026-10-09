import type { Browser, Page } from '@playwright/test';
import { test, expect, row, toast, field, gotoStable } from './fixtures';
import { AdminApi, createOrder, createPendingOrder, uniq } from './support/api';
import { ADMIN_URL } from './support/env.mjs';

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
	await expect(page.getByText('Invite created.')).toBeVisible();
	// the one-time raw token is shown exactly once, next to the copyable accept URL
	const token = await page.locator('input[readonly]').nth(1).inputValue();
	expect(token).toMatch(/^[0-9a-f]{48}$/);
	await expect(page.locator('input[readonly]').first()).toHaveValue(new RegExp(`accept-invite\\?token=${token}$`));
	return token;
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
	await page.getByRole('button', { name: 'Sign in' }).click();
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
		const inv = await api.post<{ token: string; acceptUrl: string }>('/staff/invites', { email, role: 'staff' });
		expect(inv.acceptUrl).toBe(`/admin/accept-invite?token=${inv.token}`);
		const context = await browser.newContext({ baseURL: ADMIN_URL, storageState: { cookies: [], origins: [] } });
		const page = await context.newPage();
		await page.goto(`/accept-invite?token=${inv.token}`);
		await field(page, 'Email').fill(email);
		await field(page, 'Password').fill('short');
		await field(page, 'Confirm password').fill('short');
		await page.getByRole('button', { name: 'Accept invitation' }).click();
		await expect(page.getByText('Password must be at least 8 characters.')).toBeVisible();
		await field(page, 'Password').fill(PASSWORD);
		await field(page, 'Confirm password').fill(`${PASSWORD}x`);
		await page.getByRole('button', { name: 'Accept invitation' }).click();
		await expect(page.getByText('Passwords do not match.')).toBeVisible();
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

	test('the accept-invite screen without a token explains how to get one', async ({ page }) => {
		await page.goto('/accept-invite');
		await expect(page.getByRole('heading', { name: 'No invite token' })).toBeVisible();
	});
});
