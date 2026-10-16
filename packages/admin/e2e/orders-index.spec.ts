import { test, expect, row, toast } from './fixtures';
import { createOrder, createPendingOrder, uniq, SKU } from './support/api';

/**
 * Plan 1.3 #9 — Orders index: saved views, search by code/email, payment + fulfillment filters,
 * bulk fulfill, bulk cancel (unpaid only), trash / restore / purge.
 * Supersedes (see report): admin-orders.bulk.test.ts, admin-order-ops bulk/soft-delete db paths.
 */
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
		await page.goto('/orders');
		const search = page.getByLabel('Search code or email');
		await search.fill(paidA);
		await expect(row(page, paidA)).toHaveCount(1);
		await expect(row(page, paidB)).toHaveCount(0);

		await search.fill(email('b'));
		await expect(row(page, paidB)).toHaveCount(1);
		await expect(row(page, paidA)).toHaveCount(0);

		// shared prefix matches all four orders this spec created
		await search.fill(u);
		for (const code of [paidA, paidB, pending, shipped]) await expect(row(page, code)).toHaveCount(1);
		await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
	});

	test('payment and fulfillment filters are reflected in the URL and the table', async ({ page }) => {
		await page.goto('/orders');
		await page.getByLabel('Search code or email').fill(u);
		await expect(row(page, paidA)).toHaveCount(1);

		await page.getByLabel('Payment filter').selectOption('pending');
		await expect(page).toHaveURL(/paymentStatus=pending/);
		await expect(row(page, pending)).toHaveCount(1);
		await expect(row(page, paidA)).toHaveCount(0);

		await page.getByLabel('Payment filter').selectOption('paid');
		await page.getByLabel('Fulfillment filter').selectOption('fulfilled');
		await expect(page).toHaveURL(/fulfillmentStatus=fulfilled/);
		await expect(row(page, shipped)).toHaveCount(1);
		await expect(row(page, paidA)).toHaveCount(0);
		await expect(row(page, shipped)).toContainText('Fulfilled');

		await page.getByLabel('Fulfillment filter').selectOption('unfulfilled');
		await expect(row(page, paidA)).toHaveCount(1);
		await expect(row(page, paidB)).toHaveCount(1);
		await expect(row(page, shipped)).toHaveCount(0);
		await expect(row(page, pending)).toHaveCount(0);

		await page.getByRole('button', { name: 'Clear', exact: true }).click();
		await expect(page).not.toHaveURL(/paymentStatus/);
	});

	test('built-in and user-saved views apply filters; saved view survives a reload', async ({ page }) => {
		await page.goto('/orders');
		await page.getByLabel('Search code or email').fill(u);
		await page.getByRole('button', { name: 'Unpaid', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Unpaid', exact: true })).toHaveAttribute('aria-pressed', 'true');
		await expect(row(page, pending)).toHaveCount(1);
		await expect(row(page, paidA)).toHaveCount(0);

		// "Save current filters as view" uses window.prompt
		const viewName = `Mine ${u}`;
		page.once('dialog', (d) => d.accept(viewName));
		await page.getByRole('button', { name: 'Actions' }).click();
		await page.getByRole('menuitem', { name: 'Save current filters as view' }).click();
		await expect(page.getByRole('button', { name: viewName, exact: true })).toBeVisible();

		await page.getByRole('button', { name: 'All', exact: true }).click();
		await page.getByLabel('Search code or email').fill(u);
		await expect(row(page, paidA)).toHaveCount(1);

		await page.reload();
		const mine = page.getByRole('button', { name: viewName, exact: true });
		await expect(mine).toBeVisible();
		await page.getByLabel('Search code or email').fill(u);
		await mine.click();
		await expect(page).toHaveURL(/paymentStatus=pending/);
		await expect(row(page, pending)).toHaveCount(1);
		await expect(row(page, paidA)).toHaveCount(0);

		await page.getByRole('button', { name: `Delete view ${viewName}` }).click();
		await expect(page.getByRole('button', { name: viewName, exact: true })).toHaveCount(0);
	});

	test('bulk fulfill marks selected paid orders shipped and consumes live stock', async ({ page, api }) => {
		const before = await api.stock(SKU.tee);
		await page.goto('/orders');
		await page.getByLabel('Search code or email').fill(u);
		await page.getByLabel('Payment filter').selectOption('paid');
		await page.getByLabel('Fulfillment filter').selectOption('unfulfilled');
		await page.getByLabel(`Select row ${paidA}`).check();
		await page.getByLabel(`Select row ${paidB}`).check();
		await expect(page.getByText('2 selected')).toBeVisible();
		await page.getByRole('button', { name: 'Mark shipped' }).click();
		await expect(toast(page, '2 orders marked shipped')).toBeVisible();

		for (const code of [paidA, paidB]) expect((await api.order(code)).fulfillmentStatus).toBe('fulfilled');
		// Shipping converts the reservation into a real decrement: live on-hand and allocated both drop by 2.
		const after = await api.stock(SKU.tee);
		expect(after.onHand).toBe(before.onHand - 2);
		expect(after.allocated).toBe(before.allocated - 2);
	});

	test('bulk cancel only cancels unpaid orders and releases their stock; paid orders are reported, not changed', async ({ page, api }) => {
		const tag = uniq('bc');
		const unpaid = (await createPendingOrder(api, { email: `${tag}-u@example.net`, items: [{ sku: SKU.mug, quantity: 3 }] })).code;
		const paid = (await createOrder(api, { email: `${tag}-p@example.net`, items: [{ sku: SKU.mug, quantity: 1 }] })).code;
		const reserved = await api.stock(SKU.mug);

		await page.goto('/orders');
		await page.getByLabel('Search code or email').fill(tag);
		await expect(row(page, unpaid)).toHaveCount(1);
		await page.getByLabel(`Select row ${unpaid}`).check();
		await page.getByLabel(`Select row ${paid}`).check();
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();

		await expect(toast(page, '1 succeeded, 1 failed')).toBeVisible();
		await expect(page.getByText(/paid order — use Refund/).first()).toBeVisible();
		expect((await api.order(unpaid)).state).toBe('Cancelled');
		expect((await api.order(paid)).state).toBe('Paid');
		expect((await api.stock(SKU.mug)).allocated).toBe(reserved.allocated - 3);
	});

	test('trash, restore and purge (a paid order is purged only with a written reason)', async ({ page, api }) => {
		const tag = uniq('tr');
		const unpaid = (await createPendingOrder(api, { email: `${tag}-u@example.net` })).code;
		const paid = (await createOrder(api, { email: `${tag}-p@example.net` })).code;

		await page.goto('/orders');
		await page.getByLabel('Search code or email').fill(tag);
		await page.getByLabel(`Select row ${unpaid}`).check();
		await page.getByLabel(`Select row ${paid}`).check();
		await page.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect(toast(page, '2 orders moved to trash')).toBeVisible();
		await expect(row(page, unpaid)).toHaveCount(0);

		// Archived view = the trash
		await page.getByRole('button', { name: 'Archived', exact: true }).click();
		await page.getByLabel('Search code or email').fill(tag);
		await expect(row(page, unpaid)).toHaveCount(1);
		await expect(row(page, paid)).toHaveCount(1);

		// restore the paid one
		await page.getByLabel(`Select row ${paid}`).check();
		await page.getByRole('button', { name: 'Restore' }).click();
		await expect(toast(page, '1 order restored')).toBeVisible();
		await expect(row(page, paid)).toHaveCount(0);
		await page.getByRole('button', { name: 'All', exact: true }).click();
		await page.getByLabel('Search code or email').fill(tag);
		await expect(row(page, paid)).toHaveCount(1);

		// purge the unpaid one permanently (confirm dialog) …
		await page.getByRole('button', { name: 'Archived', exact: true }).click();
		await page.getByLabel('Search code or email').fill(tag);
		await page.getByLabel(`Select row ${unpaid}`).check();
		await page.getByRole('button', { name: 'Delete permanently' }).click();
		await expect(page.getByRole('alertdialog')).toContainText('Permanently delete 1 order?');
		await page.getByRole('alertdialog').getByRole('button', { name: 'Delete permanently' }).click();
		await expect(toast(page, '1 order purged')).toBeVisible();
		expect((await api.raw('GET', `/orders/${unpaid}`)).status).toBe(404);

		// … a trashed PAID order needs force + a written reason: the dialog blocks until one is typed, Cancel leaves it alone
		await api.post('/orders/bulk-soft-delete', { codes: [paid] });
		await page.reload();
		await page.getByLabel('Search code or email').fill(paid);
		await page.getByLabel(`Select row ${paid}`).check();
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
