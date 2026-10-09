import { test, expect, skipExternal } from './fixtures';
import { registerAndVerify, signInWithPassword } from './support/account';
import { SKU, paidOrder, readRows, sentEmails, uniq } from './support/api';
import { mock } from './support/mock';

/**
 * Plan 1.3 P2 #21 — returns, end to end: the customer asks from their account order page, the merchant approves (or
 * rejects) through the admin API, the refund goes out through the (mock) NMI gateway, and the customer reads the outcome
 * on the same page. Stock is read live before and after (LOCKED stock rule: no fixtures, no cache).
 */
skipExternal();
test.beforeEach(() => mock.reset());

type OrderLine = { id: string; sku: string; quantity: number };
const returnsFor = (api: { get: <T = any>(p: string) => Promise<T> }, status: string) => api.get<{ items: Array<{ id: string; status: string; orderCode: string; reason: string | null }> }>(`/returns?status=${status}&pageSize=100`);

async function shippedOrder(api: import('./support/api').AdminApi, email: string) {
	const placed = await paidOrder({ email, items: [{ sku: SKU.shirt, quantity: 2 }, { sku: SKU.mug, quantity: 1 }] });
	const lines = (await api.order(placed.code)).lines as OrderLine[];
	await api.post(`/orders/${placed.code}/fulfillments`, { lines: lines.map((l) => ({ orderLineId: l.id, quantity: l.quantity })), trackingCode: 'RET-TRACK-1', carrier: 'UPS', notifyCustomer: false });
	return { placed, lines };
}

