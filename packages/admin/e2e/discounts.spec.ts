import { test, expect, row, toast } from './fixtures';
import { ApiFailure, shopCheckout, uniq, SKU } from './support/api';

type Pg = import('@playwright/test').Page;
/** The list opens on the Active tab; every row lookup goes via All + a code search so status never hides it. */
async function listAll(page: Pg, code?: string) {
	await page.goto('/discounts');
	await page.getByRole('tab', { name: /^All/ }).click();
	if (code) await page.getByLabel('Search discounts by code').fill(code);
	else await page.locator('#d-sort').selectOption('code'); // automatic discounts (no code) sort first
}
const actions = (r: import('@playwright/test').Locator) => r.getByRole('button', { name: /^Actions for / });
const radio = (page: Pg, group: string, name: string) => page.getByRole('radiogroup', { name: group }).getByRole('radio', { name });
const save = async (page: Pg, label: 'Create discount' | 'Save changes') => {
	await page.getByRole('button', { name: label }).click();
	await expect(page).toHaveURL(/\/discounts$/);
};

/**
 * Plan 1.3 #14 — Discounts: create a code discount and an automatic one through the UI, edit an existing
 * one, and prove the server enforces usage limits / automatic application at the real checkout route.
 * Supersedes: Discounts.test.ts (form <-> payload mapping), money/coupon enforcement route paths in checkout.route.test.ts.
 */
