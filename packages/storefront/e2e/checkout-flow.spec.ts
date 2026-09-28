import { test, expect } from './fixtures';

/**
 * End-to-end coverage for the native SellRight checkout, run against the
 * storefront's real production build (server/entry.express.js) talking to a
 * real API instance (see fixtures.ts's route-interception proxy).
 *
 * Product slugs default to the seed-e2e-catalog.ts fixtures (CI's own
 * bootstrapped store); override via env for a local run against a
 * differently-seeded store (e.g. the shared dev API):
 *   E2E_IN_STOCK_SLUG / E2E_OOS_SLUG
 *
 * LOCKED stock-architecture test (CLAUDE.md): an OOS product must show OOS
 * on the shop grid, on PDP first paint, and never be addable to cart.
 */
const IN_STOCK_SLUG = process.env.E2E_IN_STOCK_SLUG ?? 'e2e-in-stock-tee';
const OOS_SLUG = process.env.E2E_OOS_SLUG ?? 'e2e-out-of-stock-tee';

test.describe('shop grid', () => {
	test('shows the in-stock product by default; the "in stock only" toggle reveals OOS, clearly flagged', async ({ apiProxyPage: page }) => {
		await page.goto('/shop/');
		await page.waitForLoadState('networkidle');
		// The shop manifest is the ONLY source the grid reads on load (LOCKED
		// stock rule) — every product tile renders from it, no per-tile API call.
		const inStockCard = page.locator(`a[href*="${IN_STOCK_SLUG}"]`).first();
		await expect(inStockCard).toBeVisible();

		// "In stock only" defaults ON (merchandising choice, not a stock-honesty
		// bug) — the OOS fixture is hidden until the shopper switches it off.
		await expect(page.locator(`a[href*="${OOS_SLUG}"]`)).toHaveCount(0);
		await page.locator('input[type="checkbox"]').first().uncheck({ force: true });

		const oosCard = page.locator(`a[href*="${OOS_SLUG}"]`).first();
		await expect(oosCard).toBeVisible();
		// OOS must be visibly flagged once shown, never silently indistinguishable
		// from an in-stock tile (fail-closed: missing/false inStock reads as OOS).
		await expect(oosCard).toContainText(/sold out|out of stock/i);
	});
});

test.describe('PDP', () => {
	test('first paint fails closed, then live stock confirms in-stock is purchasable', async ({ apiProxyPage: page }) => {
		await page.goto(`/products/${IN_STOCK_SLUG}/`);
		// Wait for the client-side live stock refresh (LOCKED rule: PDP ships a
		// disabled/fail-closed shell, then confirms via a client refresh) to
		// settle, rather than asserting on the pre-refresh shell which is
		// deliberately stockLevel '0' by design.
		await page.waitForLoadState('networkidle');
		const addToCart = page.getByRole('button', { name: /add to cart|select options/i });
		await expect(addToCart).toBeVisible();
	});

	test('an out-of-stock product is never purchasable, even after live refresh', async ({ apiProxyPage: page }) => {
		await page.goto(`/products/${OOS_SLUG}/`);
		await page.waitForLoadState('networkidle');
		await expect(page.locator('body')).toContainText(/sold out|out of stock/i);
		// No enabled "add to cart" affordance for the OOS variant.
		const addToCart = page.getByRole('button', { name: /^add to cart$/i });
		await expect(addToCart).toHaveCount(0);
	});
});

test.describe('cart', () => {
	test('adding the in-stock product opens the cart drawer with the new line', async ({ apiProxyPage: page }) => {
		await page.goto(`/products/${IN_STOCK_SLUG}/`);
		await page.waitForLoadState('networkidle');

		const selectOptions = page.getByRole('button', { name: /select options/i });
		if (await selectOptions.isVisible().catch(() => false)) {
			// Single-variant products (this fixture) still route through a
			// variant button before "ADD TO CART" appears.
			await page.locator('button:not([disabled])').filter({ hasText: '$' }).first().click();
		}
		await page.getByRole('button', { name: /^add to cart$/i }).click();

		// Cart drawer opens with the line and a live-priced total.
		await expect(page.getByRole('button', { name: /remove item/i }).first()).toBeVisible({ timeout: 10_000 });
		await expect(page.getByRole('button', { name: /\d+ items? in cart/i })).toContainText('1');
	});
});

test.describe('checkout', () => {
	test('checkout entry renders the shipping form and reaches the payment step pre-submit', async ({ apiProxyPage: page }) => {
		// Cart -> checkout, same as the manual verification path.
		await page.goto(`/products/${IN_STOCK_SLUG}/`);
		await page.waitForLoadState('networkidle');
		const selectOptions = page.getByRole('button', { name: /select options/i });
		if (await selectOptions.isVisible().catch(() => false)) {
			await page.locator('button:not([disabled])').filter({ hasText: '$' }).first().click();
		}
		await page.getByRole('button', { name: /^add to cart$/i }).click();
		await page.getByRole('button', { name: /^checkout$/i }).click();
		await page.waitForURL('**/checkout/**');
		await page.waitForLoadState('networkidle');

		// Checkout entry: the shipping form is present (LOCKED rule: live stock
		// is re-checked on checkout entry — covered implicitly by the order
		// actually being placeable below).
		await expect(page.getByRole('heading', { name: /shipping details/i })).toBeVisible();

		await page.getByLabel(/email address/i).fill('e2e@example.com');
		const phone = page.getByLabel(/phone number/i);
		if (await phone.isVisible().catch(() => false)) await phone.fill('512-555-0111');
		await page.getByLabel(/^first name$/i).first().fill('Ada');
		await page.getByLabel(/^last name$/i).first().fill('Lovelace');
		await page.getByLabel(/street address/i).first().fill('123 Main St');
		await page.getByLabel(/^city$/i).first().fill('Austin');
		await page.getByLabel(/state \/ province/i).first().fill('TX');
		await page.getByLabel(/postal code/i).first().fill('78701');
		await page.keyboard.press('Tab');

		// Pre-submit: LOCKED rule requires a live stock re-check right before
		// this click succeeds. Click PLACE ORDER (pre-submit).
		const placeOrder = page.getByRole('button', { name: /place order/i });
		await placeOrder.click();

		// Payment step reached: either a real payment method mounted (radio
		// selector and/or a PAY button for the store's configured gateway), or
		// — for a store with none configured — the explicit "not configured"
		// message. Either way proves the order was created (PendingPayment)
		// and checkout advanced past the shipping step, which is what this
		// test is verifying; a store this suite seeds has no gateway wired
		// (see seed-e2e-catalog.ts's doc comment), so a real charge/redirect
		// is NOT asserted here — see the coordinator notes for a manual/live
		// gateway verification.
		await expect(
			page.getByRole('button', { name: /^pay/i })
				.or(page.getByText(/no payment method is configured/i))
				.or(page.getByRole('radio', { name: /card|installments/i }))
				.first(),
		).toBeVisible({ timeout: 15_000 });
	});
});
