/** Shopper flows shared by the money-path specs. Each drives the real storefront UI exactly as a customer would. */
import { expect, type Page } from '@playwright/test';

/** Product page -> "Add to cart" (the cart drawer opens with the new line). */
export async function addToCart(page: Page, slug: string): Promise<void> {
	await page.goto(`/products/${slug}/`);
	await page.waitForLoadState('networkidle');
	const selectOptions = page.getByRole('button', { name: /select options/i });
	if (await selectOptions.isVisible().catch(() => false)) {
		// Single-variant products still route through a variant button before "ADD TO CART" appears.
		await page.locator('button:not([disabled])').filter({ hasText: '$' }).first().click();
	}
	await page.getByRole('button', { name: /^add to cart$/i }).click();
	await expect(page.getByRole('button', { name: /remove item/i }).first()).toBeVisible({ timeout: 10_000 });
}

/** Cart drawer -> /checkout. */
export async function goToCheckout(page: Page): Promise<void> {
	await page.getByRole('button', { name: /^checkout$/i }).click();
	await page.waitForURL('**/checkout/**');
	await page.waitForLoadState('networkidle');
	await expect(page.getByRole('heading', { name: /shipping details/i })).toBeVisible();
}

/**
 * `cardReady: false` for a spec whose payment controls never become usable (Collect.js / Stripe init failure): the details
 * are then proven by the payment controls (or their init error) mounting, since PLACE ORDER stays unavailable.
 */
export async function fillShipping(page: Page, email: string, who = { first: 'Ada', last: 'Lovelace' }, opts: { cardReady?: boolean } = {}): Promise<void> {
	const detailsValid = (timeout: number) => opts.cardReady === false
		? expect(paymentSection(page).locator('.nmi-card-form, [role="radiogroup"], [data-testid="payment-init-failed"]').first()).toBeVisible({ timeout })
		: expect(placeOrderButton(page)).toBeEnabled({ timeout });
	// The form hydrates (and the signed-in lookup resolves) a beat after it first paints, and a re-render in that window
	// clears typed values — so fill, then prove the values stuck and the form validates, retrying the whole fill otherwise.
	await expect(async () => {
		await page.getByLabel(/email address/i).fill(email);
		const phone = page.getByLabel(/phone number/i);
		if (await phone.isVisible().catch(() => false)) await phone.fill('512-555-0111');
		await page.getByLabel(/^first name$/i).first().fill(who.first);
		await page.getByLabel(/^last name$/i).first().fill(who.last);
		await page.getByLabel(/street address/i).first().fill('123 Main St');
		await page.getByLabel(/^city$/i).first().fill('Austin');
		await page.getByLabel(/state \/ province/i).first().fill('TX');
		await page.getByLabel(/postal code/i).first().fill('78701');
		await page.keyboard.press('Tab');
		await expect(page.getByLabel(/email address/i)).toHaveValue(email, { timeout: 1_500 });
		await expect(page.getByLabel(/^first name$/i).first()).toHaveValue(who.first, { timeout: 1_500 });
		await detailsValid(3_000);
		// Settle, then prove it again: a value typed before the form's handlers were loaded is only in the DOM and
		// disappears on the next render, which is exactly what a hurried script (not a person) can trigger.
		await page.waitForTimeout(600);
		await expect(page.getByLabel(/email address/i)).toHaveValue(email, { timeout: 1_500 });
		await expect(page.getByLabel(/^last name$/i).first()).toHaveValue(who.last, { timeout: 1_500 });
		await detailsValid(1_500);
	}).toPass({ timeout: 30_000 });
}

/**
 * The payment section: once the details are valid the checkout mounts the card controls inside #payment-method-section and
 * their button (PLACE ORDER, with the total once known) is the one a shopper presses. The page also carries an
 * aria-disabled desktop CTA (.checkout-cta-inline) and a sticky mobile CTA (.sticky-cta-bar) with the same PLACE ORDER
 * label, so an unscoped name match is a strict-mode violation (#403). The button label "Continue to payment" no longer exists.
 */
