import { test, expect, row, toast } from './fixtures';
import { createOrder, createPendingOrder, uniq, SKU } from './support/api';

/**
 * Plan 1.3 #9 — Orders index: saved views, search by code/email, payment + fulfillment filters,
 * bulk fulfill, bulk cancel (unpaid only), trash / restore / purge.
 * Supersedes (see report): admin-orders.bulk.test.ts, admin-order-ops bulk/soft-delete db paths.
 */
type Pg = import('@playwright/test').Page;
const searchBox = (page: Pg) => page.getByPlaceholder('Code, email, name or phone');
const tab = (page: Pg, name: string) => page.getByRole('tab', { name: new RegExp(`^${name}( \\d|$)`) });
const pick = async (page: Pg, chip: RegExp, option: string) => {
	await page.getByRole('button', { name: chip }).first().click();
	await page.getByRole('menuitemradio', { name: option, exact: true }).click();
};
/** Type in the search box and wait for the debounced ?q= to land (it resets selection and paging when it does). */
const search = async (page: Pg, text: string) => {
	await searchBox(page).fill(text);
	await expect(page).toHaveURL(new RegExp(`[?&]q=${encodeURIComponent(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(&|$)`));
};
const select = (page: Pg, code: string) => page.getByLabel(`Select ${code}`, { exact: true });

