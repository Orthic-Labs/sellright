import { test, expect, row, field } from './fixtures';
import { ApiFailure, shopCheckout, uniq, SKU } from './support/api';

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
		const modal = page.getByRole('dialog', { name: 'New discount' });
		await field(modal, 'Code').fill(CODE);
		await field(modal, 'Type').selectOption('percentage');
		await field(modal, 'Percent').fill('10');
		await field(modal, 'Total usage limit').fill('1');
		await modal.getByRole('button', { name: 'Create' }).click();
		await expect(modal).toBeHidden();

		const r = row(page, CODE);
		await expect(r).toContainText('10%');
		await expect(r).toContainText('0 / 1');
		await expect(r).toContainText('active');

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

		await page.reload();
		await expect(row(page, CODE)).toContainText('1 / 1');

		// edit: raise the limit to 5 and the value to 15%
		await page.getByRole('button', { name: `Edit discount ${CODE}` }).click();
		const edit = page.getByRole('dialog', { name: new RegExp(`Edit discount — ${CODE}`) });
		await expect(field(edit, 'Total usage limit')).toHaveValue('1');
		await field(edit, 'Percent').fill('15');
		await field(edit, 'Total usage limit').fill('5');
		await edit.getByRole('button', { name: 'Save changes' }).click();
		await expect(edit).toBeHidden();
		await expect(row(page, CODE)).toContainText('15%');
		await expect(row(page, CODE)).toContainText('1 / 5');

		const third = await shopCheckout({ email: `${u}-3@example.net`, couponCode: CODE });
		expect(third.couponApplied).toBe(true);
		expect(third.discountTotal).toBe(Math.round(2500 * 0.15));

		// disabling through the edit form keeps every other field and stops the code applying
		// (reload first: see the stale-edit-form test below for why the cached detail cannot be reused)
		await page.reload();
		await page.getByRole('button', { name: `Edit discount ${CODE}` }).click();
		const off = page.getByRole('dialog', { name: new RegExp(`Edit discount — ${CODE}`) });
		await off.getByLabel('Enabled').uncheck();
		await off.getByRole('button', { name: 'Save changes' }).click();
		await expect(off).toBeHidden();
		await expect(row(page, CODE)).toContainText('draft');
		await expect(row(page, CODE)).toContainText('15%');
		const fourth = await shopCheckout({ email: `${u}-4@example.net`, couponCode: CODE });
		expect(fourth.couponApplied).toBe(false);
	});

	test('automatic discount (no code) applies to checkout without a coupon, until disabled', async ({ page }) => {
		const u = uniq('da');
		// an amount no earlier attempt used keeps this discount's table row unique on a reused database
		const AUTO_CENTS = 510 + (Date.now() % 1390);
		const AUTO = (AUTO_CENTS / 100).toFixed(2);
		await page.goto('/discounts');
		await page.getByRole('button', { name: 'New discount' }).click();
		const modal = page.getByRole('dialog', { name: 'New discount' });
		await field(modal, 'Type').selectOption('fixed');
		await field(modal, 'Amount (USD)').fill(AUTO);
		await field(modal, 'Minimum order amount (USD)').fill('20.00');
		await modal.getByRole('button', { name: 'Create' }).click();
		await expect(modal).toBeHidden();

		const auto = page.getByRole('row').filter({ hasText: 'automatic' }).filter({ hasText: `$${AUTO}` });
		await expect(auto).toHaveCount(1);

		// meets the $20 minimum -> a per-run amount off, no code needed
		const hit = await shopCheckout({ email: `${u}-a1@example.net` });
		expect(hit.discountTotal).toBe(AUTO_CENTS);
		expect(hit.couponApplied).toBe(true);
		// below the minimum -> no discount
		const miss = await shopCheckout({ email: `${u}-a2@example.net`, items: [{ sku: SKU.mug, quantity: 1 }] });
		expect(miss.discountTotal).toBe(0);

		await auto.getByRole('button', { name: /Edit discount/ }).click();
		const edit = page.getByRole('dialog', { name: /Edit discount/ });
		await expect(field(edit, 'Amount (USD)')).toHaveValue(AUTO);
		await edit.getByLabel('Enabled').uncheck();
		await edit.getByRole('button', { name: 'Save changes' }).click();
		await expect(edit).toBeHidden();
		const disabled = page.getByRole('row').filter({ hasText: 'automatic' }).filter({ hasText: `$${AUTO}` });
		await expect(disabled).toContainText('draft');
		const off = await shopCheckout({ email: `${u}-a3@example.net` });
		expect(off.discountTotal).toBe(0);

		// a redeemed discount keeps its history: no delete action, disable only
		await expect(disabled.getByRole('button', { name: /Delete discount/ })).toHaveCount(0);
	});

	test('an unused discount can be deleted; a redeemed one cannot', async ({ page, api }) => {
		const unused = `E2E${uniq('del')}`.toUpperCase();
		const used = `E2E${uniq('use')}`.toUpperCase();
		await api.post('/discounts', { code: unused, type: 'fixed', value: 100 });
		await api.post('/discounts', { code: used, type: 'fixed', value: 100 });
		await shopCheckout({ email: `${uniq('dl')}@example.net`, couponCode: used }); // redeems it once
		await page.goto('/discounts');
		await expect(row(page, used)).toContainText('1');
		await expect(row(page, used).getByRole('button', { name: /Delete discount/ })).toHaveCount(0);
		await row(page, unused).getByRole('button', { name: `Delete discount ${unused}` }).click();
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

test.describe('discounts: status badge toggle', () => {
	// KNOWN PRODUCT BUG (found by this suite, API side): PATCH /v1/admin/discounts/{id} validates the body with
	// promoBodyBase.partial(); under Zod 4 the schema's .default() values survive .partial(), so a bare
	// { enabled: false } also writes value = 0 and freeShipping = false, and a bare { value } re-enables a
	// disabled discount. The admin's status badge sends exactly { enabled } — clicking it zeroes the discount.
	// test.fail() keeps the suite green while the bug exists and turns red ("unexpected pass") once it is fixed,
	// at which point this annotation should be deleted.
	test('toggling the status badge must not change the discount value', async ({ page, api }) => {
		test.fail(true, 'api: PATCH /discounts/{id} partial body re-applies schema defaults (value -> 0)');
		const code = `E2E${uniq('tg')}`.toUpperCase();
		await api.post('/discounts', { code, type: 'percentage', value: 15 });
		await page.goto('/discounts');
		await row(page, code).getByRole('button', { name: /active/i }).click();
		await expect(row(page, code)).toContainText('draft');
		await expect(row(page, code)).toContainText('15%', { timeout: 3_000 });
	});
});

test.describe('discounts: edit form freshness', () => {
	// KNOWN PRODUCT BUG (found by this suite, admin side): the edit modal reads GET /discounts/{id} through
	// react-query (global staleTime 15s) and saving only invalidates the *list* query, so re-opening Edit
	// within 15s of a save shows the pre-save values — and saving again silently reverts the earlier edit.
	test('re-opening Edit right after a save shows the saved values', async ({ page, api }) => {
		test.fail(true, 'admin: Discounts.tsx does not invalidate the [discount, id] detail query after save');
		const code = `E2E${uniq('fr')}`.toUpperCase();
		await api.post('/discounts', { code, type: 'percentage', value: 10 });
		await page.goto('/discounts');
		await page.getByRole('button', { name: `Edit discount ${code}` }).click();
		let dlg = page.getByRole('dialog', { name: new RegExp(`Edit discount — ${code}`) });
		await field(dlg, 'Percent').fill('20');
		await dlg.getByRole('button', { name: 'Save changes' }).click();
		await expect(row(page, code)).toContainText('20%');
		await page.getByRole('button', { name: `Edit discount ${code}` }).click();
		dlg = page.getByRole('dialog', { name: new RegExp(`Edit discount — ${code}`) });
		await expect(field(dlg, 'Percent')).toHaveValue('20', { timeout: 3_000 });
	});
});
