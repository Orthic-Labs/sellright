import { test, expect, toast } from './fixtures';
import { createOrder, createPendingOrder, uniq, SKU, US_ADDRESS } from './support/api';

/**
 * Plan 1.3 #10 — Order detail: internal note, cancel (PendingPayment only), invoice + packing slip render.
 * Supersedes: admin.order-notes.test.ts, admin-orders.cancel.test.ts, invoice.test.ts (route/format paths).
 */
test.describe('order detail', () => {
	test('adds an internal note to the timeline', async ({ page, api }) => {
		const { code } = await createOrder(api, { email: `${uniq('note')}@example.net` });
		await page.goto(`/orders/${code}`);
		await expect(page.getByRole('heading', { name: code })).toBeVisible();

		const text = `Packed by e2e ${uniq('n')}`;
		await page.getByLabel('Add an internal note').fill(text);
		await page.getByRole('button', { name: 'Add note' }).click();
		await expect(toast(page, 'Note added')).toBeVisible();
		await expect(page.locator('li', { hasText: `Note: ${text}` })).toBeVisible();

		const detail = await api.order(code);
		expect(detail.events.some((e: { action: string; data?: { note?: string } }) => e.action === 'note' && e.data?.note === text)).toBe(true);
		// notes survive a reload (they are timeline rows, not component state)
		await page.reload();
		await expect(page.locator('li', { hasText: `Note: ${text}` })).toBeVisible();
	});

	test('cancels a PendingPayment order via the confirm dialog and releases its reservation', async ({ page, api }) => {
		const { code } = await createPendingOrder(api, { email: `${uniq('cx')}@example.net`, items: [{ sku: SKU.mug, quantity: 2 }] });
		const reserved = await api.stock(SKU.mug);

		await page.goto(`/orders/${code}`);
		await page.getByRole('button', { name: 'Cancel order' }).click();
		const dialog = page.getByRole('alertdialog');
		await expect(dialog).toContainText(`Cancel order ${code}?`);
		await dialog.getByRole('button', { name: 'Cancel order' }).click();
		await expect(toast(page, 'Order cancelled')).toBeVisible();

		expect((await api.order(code)).state).toBe('Cancelled');
		// live read, no cache: the two reserved units are released
		expect((await api.stock(SKU.mug)).allocated).toBe(reserved.allocated - 2);
		// a cancelled order offers no cancel action any more
		await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
	});

	test('refuses to cancel a paid order (refund is the only way) and leaves it untouched', async ({ page, api }) => {
		const { code } = await createOrder(api, { email: `${uniq('cp')}@example.net` });
		await page.goto(`/orders/${code}`);
		await page.getByRole('button', { name: 'Cancel order' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel order' }).click();
		await expect(page.getByText(/paid order — use Refund/).first()).toBeVisible();
		expect((await api.order(code)).state).toBe('Paid');
	});

	test('invoice (html) and packing slip (json) render the order', async ({ page, api }) => {
		const { code, grandTotal } = await createOrder(api, {
			email: `${uniq('inv')}@example.net`, items: [{ sku: SKU.tee, quantity: 2 }, { sku: SKU.mug, quantity: 1 }],
		});
		expect(grandTotal).toBe(2 * 2500 + 1200 + 500);

		const invoice = await page.goto(`/v1/admin/orders/${code}/invoice?format=html`);
		expect(invoice?.status()).toBe(200);
		expect(invoice?.headers()['content-type']).toContain('text/html');
		const body = page.locator('body');
		await expect(page.locator('h1')).toHaveText('E2E Store');
		await expect(body).toContainText(`INV-${code}`);
		await expect(body).toContainText(SKU.tee);
		await expect(body).toContainText('E2E Tee / M');
		await expect(body).toContainText(SKU.mug);
		await expect(body).toContainText('$66.99'.replace('66.99', (grandTotal / 100).toFixed(2)));
		await expect(body).toContainText(US_ADDRESS.line1);

		// Same-origin fetch from the page: the session cookie is Secure, which Playwright's request context
		// (unlike the browser) does not send to plain-http 127.0.0.1.
		const slip = await page.evaluate(async (url) => {
			const r = await fetch(url, { credentials: 'include' });
			return { status: r.status, doc: await r.json() };
		}, `/v1/admin/orders/${code}/packing-slip`);
		expect(slip.status).toBe(200);
		const doc = slip.doc;
		expect(doc.type).toBe('packing_slip');
		expect(doc.number).toBe(`PS-${code}`);
		expect(doc.lines).toEqual(expect.arrayContaining([
			expect.objectContaining({ sku: SKU.tee, quantity: 2 }), expect.objectContaining({ sku: SKU.mug, quantity: 1 }),
		]));
		expect(doc.shipTo).toEqual(expect.arrayContaining([US_ADDRESS.fullName, US_ADDRESS.line1]));
	});

	test('the Invoice and Packing slip buttons open the printable documents in a new tab', async ({ page, api }) => {
		const { code, grandTotal } = await createOrder(api, {
			email: `${uniq('doc')}@example.net`, items: [{ sku: SKU.tee, quantity: 2 }, { sku: SKU.mug, quantity: 1 }],
		});
		await page.goto(`/orders/${code}`);
		await expect(page.getByRole('heading', { name: code })).toBeVisible();

		const [invoice] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Invoice' }).click()]);
		await expect(invoice.locator('h1')).toHaveText('E2E Store');
		await expect(invoice.locator('body')).toContainText(`INV-${code}`);
		await expect(invoice.locator('body')).toContainText((grandTotal / 100).toFixed(2));
		await invoice.close();

		const [slip] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Packing slip' }).click()]);
		await expect(slip.locator('h1')).toHaveText('E2E Store');
		await expect(slip.locator('body')).toContainText(`PS-${code}`);
		await expect(slip.locator('body')).toContainText(SKU.tee);
		await expect(slip.locator('body')).toContainText(US_ADDRESS.line1);
		await expect(slip.locator('body')).not.toContainText('$'); // a packing slip carries no prices
	});
});
