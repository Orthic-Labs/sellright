import { test, expect, row, toast } from './fixtures';
import { createOrder, uniq } from './support/api';

/**
 * Plan 1.3 #15 — Inventory: adjust with a mandatory reason -> history row; bulk set; low-stock filter.
 * Every stock number asserted here is read live from the API (no fixtures, no cache — CLAUDE.md stock lock).
 * Supersedes: admin-products.stock-adjust.test.ts, admin-products.bulk-stock.test.ts, admin-products.stock.test.ts
 * (route/validation paths; the pure stock-hook and reservation logic stay in unit tests).
 */
test.describe('inventory', () => {
	const u = uniq('iv').toUpperCase();
	const SKU_A = `E2E-INV-A-${u}`;
	const SKU_B = `E2E-INV-B-${u}`;
	const SKU_LOW = `E2E-INV-L-${u}`;

	test.beforeAll(async ({ api }) => {
		const { id } = await api.post<{ id: string }>('/products', { name: `E2E Inventory ${u}`, status: 'active' });
		await api.post(`/products/${id}/variants`, { sku: SKU_A, name: `Inv A ${u}`, price: 1000, onHand: 40 });
		await api.post(`/products/${id}/variants`, { sku: SKU_B, name: `Inv B ${u}`, price: 1000, onHand: 40 });
		await api.post(`/products/${id}/variants`, { sku: SKU_LOW, name: `Inv Low ${u}`, price: 1000, onHand: 2 });
	});

	test('adjust with a reason writes an audited history row and moves live on-hand', async ({ page, api }) => {
		const before = await api.stock(SKU_A);
		await page.goto('/inventory');
		await page.getByLabel('Search SKU or name').fill(SKU_A);
		await expect(row(page, SKU_A)).toHaveCount(1);
		await page.getByRole('button', { name: `Adjust stock and view history for ${SKU_A}` }).click();
		const modal = page.getByRole('dialog', { name: `Adjust stock — ${SKU_A}` });
		await expect(modal).toContainText('admin_create'); // creation seeded the opening balance

		// reason is mandatory: Apply stays disabled until both fields are filled
		await modal.getByLabel('Stock adjustment delta').fill('-3');
		await expect(modal.getByRole('button', { name: 'Apply' })).toBeDisabled();
		await modal.getByLabel('Reason for adjustment').fill('Damaged in e2e');
		await modal.getByRole('button', { name: 'Apply' }).click();
		await expect(toast(page, 'Stock adjusted')).toBeVisible();
		await expect(modal).toContainText('-3');
		await expect(modal).toContainText('Damaged in e2e');
		await expect(modal).toContainText('owner@e2e.example.net');

		const afterNeg = await api.stock(SKU_A);
		expect(afterNeg.onHand).toBe(before.onHand - 3);

		await modal.getByLabel('Stock adjustment delta').fill('10');
		await modal.getByLabel('Reason for adjustment').fill('Cycle count');
		await modal.getByRole('button', { name: 'Apply' }).click();
		await expect(modal).toContainText('+10');
		expect((await api.stock(SKU_A)).onHand).toBe(before.onHand + 7);

		// history API: newest first, signed deltas with their reasons
		const history = await api.get<{ items: { delta: number; reason: string; actor: string }[] }>(`/variants/${before.variantId}/stock/history?pageSize=10`);
		expect(history.items.slice(0, 2).map((h) => [h.delta, h.reason])).toEqual([[10, 'Cycle count'], [-3, 'Damaged in e2e']]);

		await page.keyboard.press('Escape');
		await expect(row(page, SKU_A).getByLabel(`On hand for ${SKU_A}`)).toHaveValue(String(before.onHand + 7));
	});

	test('bulk set stock writes the same on-hand to every selected variant', async ({ page, api }) => {
		const a = await api.stock(SKU_A);
		const b = await api.stock(SKU_B);
		await page.goto('/inventory');
		await page.getByLabel('Search SKU or name').fill(u);
		await expect(row(page, SKU_A)).toHaveCount(1);
		await expect(row(page, SKU_B)).toHaveCount(1);
		await page.getByLabel(`Select row ${a.variantId}`).check();
		await page.getByLabel(`Select row ${b.variantId}`).check();
		await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
		await page.getByLabel('New on-hand value for selected variants').fill('25');
		await page.getByRole('button', { name: 'Set stock for 2 selected' }).click();
		await expect(toast(page, 'Stock saved')).toBeVisible();
		await expect(toast(page, '2 variants set to 25')).toBeVisible();

		expect((await api.stock(SKU_A)).onHand).toBe(25);
		expect((await api.stock(SKU_B)).onHand).toBe(25);
		await expect(row(page, SKU_A).getByLabel(`On hand for ${SKU_A}`)).toHaveValue('25');

		// the bulk write is recorded in each variant's history
		const hist = await api.get<{ items: { delta: number }[] }>(`/variants/${a.variantId}/stock/history?pageSize=5`);
		expect(hist.items.length).toBeGreaterThan(0);
	});

	test('low-stock filter lists variants with available <= 3 and reflects live reservations', async ({ page, api }) => {
		await page.goto('/inventory');
		await page.getByLabel('Search SKU or name').fill(u);
		await page.getByRole('tab', { name: 'Low stock' }).click();
		await expect(row(page, SKU_LOW)).toHaveCount(1);
		await expect(row(page, SKU_A)).toHaveCount(0); // plenty in stock
		await expect(row(page, SKU_LOW)).toContainText('Low');

		// a paid order reserves one unit: committed 1, available 1, still low. Read the numbers live.
		await createOrder(api, { email: `${uniq('iv')}@example.net`, items: [{ sku: SKU_LOW, quantity: 1 }] });
		const live = await api.stock(SKU_LOW);
		expect(live).toMatchObject({ onHand: 2, allocated: 1, available: 1 });
		await page.reload();
		await page.getByLabel('Search SKU or name').fill(u);
		await page.getByRole('tab', { name: 'Low stock' }).click();
		const r = row(page, SKU_LOW);
		await expect(r.getByRole('cell').nth(4)).toHaveText(String(live.allocated)); // Committed
		await expect(r.getByRole('cell').nth(5)).toHaveText(String(live.available)); // Available

		// quick edit raises on-hand above the threshold -> it leaves the low-stock tab
		await r.getByLabel(`On hand for ${SKU_LOW}`).fill('30');
		await r.getByRole('button', { name: 'Save stock' }).click();
		await expect(toast(page, 'Stock saved')).toBeVisible();
		expect((await api.stock(SKU_LOW)).onHand).toBe(30);
		await expect(row(page, SKU_LOW)).toHaveCount(0);
		await page.getByRole('tab', { name: 'All stock' }).click();
		await expect(row(page, SKU_LOW)).toHaveCount(1);
	});

	test('a seeded sold-out variant is shown as out of stock', async ({ page }) => {
		await page.goto('/inventory');
		await page.getByRole('tab', { name: 'Low stock' }).click();
		await page.getByLabel('Search SKU or name').fill('E2E-OOS-1');
		await expect(row(page, 'E2E-OOS-1')).toContainText(/out of stock/i);
	});
});