test.describe('#21 customer return request -> admin approve -> refund -> customer sees status', () => {
	test('request from the account, approve with restock, refunded through NMI, customer sees "Refunded"', async ({ apiProxyPage: page, api }) => {
		const email = `${uniq('ret')}@example.net`;
		await registerAndVerify(page, email, { first: 'Margaret', last: 'Hamilton' });
		const base = await api.stock(SKU.shirt);
		const { placed } = await shippedOrder(api, email);
		const afterShip = await api.stock(SKU.shirt); // 2 shirts left the shelf
		expect(afterShip.onHand).toBe(base.onHand - 2);

		await signInWithPassword(page, email);
		await page.goto(`/account/orders/${placed.code}`);
		const panel = page.getByTestId('order-returns');
		await expect(panel).toBeVisible({ timeout: 15_000 });
		await panel.getByRole('button', { name: /request a return/i }).click();

		// Nothing chosen / no reason: refused in the form, nothing is sent.
		await panel.getByRole('button', { name: /send return request/i }).click();
		await expect(panel.getByRole('alert')).toContainText(/choose at least one item/i);
		await panel.getByLabel(/quantity of e2e shirt to return/i).selectOption('1');
		await panel.getByRole('button', { name: /send return request/i }).click();
		await expect(panel.getByRole('alert')).toContainText(/tell us briefly why/i);
		expect((await returnsFor(api, 'requested')).items.filter((r) => r.orderCode === placed.code)).toHaveLength(0);

		await panel.locator('textarea').fill('The print is misaligned on one shirt.');
		await panel.getByRole('button', { name: /send return request/i }).click();
		await expect(panel.getByTestId('return-status')).toHaveText('Return requested', { timeout: 15_000 });
		await expect(panel).toContainText('1 × E2E Shirt');

		// The merchant's queue has exactly that request.
		const queued = (await returnsFor(api, 'requested')).items.filter((r) => r.orderCode === placed.code);
		expect(queued).toHaveLength(1);
		expect(queued[0]!.reason).toBe('The print is misaligned on one shirt.');
		// Asking moved nothing: no gateway call, no stock movement, order still Paid.
		expect((await mock.nmiCalls()).filter((c) => c.type === 'refund')).toHaveLength(0);
		expect(await api.stock(SKU.shirt)).toMatchObject({ onHand: afterShip.onHand, allocated: afterShip.allocated });
		expect((await api.order(placed.code)).state).toBe('Paid');

		// The shirt that is already in a request is not offered twice: one of the two shirts is still returnable.
		await panel.getByRole('button', { name: /request a return/i }).click();
		await expect(panel.getByLabel(/quantity of e2e shirt to return/i).locator('option')).toHaveCount(2); // 0 and 1

		// Admin approves, putting the unit back on the shelf.
		const approved = await api.post<{ refundState: string; refunded: number; state: string }>(`/returns/${queued[0]!.id}/approve`, { restock: true });
		expect(approved).toMatchObject({ refundState: 'Settled', refunded: 2500, state: 'PartiallyRefunded' });
		expect((await mock.nmiCalls()).filter((c) => c.type === 'refund').map((c) => c.amount)).toEqual(['25.00']);
		expect(await api.stock(SKU.shirt)).toMatchObject({ onHand: afterShip.onHand + 1, allocated: afterShip.allocated });
		expect((await readRows<{ status: string }>(api, `SELECT status FROM return_request WHERE id = $1`, [queued[0]!.id]))[0]!.status).toBe('refunded');

		// The customer sees the outcome on a fresh load of the same page, and the refund email arrived.
		await page.goto(`/account/orders/${placed.code}`);
		await expect(page.getByTestId('order-returns').getByTestId('return-status')).toHaveText('Refunded', { timeout: 15_000 });
		await expect(page.getByTestId('order-returns')).toContainText(/refund has been issued/i);
		await sentEmails(api, email, 'order-refund-confirmation', 1);
	});

	test('a rejected request is shown as such and its unit can be requested again', async ({ apiProxyPage: page, api }) => {
		const email = `${uniq('retrej')}@example.net`;
		await registerAndVerify(page, email);
		const { placed } = await shippedOrder(api, email);
		await signInWithPassword(page, email);
		await page.goto(`/account/orders/${placed.code}`);
		const panel = page.getByTestId('order-returns');
		await panel.getByRole('button', { name: /request a return/i }).click();
		await panel.getByLabel(/quantity of e2e mug to return/i).selectOption('1');
		await panel.locator('textarea').fill('Changed my mind about the mug.');
		await panel.getByRole('button', { name: /send return request/i }).click();
		await expect(panel.getByTestId('return-status')).toHaveText('Return requested', { timeout: 15_000 });

		const [req] = (await returnsFor(api, 'requested')).items.filter((r) => r.orderCode === placed.code);
		await api.post(`/returns/${req!.id}/reject`);
		await page.reload();
		await expect(page.getByTestId('order-returns').getByTestId('return-status')).toHaveText('Return not approved', { timeout: 15_000 });
		expect((await mock.nmiCalls()).filter((c) => c.type === 'refund')).toHaveLength(0);
		expect((await api.order(placed.code)).state).toBe('Paid');
		// ...and the mug is offered again.
		await page.getByTestId('order-returns').getByRole('button', { name: /request a return/i }).click();
		await expect(page.getByLabel(/quantity of e2e mug to return/i)).toBeVisible();
	});

	test('an order that has not shipped offers no return (nothing to send back yet)', async ({ apiProxyPage: page }) => {
		const email = `${uniq('retns')}@example.net`;
		await registerAndVerify(page, email);
		const placed = await paidOrder({ email, items: [{ sku: SKU.book, quantity: 1 }] });
		await signInWithPassword(page, email);
		await page.goto(`/account/orders/${placed.code}`);
		await expect(page.getByText('E2E Book').first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId('order-returns')).toHaveCount(0);
		// The API refuses it too, whatever the page shows.
		const status = await page.evaluate(async (code) => {
			const csrf = document.cookie.match(/sr_cust_csrf=([^;]+)/)?.[1] ?? '';
			return (await fetch(`/v1/shop/account/orders/${code}/returns`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf) }, body: JSON.stringify({ lines: [{ sku: 'E2E-BOOK-1', quantity: 1 }], reason: 'not shipped yet' }) })).status;
		}, placed.code);
		expect(status).toBe(409);
	});
});
