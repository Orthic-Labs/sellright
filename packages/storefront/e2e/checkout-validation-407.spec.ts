// #407: checkout field validation. Real names and addresses pass, errors are visible text tied to their field, the
// fields autofill (real <form>, name + autocomplete), change-only autofill unlocks payment, and phone/state/postcode
// are required only where they apply. CHECKOUT_SHOTS=<dir> also saves the error-state screenshots for review.
import type { Page } from '@playwright/test';
import { addToCart, goToCheckout, placeOrderButton } from './support/flows';
import { expect, skipExternal, test } from './fixtures';

const SHOTS = process.env.CHECKOUT_SHOTS;

async function toCheckout(page: Page): Promise<void> {
	await addToCart(page, 'e2e-mug');
	await goToCheckout(page);
	await page.waitForTimeout(600); // the form hydrates a beat after first paint (see fillShipping)
}

/** Type like a person: fill, then leave the field. */
async function type(page: Page, selector: string, value: string): Promise<void> {
	await page.locator(selector).fill(value);
	await page.locator(selector).blur();
}

/** Autofill that fires only `change` (older Safari): set the value with no input event and no focus. */
async function autofillChangeOnly(page: Page, values: Record<string, string>): Promise<void> {
	await page.evaluate((v) => {
		for (const [selector, value] of Object.entries(v)) {
			const el = document.querySelector(selector) as HTMLInputElement | HTMLSelectElement;
			const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
			setter.call(el, value);
			el.dispatchEvent(new Event('change', { bubbles: true }));
		}
	}, values);
}

async function chooseCountry(page: Page, code: string): Promise<void> {
	await page.locator('#countryCode').selectOption(code);
	await page.waitForTimeout(800); // the country select is debounced 500 ms
}

