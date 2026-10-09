import { test, expect } from './fixtures';
import { ApiFailure, shopCheckout, uniq, SKU } from './support/api';

/**
 * Plan 1.3 #16 (and gap C3/G6) — Shipping rules: create, edit and disable a method in Settings > Shipping and
 * see the checkout quote follow each change through the real checkout route.
 * Supersedes: lib/shipping-method.test.ts form mapping, the shipping PATCH section of admin-order-ops.parity.db.test.ts.
 */
test.describe('shipping rules', () => {
	const u = uniq('sh');
	const CODE = `e2e-${u}`;
	const NAME = `E2E Express ${u}`;

	async function openShipping(page: import('@playwright/test').Page) {
		await page.goto('/settings');
		await page.getByRole('button', { name: 'Shipping', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Shipping methods' })).toBeVisible();
	}
	const item = (page: import('@playwright/test').Page) => page.locator('.divide-y > div').filter({ hasText: CODE });
	const calculator = async (api: import('./support/api').AdminApi) =>
		(await api.get<{ items: { code: string; enabled: boolean; calculator: Record<string, unknown> }[] }>('/shipping-methods')).items.find((m) => m.code === CODE)!;

	test('create a method with a minimum subtotal and a country allow-list; checkout quote follows', async ({ page, api }) => {
		await openShipping(page);
		await page.getByRole('button', { name: 'Add method' }).click();
		const drawer = page.getByRole('dialog', { name: 'Add shipping method' });
		await drawer.locator('#sm-name').fill(NAME);
		await drawer.locator('#sm-code').fill(CODE);
		await drawer.locator('#sm-rate').fill('12.50');
		await drawer.locator('#sm-min').fill('30.00');
		await drawer.locator('#sm-cmode').selectOption('only');
		await drawer.locator('#sm-countries').fill('us');
		await expect(drawer).toContainText('$12.50 flat rate');
		await drawer.getByRole('button', { name: 'Save method' }).click();
		await expect(drawer).toBeHidden();

		await expect(item(page)).toContainText(NAME);
		await expect(item(page)).toContainText('$12.50 flat rate · when the subtotal before discounts is $30.00 or more · to United States only');
		await expect(item(page)).toContainText('Enabled');
		const stored = await calculator(api);
		expect(stored.calculator).toMatchObject({ flat: 1250, min: 3000, countries: ['US'], exclude: false });

		// $25.00 cart is below the $30.00 minimum -> the method is not offered
		await expect(shopCheckout({ email: `${u}-lo@example.net`, shippingMethodCode: CODE })).rejects.toMatchObject({ status: 409 });
		// $50.00 cart qualifies and is quoted the new flat rate
		const ok = await shopCheckout({ email: `${u}-hi@example.net`, shippingMethodCode: CODE, items: [{ sku: SKU.tee, quantity: 2 }] });
		expect(ok.grandTotal).toBe(5000 + 1250);
	});

	test('edit the rate and threshold; the very next checkout uses the new rule', async ({ page, api }) => {
		await openShipping(page);
		await item(page).getByRole('button', { name: 'Edit' }).click();
		const drawer = page.getByRole('dialog', { name: 'Edit shipping method' });
		await expect(drawer.locator('#sm-rate')).toHaveValue('12.50');
		await drawer.locator('#sm-rate').fill('9.00');
		await drawer.locator('#sm-min').fill('20.00');
		await drawer.locator('#sm-cmode').selectOption('except');
		await drawer.locator('#sm-countries').fill('CA, MX');
		await drawer.getByRole('button', { name: 'Save method' }).click();
		await expect(drawer).toBeHidden();

		await expect(item(page)).toContainText('$9.00 flat rate · when the subtotal before discounts is $20.00 or more · everywhere except Canada and Mexico');
		expect((await calculator(api)).calculator).toMatchObject({ flat: 900, min: 2000, countries: ['CA', 'MX'], exclude: true });

		// the $25.00 cart that was refused above now qualifies, at the edited price
		const ok = await shopCheckout({ email: `${u}-e1@example.net`, shippingMethodCode: CODE });
		expect(ok.grandTotal).toBe(2500 + 900);
	});

	test('disable the method: it stays listed as Disabled and checkout no longer offers it', async ({ page, api }) => {
		await openShipping(page);
		await item(page).getByRole('button', { name: 'Edit' }).click();
		const drawer = page.getByRole('dialog', { name: 'Edit shipping method' });
		await drawer.getByLabel('Offer this method at checkout').uncheck();
		await drawer.getByRole('button', { name: 'Save method' }).click();
		await expect(drawer).toBeHidden();
		await expect(item(page)).toContainText('Disabled');
		expect((await calculator(api)).enabled).toBe(false);

		const refused = await shopCheckout({ email: `${u}-d1@example.net`, shippingMethodCode: CODE }).catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(ApiFailure);

		// the seeded methods are untouched
		const ok = await shopCheckout({ email: `${u}-d2@example.net` });
		expect(ok.grandTotal).toBe(2500 + 500);
	});

	test('validation blocks an impossible rule; delete removes the method', async ({ page, api }) => {
		await openShipping(page);
		await item(page).getByRole('button', { name: 'Edit' }).click();
		const drawer = page.getByRole('dialog', { name: 'Edit shipping method' });
		await drawer.locator('#sm-min').fill('50.00');
		await drawer.locator('#sm-max').fill('10.00');
		await expect(drawer).toContainText('Minimum subtotal cannot be higher than the maximum.');
		await expect(drawer.getByRole('button', { name: 'Save method' })).toBeDisabled();
		await drawer.getByRole('button', { name: 'Cancel' }).click();

		await page.getByRole('button', { name: `Delete ${NAME}` }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Delete method' }).click();
		await expect(item(page)).toHaveCount(0);
		expect(await calculator(api).catch(() => undefined)).toBeUndefined();
	});
});