const paymentSection = (page: Page) => page.locator('#payment-method-section');
/** The CTAs outside the payment section (desktop inline + mobile sticky). They are aria-disabled until the details are valid. */
export const outerCtas = (page: Page) => page.locator('.checkout-cta-inline, .sticky-cta-bar').getByRole('button', { name: /^place order/i });

/**
 * The one PLACE ORDER that can be pressed now: the payment section's button when the card controls are mounted, otherwise
 * (nothing due, or details not yet valid) the outer CTA that is not aria-disabled. Never both: the page hides the outer
 * CTAs while the payment controls are mounted.
 */
export const placeOrderButton = (page: Page) =>
	paymentSection(page).getByRole('button', { name: /^place order/i })
		.or(outerCtas(page).and(page.locator(':not([aria-disabled="true"])')));

/** The payment section's pay button (labelled PLACE ORDER, optionally with the total); the old "PAY" label is gone. */
export const payButton = (page: Page) => paymentSection(page).getByRole('button', { name: /^(pay\b|place order)/i });

/** Click PLACE ORDER and capture what POST /v1/shop/checkout answered (the order code + receipt token the UI holds). */
export async function placeOrder(page: Page): Promise<{ code: string; receiptToken: string; grandTotal: number }> {
	const response = page.waitForResponse((r) => r.url().includes('/v1/shop/checkout') && r.request().method() === 'POST');
	await placeOrderButton(page).click();
	const res = await response;
	expect(res.status(), 'POST /v1/shop/checkout').toBe(200);
	return (await res.json()) as { code: string; receiptToken: string; grandTotal: number };
}

/**
 * Pay (NMI) and wait for the confirmation page to show the order. With the card controls mounted, PLACE ORDER in the payment
 * section creates the order AND submits the card in one click (#403), so the shopper is usually on the confirmation page
 * already; only an order placed from the outer CTA (card controls not yet mounted) still needs its own pay click.
 */
export async function payAndConfirm(page: Page, code: string): Promise<void> {
	const confirmation = new RegExp(`/checkout/confirmation/${code}`);
	const landed = await page.waitForURL(confirmation, { timeout: 10_000 }).then(() => true, () => false);
	if (!landed) await clickPay(page);
	await expect(page).toHaveURL(confirmation, { timeout: 20_000 });
	await expect(page.getByRole('heading', { name: /thank you/i })).toBeVisible({ timeout: 20_000 });
}

/** Add a promo code on the checkout page (the dark order-summary rows). */
export async function applyPromoAtCheckout(page: Page, code: string): Promise<void> {
	await page.getByRole('button', { name: /^add coupon or credit code$/i }).click();
	await page.getByPlaceholder(/enter promo code/i).fill(code);
	await page.getByRole('button', { name: /^apply$/i }).click();
	// Membership alone can include a rejected code. Only an applied code closes this input.
	await expect(page.getByRole('button', { name: `Remove ${code}`, exact: true })).toBeVisible();
	await expect(page.getByPlaceholder(/enter promo code/i)).toBeHidden();
}

/**
 * Click PAY. When the order total moved between the estimate the shopper saw and the server's price, the PAY step asks
 * for an explicit confirmation of the new total first (checkbox + message); a shopper ticks it, so this does too.
 */
export async function clickPay(page: Page): Promise<void> {
	await payButton(page).waitFor(); // the PAY step and any changed-total notice render in the same pass
	const consent = page.getByRole('checkbox', { name: /i confirm i will be charged/i });
	if (await consent.isVisible().catch(() => false)) await consent.check();
	await payButton(page).click();
}

/**
 * After PLACE ORDER with a declining card entered: the one-click path has already submitted it; an order placed from the outer
 * CTA (card controls not mounted yet) still needs the pay click. Waits for the decline message either way.
 */
export async function expectDeclined(page: Page): Promise<void> {
	const declined = page.getByText(/try a different card/i).first();
	if (!(await declined.waitFor({ timeout: 8_000 }).then(() => true, () => false))) await clickPay(page);
	await expect(declined).toBeVisible({ timeout: 15_000 });
}