test.describe('#407 checkout validation', () => {
	skipExternal();

	test('fields sit in a real form with name and autocomplete tokens', async ({ apiProxyPage: page }) => {
		await toCheckout(page);
		const form = page.locator('form#checkout-address-form');
		await expect(form).toHaveCount(1);
		const expected: Record<string, string> = {
			'#checkout-email': 'email', '#checkout-phone': 'shipping tel',
			'#checkout-first-name': 'shipping given-name', '#checkout-last-name': 'shipping family-name',
			'#streetLine1': 'shipping address-line1', '#streetLine2': 'shipping address-line2', '#city': 'shipping address-level2',
			'#province': 'shipping address-level1', '#postalCode': 'shipping postal-code', '#countryCode': 'shipping country',
			'#billingFirstName': 'billing given-name', '#billingPostalCode': 'billing postal-code', '#billingCountryCode': 'billing country',
		};
		for (const [selector, token] of Object.entries(expected)) {
			const field = form.locator(selector);
			await expect(field, selector).toHaveAttribute('autocomplete', token);
			await expect(field, selector).toHaveAttribute('name', /\S/);
		}
		// Enter in a field never submits (reloads) the page.
		await page.locator('#checkout-email').press('Enter');
		await expect(page).toHaveURL(/\/checkout\//);
	});

	test('accented names, # and / in the street, and a US address with no phone unlock payment', async ({ apiProxyPage: page }) => {
		await toCheckout(page);
		await expect(async () => {
			await type(page, '#checkout-email', 'jose@example.org');
			await type(page, '#checkout-first-name', 'José');
			await type(page, '#checkout-last-name', "Zoë O'Neil-Müller");
			await type(page, '#streetLine1', '123 Main St #4');
			await type(page, '#streetLine2', 'Unit 12 1/2');
			await type(page, '#city', 'Austin');
			await type(page, '#province', 'TX');
			await type(page, '#postalCode', '78701');
			await expect(placeOrderButton(page)).toBeEnabled({ timeout: 3_000 });
		}).toPass({ timeout: 30_000 });
		await expect(page.locator('[id$="-error"][role="alert"]')).toHaveCount(0);
	});

	test('a GB address needs no county or phone; HK needs no postcode', async ({ apiProxyPage: page }) => {
		await toCheckout(page);
		await chooseCountry(page, 'GB');
		await expect(page.locator('#province')).toHaveAttribute('placeholder', /optional/i);
		await expect(page.locator('#postalCode')).toHaveAttribute('inputmode', 'text');
		await expect(async () => {
			await type(page, '#checkout-email', 'zoe@example.org');
			await type(page, '#checkout-first-name', 'Zoë');
			await type(page, '#checkout-last-name', 'Brontë');
			await type(page, '#streetLine1', 'Flat 3, 10 Downing St');
			await type(page, '#city', 'London');
			await type(page, '#postalCode', 'SW1A 2AA');
			await expect(placeOrderButton(page)).toBeEnabled({ timeout: 3_000 });
		}).toPass({ timeout: 30_000 });

		await chooseCountry(page, 'HK');
		await expect(page.locator('#postalCode')).toHaveAttribute('placeholder', /optional/i);
		await type(page, '#postalCode', '');
		await type(page, '#city', 'Central');
		await expect(placeOrderButton(page)).toBeEnabled({ timeout: 5_000 });
	});

	test('change-only autofill (no input event, no blur) unlocks payment', async ({ apiProxyPage: page }) => {
		await toCheckout(page);
		await expect(async () => {
			await autofillChangeOnly(page, {
				'#checkout-email': 'autofill@example.org', '#checkout-first-name': 'Søren', '#checkout-last-name': 'Kierkegaard',
				'#streetLine1': '742 Evergreen Terrace', '#city': 'Springfield', '#province': 'OR', '#postalCode': '97477',
			});
			await expect(placeOrderButton(page)).toBeEnabled({ timeout: 3_000 });
		}).toPass({ timeout: 30_000 });
		await expect(page.locator('[id$="-error"][role="alert"]')).toHaveCount(0);
	});

	test('no error flashes while typing into an untouched field', async ({ apiProxyPage: page }) => {
		await toCheckout(page);
		await page.locator('#postalCode').pressSequentially('78', { delay: 30 });
		await expect(page.locator('#postalCode-error')).toHaveCount(0);
		await page.locator('#postalCode').blur();
		await expect(page.locator('#postalCode-error')).toBeVisible();
	});

	for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'm375', width: 375, height: 812 }]) {
		test(`errors are visible text under each field and tied to it (${viewport.name})`, async ({ apiProxyPage: page }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await toCheckout(page);
			const bad: Array<[string, string, RegExp]> = [
				['#checkout-email', 'not-an-email', /valid email/i],
				['#checkout-first-name', 'R2D2', /letters, spaces/i],
				['#checkout-phone', '12', /too short/i],
				['#streetLine1', '###', /valid street address/i],
				['#province', 'Narnia', /valid US state/i],
				['#postalCode', '1234', /valid ZIP code/i],
			];
			await expect(async () => {
				for (const [selector, value] of bad) await type(page, selector, value);
				await type(page, '#checkout-last-name', '');
				await type(page, '#city', '');
				for (const [selector, , message] of bad) {
					const id = (await page.locator(selector).getAttribute('id'))!;
					const errorId = id === 'checkout-first-name' ? 'checkout-firstName-error' : `${id}-error`;
					await expect(page.locator(selector)).toHaveAttribute('aria-invalid', 'true', { timeout: 1_500 });
					await expect(page.locator(selector)).toHaveAttribute('aria-describedby', errorId);
					const error = page.locator(`#${errorId}`);
					await expect(error).toBeVisible();
					await expect(error).toHaveAttribute('role', 'alert');
					await expect(error).toHaveText(message);
				}
				await expect(page.locator('#checkout-lastName-error')).toHaveText('Last name is required');
				await expect(page.locator('#city-error')).toHaveText('City is required');
			}).toPass({ timeout: 30_000 });
			// Payment stays locked.
			await expect(page.getByText(/enter your email and shipping address to unlock payment/i)).toBeVisible();
			if (SHOTS) {
				// The form itself: a full-page capture stitches the sticky header and mobile PLACE ORDER bar over the fields.
				await page.addStyleTag({ content: 'header, [class*="sticky"], [class*="fixed"] { visibility: hidden !important; }' });
				await page.locator('form#checkout-address-form').screenshot({ path: `${SHOTS}/checkout-errors-${viewport.name}.png` });
			}
		});
	}
});
