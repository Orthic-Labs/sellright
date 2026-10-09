import { test, expect, prepareShopperPage, skipExternal } from './fixtures';
import { PASSWORD, registerAndVerify, signInWithPassword, startSignIn } from './support/account';
import { SKU, mailTo, paidOrder, readRows, sentEmails, uniq } from './support/api';
import { linkInMail, mock } from './support/mock';

/**
 * Plan 1.3 P2 #19 — the shopper's account, through the real storefront UI: register, verify by the emailed link, sign in
 * (password and magic link read from the SMTP sink), address book, order history, guest order tracking.
 * One fresh customer per describe block; each test starts signed out (fresh browser context).
 */
skipExternal();
test.beforeEach(() => mock.reset());

test.describe.serial('#19 account: register, verify, sign in', () => {
	let email = ''; // minted by the first test of each run of this group, so --repeat-each never reuses an address

	test('register -> verification email -> verify link -> password sign-in lands on the account', async ({ apiProxyPage: page, api }) => {
		email = `${uniq('acct')}@example.net`;
		await registerAndVerify(page, email);
		await sentEmails(api, email, 'email_verify');
		expect((await readRows<{ email_verified: boolean }>(api, `SELECT email_verified FROM customer WHERE email = $1`, [email]))[0]!.email_verified).toBe(true);
		await signInWithPassword(page, email);
		await expect(page).toHaveURL(/\/account\/?$/);
		// A full page load (refresh, a bookmark, a link from an email) keeps the session: the server-side guard of /account/*
		// must recognise the API's session cookie, not just the client-side navigation that followed the sign-in.
		await page.goto('/account/orders');
		await expect(page).toHaveURL(/\/account\/orders\/?$/);
		await expect(page.getByRole('heading', { name: /no orders yet/i })).toBeVisible({ timeout: 15_000 });
	});

	test('a wrong password is refused with a message and no session', async ({ apiProxyPage: page }) => {
		await startSignIn(page, email);
		await page.locator('input[autocomplete="current-password"]').fill('not-the-password-1');
		await page.getByRole('button', { name: /^sign in$/i }).click();
		await expect(page.getByRole('alert').or(page.getByText(/invalid email or password/i)).first()).toBeVisible({ timeout: 10_000 });
		await expect(page).toHaveURL(/\/sign-in/);
	});

	test('magic link: request from the sign-in page -> link in the SMTP sink -> opening it signs the shopper in, once', async ({ apiProxyPage: page, api, browser }) => {
		await startSignIn(page, email);
		await page.getByTestId('magic-link-request').click();
		await expect(page.getByTestId('magic-link-sent')).toBeVisible({ timeout: 15_000 });

		const mail = await mailTo(email, (m) => !!linkInMail(m, 'token='), 'sign-in link email');
		const link = linkInMail(mail, 'token=')!;
		expect(new URL(link).pathname).toBe('/account/magic-link');
		await sentEmails(api, email, 'magic_link');

		await page.goto(link);
		await page.waitForURL(/\/account\/?$/, { timeout: 20_000 });

		// The link is single-use: a second visit (fresh browser context, so signed out) is refused.
		const other = await browser.newContext();
		const again = await prepareShopperPage(await other.newPage());
		await again.goto(link);
		await expect(again.getByRole('alert')).toContainText(/invalid, expired, or already used/i, { timeout: 15_000 });
		await other.close();
	});

	test('magic link for an address with no account answers like any other (no existence leak) and sends nothing', async ({ apiProxyPage: page }) => {
		const stranger = `${uniq('nobody')}@example.net`;
		await page.goto('/sign-in');
		const status = await page.evaluate(async (e) => (await fetch('/v1/shop/auth/magic-link/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e }) })).status, stranger);
		expect(status).toBe(200);
		await page.waitForTimeout(2_500);
		expect((await mock.mails()).filter((m) => m.envelopeTo.includes(stranger))).toHaveLength(0);
	});
});

test.describe.serial('#19 account: address book and order history', () => {
	let email = '';

	test('setup: a verified customer', async ({ apiProxyPage: page }) => {
		email = `${uniq('book')}@example.net`;
		await registerAndVerify(page, email, { first: 'Grace', last: 'Hopper' });
	});

	test('address book: add -> edit -> delete, each reflected by the API', async ({ apiProxyPage: page, api }) => {
		await signInWithPassword(page, email);
		await page.goto('/account/address-book');
		await expect(page.getByText(/no saved addresses yet/i)).toBeVisible({ timeout: 15_000 });

		// Add
		await page.getByRole('button', { name: /new address/i }).click();
		await page.waitForURL('**/account/address-book/add**');
		await fillAddress(page, { street: '1 Compiler Way', city: 'Reno', state: 'NV', zip: '89501' });
		await page.getByRole('button', { name: /^\s*save/i }).click();
		await page.waitForURL(/\/account\/address-book\/?$/, { timeout: 20_000 });
		await expect(page.getByText('1 Compiler Way')).toBeVisible({ timeout: 15_000 });
		const rows = () => readRows<{ id: string; line1: string; city: string; province: string }>(api, `SELECT a.id, a.line1, a.city, a.province FROM address a JOIN customer c ON c.id = a.customer_id WHERE c.email = $1`, [email]);
		expect(await rows()).toMatchObject([{ line1: '1 Compiler Way', city: 'Reno', province: 'NV' }]);

		// Edit
		await page.getByRole('button', { name: /edit/i }).first().click();
		await page.waitForURL(/\/account\/address-book\/[0-9a-f-]{36}/);
		await page.locator('#streetLine1').fill('2 Debugger Drive');
		await page.getByRole('button', { name: /^\s*save/i }).click();
		await page.waitForURL(/\/account\/address-book\/?$/, { timeout: 20_000 });
		await expect(page.getByText('2 Debugger Drive')).toBeVisible({ timeout: 15_000 });
		expect(await rows()).toMatchObject([{ line1: '2 Debugger Drive', city: 'Reno' }]);
		expect(await rows()).toHaveLength(1); // an edit updates in place, it never duplicates

		// Delete
		await page.getByRole('button', { name: /delete/i }).first().click();
		await expect(page.getByText(/no saved addresses yet/i)).toBeVisible({ timeout: 15_000 });
		expect(await rows()).toHaveLength(0);
	});
});

test.describe('#19 order history and guest tracking', () => {
	test('a signed-in customer sees their paid order in the history and opens its detail', async ({ apiProxyPage: page, api }) => {
		const email = `${uniq('hist')}@example.net`;
		await registerAndVerify(page, email, { first: 'Edsger', last: 'Dijkstra' });
		const placed = await paidOrder({ email, items: [{ sku: SKU.mug, quantity: 2 }] }); // checkout email = the verified account email
		await signInWithPassword(page, email);
		await page.goto('/account/orders');
		const row = page.getByRole('link', { name: new RegExp(`Order #${placed.code}`) });
		await expect(row).toBeVisible({ timeout: 15_000 });
		await expect(row).toContainText(`$${placed.grandTotal / 100}`); // whole-dollar totals print without cents
		await row.click();
		await page.waitForURL(`**/account/orders/${placed.code}**`);
		await expect(page.getByText('E2E Mug').first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText(/Qty: 2/)).toBeVisible();
		// The bare /orders/{code} link that order emails carry leads a signed-in customer to this very page.
		await page.goto(`/orders/${placed.code}`);
		await page.waitForURL(`**/account/orders/${placed.code}**`, { timeout: 20_000 });
		expect((await api.order(placed.code)).state).toBe('Paid');
	});

	test('another customer cannot open that order from their own account', async ({ apiProxyPage: page }) => {
		const owner = `${uniq('own')}@example.net`;
		const intruder = `${uniq('intr')}@example.net`;
		const placed = await paidOrder({ email: owner, items: [{ sku: SKU.book, quantity: 1 }] });
		await registerAndVerify(page, intruder);
		await signInWithPassword(page, intruder);
		await page.goto(`/account/orders/${placed.code}`);
		await expect(page.getByText(/order not found/i)).toBeVisible({ timeout: 15_000 });
	});

	test('guest tracking needs the order number AND the checkout email; a wrong email learns nothing', async ({ apiProxyPage: page, api }) => {
		const email = `${uniq('track')}@example.net`;
		const placed = await paidOrder({ email, items: [{ sku: SKU.shirt, quantity: 1 }] });
		await api.post(`/orders/${placed.code}/fulfillments`, { lines: [{ orderLineId: ((await api.order(placed.code)).lines[0] as { id: string }).id, quantity: 1 }], trackingCode: 'TRACK-E2E-1', carrier: 'UPS', notifyCustomer: false });

		await page.goto('/track-order');
		await page.waitForLoadState('networkidle');
		const track = async (code: string, who: string) => {
			await expect(async () => {
				await page.locator('#orderCode').fill(code);
				await page.locator('#email').fill(who);
				await expect(page.locator('#email')).toHaveValue(who, { timeout: 1_000 });
			}).toPass({ timeout: 15_000 });
			await page.getByRole('button', { name: /^track order$/i }).click();
		};

		// Wrong email: the same "not found" as a made-up order, nothing about the order is revealed.
		await track(placed.code, `wrong-${email}`);
		await expect(page.getByText(/unable to track order/i)).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText(`Order #${placed.code}`)).toHaveCount(0);

		// Right email (case-insensitive): status, the line and the tracking number.
		await track(placed.code, email.toUpperCase());
		await expect(page.getByText(`Order #${placed.code}`)).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText('E2E Shirt').first()).toBeVisible();
		await expect(page.getByText(/CK-E2E-1/).first()).toBeVisible(); // the tracking number is shown masked to its tail
	});
});

async function fillAddress(page: import('@playwright/test').Page, a: { street: string; city: string; state: string; zip: string }) {
	await expect(async () => {
		await page.locator('#fullName').fill('Grace Hopper');
		await page.locator('#streetLine1').fill(a.street);
		await page.locator('#postalCode').fill(a.zip);
		await page.locator('#city').fill(a.city);
		await page.locator('#province').fill(a.state);
		await page.keyboard.press('Tab');
		await page.waitForTimeout(500);
		await expect(page.locator('#streetLine1')).toHaveValue(a.street, { timeout: 1_000 });
		await expect(page.locator('#city')).toHaveValue(a.city, { timeout: 1_000 });
	}).toPass({ timeout: 20_000 });
}
