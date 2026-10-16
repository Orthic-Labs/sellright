import { test, expect, row } from './fixtures';
import { createOrder, createPendingOrder, uniq, SKU } from './support/api';

/**
 * Plan 1.3 #11 — Tracking import: CSV paste and file upload -> server preview (dry run) -> confirm ->
 * Shipped fulfillments with carrier inferred; unimportable rows reported, never silently dropped.
 * Supersedes: orders/tracking-import.test.ts (route/preview/commit paths), admin-order-ops.parity.db.test.ts (import section).
 */
test.describe('tracking import', () => {
	test('paste CSV: preview classifies every row, import ships only the ready ones and reports the rest', async ({ page, api }) => {
		const tag = uniq('ti');
		const ups = (await createOrder(api, { email: `${tag}-1@example.net` })).code;
		const usps = (await createOrder(api, { email: `${tag}-2@example.net` })).code;
		const unpaid = (await createPendingOrder(api, { email: `${tag}-3@example.net` })).code;
		const before = await api.stock(SKU.tee);

		await page.goto('/orders/import-tracking');
		const csv = [
			'order,tracking,carrier',
			`${ups},1Z999AA10123456784,`,               // carrier inferred -> UPS
			`${usps},9400111899223817200000,`,         // carrier inferred -> USPS
			'SRNOSUCHORD,1Z999AA10123456785,UPS',       // unknown order
			`${unpaid},1Z999AA10123456786,UPS`,         // exists but not paid
			`${ups.replace(/.$/, 'X')},,`,              // blank tracking
		].join('\n');
		await page.getByLabel('Tracking rows').fill(csv);
		await page.getByRole('button', { name: 'Preview import' }).click();

		// Preview is a dry run: per-row verdicts, nothing written yet.
		await expect(page.getByText('2 ready', { exact: true })).toBeVisible();
		const live = page.locator('[aria-live="polite"]').first();
		await expect(live).toContainText('1 unknown order');
		await expect(live).toContainText('1 cannot ship');
		await expect(live).toContainText('1 missing tracking');
		await expect(row(page, ups)).toContainText('Ready');
		await expect(row(page, ups)).toContainText('Auto: UPS');
		await expect(row(page, usps)).toContainText('Auto: USPS');
		await expect(row(page, unpaid)).toContainText('not paid yet');
		await expect(row(page, 'SRNOSUCHORD')).toContainText('Unknown order');
		expect((await api.order(ups)).fulfillmentStatus).toBe('unfulfilled');
		expect((await api.stock(SKU.tee)).onHand).toBe(before.onHand);

		await page.getByRole('button', { name: 'Import 2 ready rows' }).click();
		await expect(page.getByText('2 orders marked shipped.')).toBeVisible();
		await expect(page.getByText('3 rows not imported.')).toBeVisible();
		await expect(page.getByText('SRNOSUCHORD', { exact: false }).last()).toBeVisible();

		const upsOrder = await api.order(ups);
		expect(upsOrder.fulfillmentStatus).toBe('fulfilled');
		expect(upsOrder.fulfillments[0]).toMatchObject({ state: 'Shipped', trackingCode: '1Z999AA10123456784', carrier: 'UPS' });
		const uspsOrder = await api.order(usps);
		expect(uspsOrder.fulfillments[0]).toMatchObject({ state: 'Shipped', trackingCode: '9400111899223817200000', carrier: 'USPS' });
		expect((await api.order(unpaid)).fulfillments).toHaveLength(0);
		// live stock: two shipped units leave on-hand, no cache involved
		expect((await api.stock(SKU.tee)).onHand).toBe(before.onHand - 2);

		// history table records the batch
		await expect(page.getByRole('region', { name: 'Recent imports' })).toContainText('Pasted');
	});

	test('file upload: CSV file feeds the same preview/confirm flow; already-shipped tracking is flagged', async ({ page, api }) => {
		const tag = uniq('tf');
		const fresh = (await createOrder(api, { email: `${tag}-a@example.net` })).code;
		const done = (await createOrder(api, { email: `${tag}-b@example.net` })).code;
		await api.post(`/orders/${done}/fulfill`, { state: 'Shipped', trackingCode: '1Z999AA10123456799', carrier: 'UPS' });

		await page.goto('/orders/import-tracking');
		const fileName = `${tag}.csv`;
		await page.getByLabel('Choose a CSV file').setInputFiles({
			name: fileName, mimeType: 'text/csv',
			buffer: Buffer.from(`order,tracking,carrier\n${fresh},771234567890,FedEx\n${done},1Z999AA10123456799,UPS\n`),
		});
		await expect(page.getByText(fileName, { exact: true }).first()).toBeVisible();
		await expect(page.getByLabel('Tracking rows')).toHaveValue(new RegExp(`${fresh},771234567890,FedEx`));

		await page.getByRole('button', { name: 'Preview import' }).click();
		await expect(row(page, fresh)).toContainText('Ready');
		await expect(row(page, fresh)).toContainText('As given: FedEx');
		await expect(row(page, done)).toContainText('Already shipped');

		await page.getByRole('button', { name: 'Import 1 ready row' }).click();
		await expect(page.getByText('1 order marked shipped.')).toBeVisible();
		await expect(page.getByText('1 row not imported.')).toBeVisible();
		expect((await api.order(fresh)).fulfillments[0]).toMatchObject({ state: 'Shipped', trackingCode: '771234567890', carrier: 'FedEx' });

		await expect(page.getByRole('region', { name: 'Recent imports' })).toContainText(fileName);
	});

	test('editing the input after a preview makes it stale and blocks the import until re-previewed', async ({ page, api }) => {
		const code = (await createOrder(api, { email: `${uniq('ts')}@example.net` })).code;
		await page.goto('/orders/import-tracking');
		const box = page.getByLabel('Tracking rows');
		await box.fill(`${code},1Z999AA10123456711`);
		await page.getByRole('button', { name: 'Preview import' }).click();
		await expect(page.getByRole('button', { name: 'Import 1 ready row' })).toBeEnabled();
		await box.fill(`${code},1Z999AA10123456722`);
		await expect(page.getByText('You changed the input after this preview')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Import 1 ready row' })).toBeDisabled();
		expect((await api.order(code)).fulfillments).toHaveLength(0);
	});
});
