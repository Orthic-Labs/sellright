import { test, expect, toast } from './fixtures';
import { createOrder, uniq, SKU, US_ADDRESS } from './support/api';

/**
 * Order editing on a PAID order (plan §5 / G13, G5): add an item, change a quantity, add an adjustment and edit the
 * address -> server preview (new totals, per-line diff, stock check, balance) -> commit with "leave due" -> the order
 * reads "Balance due". Stock is asserted from the live inventory endpoint, never a fixture.
 * Supersedes: admin-order-edit.db.test.ts (route + settlement paths), orders/order-edit.test.ts (HTTP-visible rules).
 */
test.describe('edit a paid order', () => {
	test('add item + change quantity + adjustment + address -> preview -> commit leave_due -> Balance due', async ({ page, api }) => {
		const email = `${uniq('oe')}@example.net`;
		const { code, grandTotal } = await createOrder(api, { email }); // 1 x tee ($25.00) + $5.00 shipping = $30.00, paid
		expect(grandTotal).toBe(3000);
		const tee0 = await api.stock(SKU.tee);
		const mug0 = await api.stock(SKU.mug);

		await page.goto(`/orders/${code}`);
		await expect(page.getByRole('heading', { name: code })).toBeVisible();
		// stage: a ship-to country change. It cannot be saved directly, so the address card hands the staged
		// address to the same edit session as the item changes below.
		await page.getByRole('button', { name: 'Edit shipping address' }).click();
		await page.locator('#addr-shipping-country').fill('CA');
		await page.getByRole('button', { name: 'Save address' }).click();
		await expect(page.getByRole('heading', { name: 'Edit order' })).toBeVisible();
		await expect(page.getByText('Address change')).toBeVisible();

		// stage: quantity 1 -> 2
		await page.getByLabel(`Increase quantity of ${SKU.tee}`).click();
		await expect(page.getByLabel(`Quantity of ${SKU.tee}`, { exact: true })).toHaveValue('2');
		// stage: add a mug via variant search
		await page.getByPlaceholder('Add an item — search by name or SKU').fill('E2E-MUG');
		await page.getByRole('button', { name: new RegExp(SKU.mug) }).click();
		await expect(page.getByLabel(`Quantity of added ${SKU.mug}`)).toHaveValue('1');
		// stage: a +$3.00 adjustment
		await page.getByLabel('Adjustment label').fill('Rush fee');
		await page.getByLabel('Adjustment amount').fill('3.00');
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		await expect(page.getByText('Rush fee')).toBeVisible();

		// preview: 2 x 25.00 + 12.00 + 5.00 shipping + 3.00 adjustment = 70.00; paid 30.00 -> $40.00 due
		const review = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Review and settle' }) });
		await expect(review).toContainText('New total');
		await expect(review.getByText('New total').locator('xpath=following-sibling::*[1]')).toHaveText('$70.00');
		await expect(review.getByText('Balance due from customer').locator('xpath=following-sibling::*[1]')).toHaveText('$40.00');
		await expect(review).toContainText('Add 1 ×');
		await expect(review).toContainText(`Stock ${SKU.tee}: reserve 1`);
		await expect(review).toContainText(`Stock ${SKU.mug}: reserve 1`);
		// nothing is written until commit
		expect((await api.order(code)).grandTotal).toBe(3000);
		expect((await api.stock(SKU.tee)).allocated).toBe(tee0.allocated);

		// a balance needs an explicit settlement choice before commit is possible
		const commit = review.getByRole('button', { name: 'Commit changes' });
		await expect(commit).toBeDisabled();
		await review.getByLabel('Leave the balance due (decide later)').check();
		await review.getByPlaceholder('e.g. customer asked to add a second blade').fill('Customer asked for a second tee and a mug');
		await expect(commit).toBeEnabled();
		await commit.click();
		await expect(toast(page, 'Order updated')).toBeVisible();

		// order now reads Balance due
		await expect(page.getByText('Balance due').first()).toBeVisible();
		await expect(page.getByText('The customer still owes $40.00 after an edit.')).toBeVisible();
		const detail = await api.order(code);
		expect(detail).toMatchObject({ grandTotal: 7000, amountDue: 4000, paymentStatus: 'balance_due', state: 'Paid' });
		expect(detail.adjustments).toEqual([expect.objectContaining({ label: 'Rush fee', amount: 300 })]);
		expect(detail.shippingAddress).toMatchObject({ country: 'CA', line1: US_ADDRESS.line1 });
		const bySku = Object.fromEntries(detail.lines.map((l: { sku: string; quantity: number }) => [l.sku, l.quantity]));
		expect(bySku).toMatchObject({ [SKU.tee]: 2, [SKU.mug]: 1 });
		// timeline records the edit with its reason
		await expect(page.getByText('Order edited')).toBeVisible();
		await expect(page.getByText(/Customer asked for a second tee and a mug/).first()).toBeVisible();

		// live stock moved by exactly the unfulfilled delta (+1 tee, +1 mug reserved)
		expect((await api.stock(SKU.tee)).allocated).toBe(tee0.allocated + 1);
		expect((await api.stock(SKU.mug)).allocated).toBe(mug0.allocated + 1);

		// the orders list / Balance due view surfaces it
		await page.goto('/orders');
		await page.getByLabel('Search code or email').fill(email);
		await page.getByRole('button', { name: 'Balance due', exact: true }).click();
		await expect(page.getByRole('row').filter({ hasText: code })).toContainText('Balance due');
	});

	test('same-country address edit on a paid order saves straight to the order (no address book needed)', async ({ page, api }) => {
		const { code } = await createOrder(api, { email: `${uniq('oa')}@example.net` });
		await page.goto(`/orders/${code}`);
		await page.getByRole('button', { name: 'Edit shipping address' }).click();
		await page.locator('#addr-shipping-line1').fill('99 Moved Ave');
		await page.locator('#addr-shipping-city').fill('Sparks');
		await page.getByPlaceholder('e.g. customer moved').fill('customer moved');
		await page.getByRole('button', { name: 'Save address' }).click();
		await expect(toast(page, 'Shipping address updated')).toBeVisible();
		await expect(page.getByText('99 Moved Ave')).toBeVisible();

		const detail = await api.order(code);
		expect(detail.shippingAddress).toMatchObject({ line1: '99 Moved Ave', city: 'Sparks', country: US_ADDRESS.country });
		expect(detail.grandTotal).toBe(3000); // an address edit is not a money event
		await expect(page.getByText(/Shipping address edited: customer moved/)).toBeVisible();
	});

	test('changing the ship-to country hands over to the edit preview and commits with no balance change', async ({ page, api }) => {
		const { code } = await createOrder(api, { email: `${uniq('oc')}@example.net` });
		await page.goto(`/orders/${code}`);
		await page.getByRole('button', { name: 'Edit shipping address' }).click();
		await page.locator('#addr-shipping-country').fill('CA');
		await page.getByRole('button', { name: 'Save address' }).click();
		// the API refuses a direct save across countries; the UI continues inside the edit session
		await expect(toast(page, 'Country changed')).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Edit order' })).toBeVisible();
		const review = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Review and settle' }) });
		await expect(review).toContainText('The shipping country changed, so tax and shipping eligibility were recalculated.');
		await review.getByRole('button', { name: 'Commit changes' }).click();
		await expect(toast(page, 'Order updated')).toBeVisible();
		expect((await api.order(code)).shippingAddress).toMatchObject({ country: 'CA' });
	});

	test('reducing a quantity releases stock and reads as credit owed back (leave as credit)', async ({ page, api }) => {
		const { code } = await createOrder(api, { email: `${uniq('od')}@example.net`, items: [{ sku: SKU.mug, quantity: 2 }] });
		const reserved = await api.stock(SKU.mug);
		await page.goto(`/orders/${code}`);
		await page.getByRole('button', { name: 'Edit order' }).click();
		await page.getByLabel(`Decrease quantity of ${SKU.mug}`).click();
		const review = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Review and settle' }) });
		await expect(review.getByText('Owed back to customer').locator('xpath=following-sibling::*[1]')).toHaveText('$12.00');
		await expect(review).toContainText(`Stock ${SKU.mug}: release 1`);
		await review.getByLabel('Leave as credit on the order (no refund yet)').check();
		await review.getByRole('button', { name: 'Commit changes' }).click();
		await expect(toast(page, 'Order updated')).toBeVisible();

		const detail = await api.order(code);
		expect(detail).toMatchObject({ grandTotal: 1200 + 500, amountDue: -1200, state: 'Paid' });
		expect((await api.stock(SKU.mug)).allocated).toBe(reserved.allocated - 1);
		await expect(page.getByText('$12.00 is owed back to the customer.')).toBeVisible();
	});

	test('a stale preview is rejected: the order changing under the editor never commits blindly', async ({ page, api }) => {
		const { code } = await createOrder(api, { email: `${uniq('os')}@example.net` });
		await page.goto(`/orders/${code}`);
		await page.getByRole('button', { name: 'Edit order' }).click();
		await page.getByLabel(`Increase quantity of ${SKU.tee}`).click();
		const review = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Review and settle' }) });
		await expect(review.getByText('New total')).toBeVisible();
		await review.getByLabel('Leave the balance due (decide later)').check();

		// someone else edits the same order after the preview was computed
		await api.post(`/orders/${code}/edit/commit`, await (async () => {
			const pv = await api.post(`/orders/${code}/edit/preview`, { ops: [{ op: 'add_adjustment', label: 'Other staff', amount: 100 }] });
			return { ops: [{ op: 'add_adjustment', label: 'Other staff', amount: 100 }], expectedGrandTotal: pv.after.grandTotal, expectedBalance: pv.balance.amountDue, idempotencyKey: crypto.randomUUID(), settlement: { type: 'leave_due' } };
		})());

		await review.getByRole('button', { name: 'Commit changes' }).click();
		await expect(toast(page, 'Order changed — preview refreshed')).toBeVisible();
		const detail = await api.order(code);
		expect(detail.adjustments).toHaveLength(1); // only the other staff member's edit landed
		expect(detail.lines[0].quantity).toBe(1); // ours did not
	});
});
