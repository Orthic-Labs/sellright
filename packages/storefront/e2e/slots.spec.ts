import { test, expect } from './fixtures';
import { PRODUCT } from './support/api';

/**
 * A17 — slot mount points, rendered, against the fixture build (SELLRIGHT_BRAND_SLOTS_DIR=src/components/slots/__fixtures__/brand-views,
 * which carries the slot fixtures below next to the view fixtures; E2E_BRAND_VIEWS=1). The base's own default slot files are replaced
 * by compiled fixture slots (pdp.guarantee-modal is absent on purpose). Asserts: slot supplied, required props, a handler declared
 * inside a slot running after resume, absent slot renders nothing and the page still works.
 *
 * Removed, with reasons (not skipped):
 *  - 'payment.badges' slot case: this build replaces the footer with the shell.footer view fixture, so the base footer (the slot's mount)
 *    does not render; the mount is asserted by mount-points.test.ts.
 *  - 'legal.copy' slot case: this build supplies a route.content view, which mounts on /privacy/ in place of the base page that hosts the slot,
 *    so the page cannot render here; the mount and its `section` prop are asserted by mount-points.test.ts and the default text by the SSR comparison.
 *  - 'cart.free-shipping-progress' slot case: the same slot is now a view (country and discounted amount props) covered by
 *    brand-views.spec.ts 'free-shipping view'.
 *  - 'base default slot files' (legal.copy default text, no fixture slot in the ordinary build): they need the ordinary build, which
 *    cannot be the same build as the fixtures. Covered by the main-vs-branch SSR comparison (scripts/ssr-normalize.mjs; /privacy/ and
 *    /terms/ are in the capture list), which proves the default pages render exactly what main renders.
 * Not covered here: a QRL passed BY the platform into a slot (no mount passes one today: pdp.waitlist's onJoin$ has no platform
 * endpoint yet), and the account.* slots (need a signed-in shopper with orders).
 */
const FIXTURES = process.env.E2E_BRAND_VIEWS === '1';

test.describe('compiled fixture slots', () => {
	test.skip(!FIXTURES, 'runs only against the fixture build (E2E_BRAND_VIEWS=1)');

	test('pdp slots: price and data props reach supplied slots; the absent guarantee slot renders nothing', async ({ apiProxyPage: page }) => {
		await page.goto(`/products/${PRODUCT.shirt.slug}/`);
		await expect(page.getByTestId('slot-pdp-payment-widget')).toHaveAttribute('data-price', /^\d+$/);
		await expect(page.getByTestId('slot-pdp-waitlist')).toHaveAttribute('data-sold-out', 'false');
		await expect(page.getByTestId('slot-pdp-waitlist-name')).toContainText('fixture-waitlist:');
		await expect(page.getByTestId('slot-pdp-guarantee')).toHaveCount(0);
		// the rest of the page is intact
		await expect(page.getByRole('button', { name: /add to cart|select options/i }).first()).toBeVisible();
	});

	test('a handler declared inside a slot runs after resume', async ({ apiProxyPage: page }) => {
		await page.goto(`/products/${PRODUCT.shirt.slug}/`);
		// the shell ships closed ('sold out') and the live stock read then settles the page: act on the settled slot, not the shell's
		await expect(page.getByTestId('slot-pdp-waitlist')).toHaveAttribute('data-sold-out', 'false');
		const clicks = page.getByTestId('slot-pdp-waitlist-clicks');
		await expect(clicks).toHaveText('0');
		await page.getByTestId('slot-pdp-waitlist-button').click();
		await expect(clicks).toHaveText('1');
		await page.getByTestId('slot-pdp-waitlist-button').click();
		await expect(clicks).toHaveText('2');
	});
});

/**
 * Brand views (PR1) are covered by e2e/brand-views.spec.ts (fixture build with SELLRIGHT_BRAND_SLOTS_DIR=…/__fixtures__/brand-views):
 * views resume, the cart toggle opens the drawer with one live refresh, login/logout reach the platform, forms validate. The default
 * (no view) fallback proof is e2e/ssr-fallback-capture.spec.ts with scripts/ssr-normalize.mjs.
 */