test.describe('orders index', () => {
	const u = uniq('ox');
	const email = (tag: string) => `${u}-${tag}@example.net`;
	let paidA: string, paidB: string, pending: string, shipped: string;

	test.beforeAll(async ({ api }) => {
		paidA = (await createOrder(api, { email: email('a') })).code;
		paidB = (await createOrder(api, { email: email('b') })).code;
		pending = (await createPendingOrder(api, { email: email('c') })).code;
		shipped = (await createOrder(api, { email: email('d') })).code;
		await api.post(`/orders/${shipped}/fulfill`, { state: 'Shipped', trackingCode: '1Z999AA10123456784', carrier: 'UPS' });
	});

	test('search by order code and by customer email', async ({ page }) => {
		await page.goto('/orders?tab=all');
		await search(page, paidA);
		await expect(row(page, paidA)).toHaveCount(1);
		await expect(row(page, paidB)).toHaveCount(0);

		await search(page, email('b'));
		await expect(row(page, paidB)).toHaveCount(1);
		await expect(row(page, paidA)).toHaveCount(0);

		// shared prefix matches all four orders this spec created
		await search(page, u);
		for (const code of [paidA, paidB, pending, shipped]) await expect(row(page, code)).toHaveCount(1);
		await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
	});

	test('payment filter and view tabs are reflected in the URL and the table', async ({ page }) => {
		await page.goto('/orders?tab=all');
		await search(page, u);
		await expect(row(page, paidA)).toHaveCount(1);

		await pick(page, /^Payment$/, 'Pending');
		await expect(page).toHaveURL(/paymentStatus=pending/);
		await expect(row(page, pending)).toHaveCount(1);
		await expect(row(page, paidA)).toHaveCount(0);

		await pick(page, /^Payment is Pending$/, 'Paid');
		await expect(page).toHaveURL(/paymentStatus=paid/);
		await tab(page, 'Shipped').click();
		await expect(page).toHaveURL(/tab=shipped/);
		await expect(row(page, shipped)).toHaveCount(1);
		await expect(row(page, paidA)).toHaveCount(0);
		await expect(row(page, shipped)).toContainText('Fulfilled');

		await tab(page, 'To fulfil').click();
		await expect(row(page, paidA)).toHaveCount(1);
		await expect(row(page, paidB)).toHaveCount(1);
		await expect(row(page, shipped)).toHaveCount(0);
		await expect(row(page, pending)).toHaveCount(0);

		await page.getByRole('button', { name: 'Remove filter: payment is Paid' }).click();
		await expect(page).not.toHaveURL(/paymentStatus/);
	});

	test('built-in and user-saved views apply filters; saved view survives a reload', async ({ page }) => {
		await page.goto('/orders?tab=all');
		await search(page, u);
		await tab(page, 'Unpaid').click();
		await expect(tab(page, 'Unpaid')).toHaveAttribute('aria-selected', 'true');
		await expect(row(page, pending)).toHaveCount(1);
		await expect(row(page, paidA)).toHaveCount(0);
		await pick(page, /^Payment$/, 'Pending');
		await expect(page).toHaveURL(/paymentStatus=pending/);

		const viewName = `Mine ${u}`;
		await page.getByRole('button', { name: 'Save view', exact: true }).click();
		await page.getByLabel('View name').fill(viewName);
		await page.getByRole('button', { name: 'Save view', exact: true }).last().click();
		await expect(toast(page, 'View saved')).toBeVisible();
		await expect(page.getByRole('tab', { name: viewName, exact: true })).toHaveAttribute('aria-selected', 'true');

		await tab(page, 'All').click();
		await page.getByRole('button', { name: 'Remove filter: payment is Pending' }).click();
		await search(page, u);
		await expect(row(page, paidA)).toHaveCount(1);

		await page.reload();
		const mine = page.getByRole('tab', { name: viewName, exact: true });
		await expect(mine).toBeVisible();
		await search(page, u);
		await mine.click();
		await expect(page).toHaveURL(/tab=unpaid/);
		await expect(page).toHaveURL(/paymentStatus=pending/);
		await expect(row(page, pending)).toHaveCount(1);
		await expect(row(page, paidA)).toHaveCount(0);

		await page.getByRole('button', { name: 'Delete view' }).click();
		await expect(page.getByRole('tab', { name: viewName, exact: true })).toHaveCount(0);
	});

	test('bulk fulfill marks selected paid orders shipped and consumes live stock', async ({ page, api }) => {
		const before = await api.stock(SKU.tee);
		await page.goto('/orders');
		await search(page, u);
		await pick(page, /^Payment$/, 'Paid');
		await select(page, paidA).check();
		await select(page, paidB).check();
		await expect(page.getByText('2 selected')).toBeVisible();
		await page.getByRole('toolbar', { name: 'Bulk actions' }).getByRole('button', { name: 'Fulfil', exact: true }).click();
		const confirm = page.getByRole('alertdialog');
		await expect(confirm).toContainText('Mark 2 orders as shipped?');
		await confirm.getByRole('button', { name: 'Mark shipped' }).click();
		await expect(toast(page, '2 orders marked shipped')).toBeVisible();

		for (const code of [paidA, paidB]) expect((await api.order(code)).fulfillmentStatus).toBe('fulfilled');
		// Shipping converts the reservation into a real decrement: live on-hand and allocated both drop by 2.
		const after = await api.stock(SKU.tee);
		expect(after.onHand).toBe(before.onHand - 2);
		expect(after.allocated).toBe(before.allocated - 2);
	});

	test('bulk cancel only cancels unpaid orders and releases their stock; paid orders are refused, not changed', async ({ page, api }) => {
		const tag = uniq('bc');
		const unpaid = (await createPendingOrder(api, { email: `${tag}-u@example.net`, items: [{ sku: SKU.mug, quantity: 3 }] })).code;
		const paid = (await createOrder(api, { email: `${tag}-p@example.net`, items: [{ sku: SKU.mug, quantity: 1 }] })).code;
		const reserved = await api.stock(SKU.mug);

		await page.goto('/orders?tab=all');
		await search(page, tag);
		await expect(row(page, unpaid)).toHaveCount(1);
		await select(page, unpaid).check();
		await select(page, paid).check();
		// the UI refuses a mixed selection outright
		const bar = page.getByRole('toolbar', { name: 'Bulk actions' });
		await expect(bar.getByRole('button', { name: 'Cancel unpaid' })).toBeDisabled();
		expect((await api.order(paid)).state).toBe('Paid');
		expect((await api.order(unpaid)).state).toBe('PendingPayment');

		await select(page, paid).uncheck();
		await bar.getByRole('button', { name: 'Cancel unpaid' }).click();
		await expect(toast(page, '1 order cancelled')).toBeVisible();
		expect((await api.order(unpaid)).state).toBe('Cancelled');
		expect((await api.order(paid)).state).toBe('Paid');
		expect((await api.stock(SKU.mug)).allocated).toBe(reserved.allocated - 3);

		// and the server independently reports a paid order as failed (refund is the only way), leaving it untouched
		const res = await api.post('/orders/bulk-cancel', { codes: [paid] });
		expect(res.results).toEqual([expect.objectContaining({ code: paid, ok: false, error: expect.stringMatching(/paid order — use Refund/) })]);
		expect((await api.order(paid)).state).toBe('Paid');
		expect((await api.stock(SKU.mug)).allocated).toBe(reserved.allocated - 3);
	});

	test('trash, restore and purge (a paid order is purged only with a written reason)', async ({ page, api }) => {
		const tag = uniq('tr');
		const unpaid = (await createPendingOrder(api, { email: `${tag}-u@example.net` })).code;
		const paid = (await createOrder(api, { email: `${tag}-p@example.net` })).code;

		await page.goto('/orders?tab=all');
		await search(page, tag);
		await select(page, unpaid).check();
		await select(page, paid).check();
		await page.getByRole('button', { name: 'Move to trash' }).click();
		await expect(toast(page, '2 orders moved to trash')).toBeVisible();
		await expect(row(page, unpaid)).toHaveCount(0);

		// Archived tab = the trash
		await tab(page, 'Archived').click();
		await expect(page).toHaveURL(/tab=archived/);
		await expect(row(page, unpaid)).toHaveCount(1);
		await expect(row(page, paid)).toHaveCount(1);

		// restore the paid one
		await select(page, paid).check();
		await page.getByRole('button', { name: 'Restore' }).click();
		await expect(toast(page, '1 order restored')).toBeVisible();
		await expect(row(page, paid)).toHaveCount(0);
		await tab(page, 'All').click();
		await expect(row(page, paid)).toHaveCount(1);

		// purge the unpaid one permanently (confirm dialog) …
		await tab(page, 'Archived').click();
		await select(page, unpaid).check();
		await page.getByRole('button', { name: 'Delete permanently' }).click();
		await expect(page.getByRole('alertdialog')).toContainText('Permanently delete 1 order?');
		await page.getByRole('alertdialog').getByRole('button', { name: 'Delete permanently' }).click();
		await expect(toast(page, '1 order purged')).toBeVisible();
		expect((await api.raw('GET', `/orders/${unpaid}`)).status).toBe(404);

		// … a trashed PAID order needs force + a written reason: the dialog blocks until one is typed, Cancel leaves it alone
		await api.post('/orders/bulk-soft-delete', { codes: [paid] });
		await page.goto('/orders?tab=archived');
		await search(page, paid);
		await select(page, paid).check();
		await page.getByRole('button', { name: 'Delete permanently' }).click();
		const forceDialog = page.getByRole('alertdialog');
		await expect(forceDialog).toContainText('Permanently delete 1 order?');
		await expect(forceDialog).toContainText(paid);
		await expect(forceDialog.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
		await forceDialog.getByRole('button', { name: 'Cancel' }).click();
		expect((await api.raw('GET', `/orders/${paid}`)).status).toBe(200);

		await page.getByRole('button', { name: 'Delete permanently' }).click();
		await expect(forceDialog.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
		await forceDialog.getByLabel('Reason (required)').fill('duplicate test order');
		await forceDialog.getByRole('button', { name: 'Delete permanently' }).click();
		await expect(toast(page, '1 order purged')).toBeVisible();
		expect((await api.raw('GET', `/orders/${paid}`)).status).toBe(404);
	});
});