test.describe('discounts', () => {
	// Everything unique is derived INSIDE each test (not at describe scope), so a retry or --repeat-each in the same
	// worker never collides with the rows an earlier attempt left behind.

	// Automatic discounts apply to EVERY checkout without a code, so leftovers from an earlier run against a
	// reused database would skew totals: switch any off first (a fresh database has none).
	test.beforeAll(async ({ api }) => {
		const { items } = await api.get<{ items: { id: string; code: string | null; enabled: boolean }[] }>('/discounts');
		for (const d of items) {
			if (d.code !== null) continue;
			const del = await api.raw('DELETE', `/discounts/${d.id}`); // unused ones can go
			if (!del.ok && d.enabled) await api.patch(`/discounts/${d.id}`, { enabled: false });
		}
	});

	test('create a code discount with a usage limit; checkout enforces the limit; edit raises it', async ({ page }) => {
		const u = uniq('dc');
		const CODE = `E2E${u}`.toUpperCase();
		await page.goto('/discounts');
		await page.getByRole('button', { name: 'New discount' }).click();
		await expect(page).toHaveURL(/\/discounts\/new$/);
		await page.getByLabel('Code', { exact: true }).fill(CODE);
		await radio(page, 'Discount type', 'Percentage').click();
		await page.getByLabel('Discount value').fill('10');
		await page.getByLabel('Total uses').fill('1');
		await save(page, 'Create discount');

		await listAll(page, CODE);
		const r = row(page, CODE);
		await expect(r).toContainText('10%');
		await expect(r).toContainText('0 / 1');
		await expect(r).toContainText('Active');

		// storefront checkout #1 consumes the single use: 10% of $25.00 merchandise, shipping untouched
		const first = await shopCheckout({ email: `${u}-1@example.net`, couponCode: CODE });
		expect(first.couponApplied).toBe(true);
		expect(first.discountTotal).toBe(250);
		expect(first.grandTotal).toBe(2500 - 250 + 500);

		// checkout #2: limit reached -> the server prices at full value, never trusts the coupon
		const second = await shopCheckout({ email: `${u}-2@example.net`, couponCode: CODE });
		expect(second.couponApplied).toBe(false);
		expect(second.discountTotal).toBe(0);
		expect(second.grandTotal).toBe(3000);

		await listAll(page, CODE);
		await expect(row(page, CODE)).toContainText('1 / 1');

		// edit: raise the limit to 5 and the value to 15%
		await row(page, CODE).getByRole('button', { name: CODE, exact: true }).click();
		await expect(page).toHaveURL(/\/discounts\/[^/]+$/);
		await expect(page.getByLabel('Total uses')).toHaveValue('1');
		await page.getByLabel('Discount value').fill('15');
		await page.getByLabel('Total uses').fill('5');
		await save(page, 'Save changes');
		await listAll(page, CODE);
		await expect(row(page, CODE)).toContainText('15%');
		await expect(row(page, CODE)).toContainText('1 / 5');

		const third = await shopCheckout({ email: `${u}-3@example.net`, couponCode: CODE });
		expect(third.couponApplied).toBe(true);
		expect(third.discountTotal).toBe(Math.round(2500 * 0.15));

		// disabling through the edit form keeps every other field and stops the code applying
		await row(page, CODE).getByRole('button', { name: CODE, exact: true }).click();
		await radio(page, 'Discount status', 'Disabled').click();
		await save(page, 'Save changes');
		await listAll(page, CODE);
		await expect(row(page, CODE)).toContainText('Disabled');
		await expect(row(page, CODE)).toContainText('15%');
		const fourth = await shopCheckout({ email: `${u}-4@example.net`, couponCode: CODE });
		expect(fourth.couponApplied).toBe(false);
	});

	test('automatic discount (no code) applies to checkout without a coupon, until disabled', async ({ page }) => {
		const u = uniq('da');
		// an amount no earlier attempt used keeps this discount's table row unique on a reused database
		const AUTO_CENTS = 510 + (Date.now() % 1390);
		const AUTO = (AUTO_CENTS / 100).toFixed(2);
		await page.goto('/discounts/new');
		await radio(page, 'Discount type', 'Fixed amount').click();
		await page.getByLabel('Discount value').fill(AUTO);
		await page.getByLabel('Minimum order amount').fill('20.00');
		await save(page, 'Create discount');

		await listAll(page);
		const auto = page.getByRole('row').filter({ hasText: 'automatic' }).filter({ hasText: `$${AUTO}` });
		await expect(auto).toHaveCount(1);
		await expect(auto).toContainText('Active');

		// meets the $20 minimum -> a per-run amount off, no code needed
		const hit = await shopCheckout({ email: `${u}-a1@example.net` });
		expect(hit.discountTotal).toBe(AUTO_CENTS);
		expect(hit.couponApplied).toBe(true);
		// below the minimum -> no discount
		const miss = await shopCheckout({ email: `${u}-a2@example.net`, items: [{ sku: SKU.mug, quantity: 1 }] });
		expect(miss.discountTotal).toBe(0);

		await auto.getByRole('button', { name: 'automatic', exact: true }).click();
		await expect(page.getByLabel('Discount value')).toHaveValue(AUTO);
		await radio(page, 'Discount status', 'Disabled').click();
		await save(page, 'Save changes');
		await listAll(page);
		const disabled = page.getByRole('row').filter({ hasText: 'automatic' }).filter({ hasText: `$${AUTO}` });
		await expect(disabled).toContainText('Disabled');
		const off = await shopCheckout({ email: `${u}-a3@example.net` });
		expect(off.discountTotal).toBe(0);

		// a redeemed discount keeps its history: no delete action, activate/deactivate only
		await actions(disabled).click();
		await expect(page.getByRole('menuitem', { name: 'Activate' })).toBeVisible();
		await expect(page.getByRole('menuitem', { name: /^Delete/ })).toHaveCount(0);
	});

	test('an unused discount can be deleted; a redeemed one cannot', async ({ page, api }) => {
		const unused = `E2E${uniq('del')}`.toUpperCase();
		const used = `E2E${uniq('use')}`.toUpperCase();
		await api.post('/discounts', { code: unused, type: 'fixed', value: 100 });
		await api.post('/discounts', { code: used, type: 'fixed', value: 100 });
		await shopCheckout({ email: `${uniq('dl')}@example.net`, couponCode: used }); // redeems it once
		await listAll(page, 'E2E');
		await expect(row(page, used)).toContainText('1');
		await actions(row(page, used)).click();
		await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
		await expect(page.getByRole('menuitem', { name: /^Delete/ })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await actions(row(page, unused)).click();
		await page.getByRole('menuitem', { name: /^Delete/ }).click();
		await page.getByRole('dialog').getByRole('button', { name: 'Delete discount' }).click();
		await expect(toast(page, 'Discount deleted')).toBeVisible();
		await expect(row(page, unused)).toHaveCount(0);
		expect((await api.raw('DELETE', `/discounts/${(await api.get<{ items: { id: string; code: string }[] }>('/discounts')).items.find((d) => d.code === used)!.id}`)).status).toBe(409);
	});

	test('unknown coupons and sold-out items fail closed at checkout', async () => {
		const u = uniq('dx');
		const res = await shopCheckout({ email: `${u}-x@example.net`, couponCode: 'NO-SUCH-CODE' });
		expect(res.couponApplied).toBe(false);
		expect(res.discountTotal).toBe(0);
		await expect(shopCheckout({ email: `${u}-y@example.net`, items: [{ sku: SKU.oos, quantity: 1 }] })).rejects.toBeInstanceOf(ApiFailure);
	});
});

test.describe('discounts: status toggle', () => {
	// Regression: PATCH /v1/admin/discounts/{id} used to re-apply the create schema's defaults (Zod 4 keeps .default()
	// through .partial()), so a bare { enabled } also zeroed the discount value. The list's Deactivate / Activate
	// actions send exactly that bare patch.
	test('deactivating and re-activating must not change the discount value', async ({ page, api }) => {
		const code = `E2E${uniq('tg')}`.toUpperCase();
		await api.post('/discounts', { code, type: 'percentage', value: 15 });
		await listAll(page, code);
		await actions(row(page, code)).click();
		await page.getByRole('menuitem', { name: /^Deactivate/ }).click();
		await page.getByRole('dialog').getByRole('button', { name: 'Deactivate', exact: true }).click();
		await expect(row(page, code)).toContainText('Disabled');
		await expect(row(page, code)).toContainText('15%', { timeout: 3_000 });
		expect(await api.get<{ value: number; enabled: boolean }>(`/discounts/${(await api.get<{ items: { id: string; code: string }[] }>('/discounts')).items.find((d) => d.code === code)!.id}`)).toMatchObject({ value: 15, enabled: false });

		await actions(row(page, code)).click();
		await page.getByRole('menuitem', { name: 'Activate' }).click();
		await expect(row(page, code)).toContainText('Active');
		await expect(row(page, code)).toContainText('15%', { timeout: 3_000 });
	});
});

test.describe('discounts: edit form freshness', () => {
	// Regression: the editor reads GET /discounts/{id} through react-query (global staleTime 15s) and saving only
	// invalidated the *list* query, so re-opening Edit right after a save showed the pre-save values.
	test('re-opening Edit right after a save shows the saved values', async ({ page, api }) => {
		const code = `E2E${uniq('fr')}`.toUpperCase();
		await api.post('/discounts', { code, type: 'percentage', value: 10 });
		await listAll(page, code);
		await row(page, code).getByRole('button', { name: code, exact: true }).click();
		await page.getByLabel('Discount value').fill('20');
		await save(page, 'Save changes');
		await page.getByLabel('Search discounts by code').fill(code);
		await page.getByRole('tab', { name: /^All/ }).click();
		await expect(row(page, code)).toContainText('20%');
		await row(page, code).getByRole('button', { name: code, exact: true }).click();
		await expect(page.getByLabel('Discount value')).toHaveValue('20', { timeout: 3_000 });
	});
});
