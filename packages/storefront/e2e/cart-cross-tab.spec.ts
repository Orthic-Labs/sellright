// #399: the header badge and the drawer follow cart changes made in another tab of the same browser (add, quantity,
// remove), the old store's LocalCartService storage sync. Two pages of one context share localStorage + cookies, so the
// `storage` event the cart writes is delivered to the other tab exactly as between two real tabs.
import { addToCart } from './support/flows';
import { expect, prepareShopperPage, skipExternal, test } from './fixtures';

const badge = (page: import('@playwright/test').Page) => page.locator('[aria-label$="items in cart"]').first();

test.describe('#399 cross-tab cart', () => {
	skipExternal();
	test('badge and drawer follow add, quantity and remove from another tab', async ({ apiProxyPage: a, context }) => {
		await addToCart(a, 'e2e-shirt'); // tab A's drawer stays open on its line list
		await expect(badge(a)).toHaveAttribute('aria-label', '1 items in cart');

		const b = await prepareShopperPage(await context.newPage());
		await addToCart(b, 'e2e-mug');
		// Tab A never reloads or opens its drawer: the storage signal alone must move its badge.
		await expect(badge(a)).toHaveAttribute('aria-label', '2 items in cart', { timeout: 5_000 });

		// Tab B raises the shirt to 3, then lowers it to 1: tab A follows both quantity changes.
		const shirtLine = b.locator('li', { hasText: 'E2E Shirt' }).first();
		const setQty = async (qty: number) => {
			await shirtLine.locator('[aria-haspopup="listbox"]').click();
			await shirtLine.getByRole('option', { name: String(qty), exact: true }).click();
		};
		await setQty(3);
		await expect(badge(b)).toHaveAttribute('aria-label', '4 items in cart');
		await expect(badge(a)).toHaveAttribute('aria-label', '4 items in cart', { timeout: 5_000 });
		await setQty(1);
		await expect(badge(a)).toHaveAttribute('aria-label', '2 items in cart', { timeout: 5_000 });

		// Tab B removes the mug.
		const mugLine = b.locator('li', { hasText: 'E2E Mug' }).first();
		await mugLine.getByRole('button', { name: /remove item/i }).click();
		await expect(badge(b)).toHaveAttribute('aria-label', '1 items in cart');
		await expect(badge(a)).toHaveAttribute('aria-label', '1 items in cart', { timeout: 5_000 });

		// Tab A's open drawer shows the synced cart and no "was removed" stock notice for a removal the shopper made.
		await expect(a.getByRole('button', { name: /remove item/i })).toHaveCount(1);
		await expect(a.getByText(/no longer available and was removed/i)).toHaveCount(0);
	});
});
