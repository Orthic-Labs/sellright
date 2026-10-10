import { test, expect } from './fixtures';
import { PRODUCT } from './support/api';
import { addToCart } from './support/flows';

/**
 * A17 — slot mount points, rendered. Two modes, each skipped (= missing coverage, reported as such) unless its switch is set
 * for the BUILD and the runner:
 *
 *  E2E_SLOT_FIXTURES=1  the build was made with SELLRIGHT_BRAND_SLOTS_DIR=src/components/slots/__fixtures__/brand-slots, so the
 *                       base's own default slot files are replaced by compiled fixture slots (and pdp.guarantee-modal is absent
 *                       on purpose). Asserts: slot supplied, required props, a state-driven prop updating after resume, a handler
 *                       declared inside a slot running after resume, absent slot renders nothing and the page still works.
 *  E2E_SLOT_DEFAULTS=1  the ordinary base build (no override). Asserts the base's default slot files reproduce the markup that
 *                       used to be inlined (privacy processor line).
 *
 * Build: `SELLRIGHT_BRAND_SLOTS_DIR=src/components/slots/__fixtures__/brand-slots pnpm run e2e:build` for the fixtures mode.
 * Not covered here (listed in the A17 report): a QRL passed BY the platform into a slot (no mount passes one today: pdp.waitlist's
 * onJoin$ has no platform endpoint yet), and the account.* slots (need a signed-in shopper with orders).
 * NEVER RUN when this file was written.
 */
const FIXTURES = process.env.E2E_SLOT_FIXTURES === '1';
const DEFAULTS = process.env.E2E_SLOT_DEFAULTS === '1';

test.describe('compiled fixture slots', () => {
	test.skip(!FIXTURES, 'needs E2E_SLOT_FIXTURES=1 and a build with SELLRIGHT_BRAND_SLOTS_DIR set: did not run, missing coverage');

	test('payment.badges: supplied slot renders in the footer with its typed prop', async ({ page }) => {
		await page.goto('/terms/');
		const badge = page.getByTestId('slot-payment-badges');
		await expect(badge).toHaveText('fixture-badges');
		await expect(badge).toHaveAttribute('data-placement', 'footer');
		await expect(page.locator('footer').getByTestId('slot-payment-badges')).toHaveCount(1);
	});

	test('legal.copy: the required section prop reaches the slot and replaces the base fallback', async ({ page }) => {
		await page.goto('/privacy/');
		await expect(page.getByTestId('slot-legal-copy')).toHaveText('fixture-legal:privacy.payment-processors');
		await expect(page.locator('li', { hasText: 'Payment Processors:' })).toHaveText(/Payment Processors:\s*fixture-legal:privacy\.payment-processors$/);
	});

	test('pdp slots: price and data props reach supplied slots; the absent guarantee slot renders nothing', async ({ page }) => {
		await page.goto(`/products/${PRODUCT.shirt.slug}/`);
		await expect(page.getByTestId('slot-pdp-payment-widget')).toHaveAttribute('data-price', /^\d+$/);
		await expect(page.getByTestId('slot-pdp-waitlist')).toHaveAttribute('data-sold-out', 'false');
		await expect(page.getByTestId('slot-pdp-waitlist-name')).toContainText('fixture-waitlist:');
		await expect(page.getByTestId('slot-pdp-guarantee')).toHaveCount(0);
		// the rest of the page is intact
		await expect(page.getByRole('button', { name: /add to cart|select options/i }).first()).toBeVisible();
	});

	test('a handler declared inside a slot runs after resume', async ({ page }) => {
		await page.goto(`/products/${PRODUCT.shirt.slug}/`);
		const clicks = page.getByTestId('slot-pdp-waitlist-clicks');
		await expect(clicks).toHaveText('0');
		await page.getByTestId('slot-pdp-waitlist-button').click();
		await expect(clicks).toHaveText('1');
		await page.getByTestId('slot-pdp-waitlist-button').click();
		await expect(clicks).toHaveText('2');
	});

	test('cart.free-shipping-progress: supplied slot receives the live cart subtotal and line count', async ({ apiProxyPage: page }) => {
		await addToCart(page, PRODUCT.shirt.slug);
		const progress = page.getByTestId('slot-cart-progress');
		await expect(progress).toHaveText(new RegExp(`^fixture-cart:1:${PRODUCT.shirt.price}:[A-Z]{3}$`));
		await expect(progress).toHaveAttribute('data-checkout', 'false');
		// a second add of the same SKU re-renders the slot with the new subtotal (a navigation in between, so this proves
		// fresh props, not a post-resume signal update: that case is listed as uncovered in the A17 report)
		await addToCart(page, PRODUCT.shirt.slug);
		await expect(page.getByTestId('slot-cart-progress')).toHaveText(new RegExp(`^fixture-cart:1:${PRODUCT.shirt.price * 2}:[A-Z]{3}$`));
	});
});

test.describe('base default slot files', () => {
	test.skip(!DEFAULTS, 'needs E2E_SLOT_DEFAULTS=1 on the ordinary build: did not run, missing coverage');

	test('legal.copy default reproduces the processor line the privacy page used to hard-code', async ({ page }) => {
		await page.goto('/privacy/');
		await expect(page.locator('li', { hasText: 'Payment Processors:' })).toContainText('NMI, Sezzle, and other payment service providers');
	});

	test('no fixture slot leaks into the ordinary build', async ({ page }) => {
		await page.goto('/terms/');
		await expect(page.getByTestId('slot-payment-badges')).toHaveCount(0);
	});
});
