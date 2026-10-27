// #401: drawer focus management, a real header cart button, a human add-to-cart failure, phone and coupon input checks.
import { addToCart, goToCheckout } from './support/flows';
import { expect, skipExternal, test } from './fixtures';

const dialog = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: 'Shopping cart' });

test.describe('#401 polish', () => {
	skipExternal();

	test('drawer: focus moves in on open, Tab stays inside, Escape closes, focus returns to ADD TO CART', async ({ apiProxyPage: page }) => {
		await addToCart(page, 'e2e-shirt');
		await expect(dialog(page)).toBeVisible();
		await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
		for (let i = 0; i < 25; i++) {
			await page.keyboard.press(i % 5 === 4 ? 'Shift+Tab' : 'Tab');
			expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
		}
		// Escape closes from anywhere, and focus goes back to the control that opened the drawer.
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		await page.keyboard.press('Escape');
		await expect(dialog(page)).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim().toLowerCase() ?? '')).toContain('add to cart');
	});

	test('header cart control is a button that opens the drawer from the keyboard', async ({ apiProxyPage: page }) => {
		await page.goto('/products/e2e-mug/');
		const cart = page.locator('header button[aria-label$="items in cart"]');
		await expect(cart).toHaveCount(1);
		await cart.focus();
		await page.keyboard.press('Enter');
		await expect(dialog(page)).toBeVisible();
	});

	test('add-to-cart server failure shows a human message announced as an alert', async ({ apiProxyPage: page }) => {
		await page.goto('/products/e2e-book/');
		await page.waitForLoadState('networkidle');
		await page.route((url) => url.pathname.startsWith('/v1/shop/cart'), async (route) => {
			if (route.request().method() === 'GET') return route.fallback();
			await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }) });
		});
		await page.getByRole('button', { name: /^add to cart$/i }).click();
		const alert = page.getByRole('alert').filter({ hasText: "Couldn't add to cart" });
		await expect(alert).toBeVisible();
		await expect(page.getByText(/Request failed with status/i)).toHaveCount(0);
	});

	test('checkout: letters in the phone are refused with a message; coupon length capped; an unknown code is rejected and not kept', async ({ apiProxyPage: page }) => {
		await addToCart(page, 'e2e-mug');
		await goToCheckout(page);
		const phone = page.locator('#checkout-phone');
		await phone.pressSequentially('abc');
		await expect(page.locator('#checkout-phone-error')).toContainText('Use digits only');
		await expect(phone).toHaveAttribute('aria-invalid', 'true');
		await expect(phone).toHaveValue('');

		await page.getByRole('button', { name: /^add coupon or credit code$/i }).click();
		const input = page.getByPlaceholder(/enter promo code/i);
		await expect(input).toHaveAttribute('maxlength', '64');
		await input.fill('NO-SUCH-CODE-401');
		await page.getByRole('button', { name: /^apply$/i }).click();
		await expect(page.getByText("That code isn't valid.")).toBeVisible();
		await expect(page.getByText('Not applied')).toHaveCount(0);
		await expect(page.getByText('NO-SUCH-CODE-401', { exact: true })).toHaveCount(0);
	});
});
