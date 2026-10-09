import { test, expect, skipExternal, setCardToken } from './fixtures';
import { SKU, mailTo, paidOrder, readRows, sentEmails, uniq } from './support/api';
import { linkInMail, mock } from './support/mock';

/**
 * Order edited up after payment -> balance due -> the customer pays the difference from the emailed link.
 * The merchant's edit goes through the real admin API (preview -> commit, guarded by expectedGrandTotal); the pay link
 * arrives through the SMTP sink; the page /orders/{code}?rt=... charges the balance through the mock NMI gateway.
 */
skipExternal();
test.beforeEach(() => mock.reset());

type OrderLine = { id: string; sku: string; quantity: number };

/** A Paid single-shirt order, then an admin edit that raises it to two shirts (+$25) settled as asked. */
async function editedUp(api: import('./support/api').AdminApi, email: string, settlement: { type: 'send_pay_link' | 'leave_due' }, notifyCustomer: boolean) {
	const placed = await paidOrder({ email, items: [{ sku: SKU.shirt, quantity: 1 }] });
	const line = ((await api.order(placed.code)).lines as OrderLine[])[0]!;
	const ops = [{ op: 'set_quantity', lineId: line.id, quantity: 2 }];
	const preview = await api.post(`/orders/${placed.code}/edit/preview`, { ops });
	const committed = await api.post(`/orders/${placed.code}/edit/commit`, {
		ops, expectedGrandTotal: preview.after.grandTotal, expectedBalance: preview.balance.amountDue, idempotencyKey: uniq('edit'), settlement, notifyCustomer, reason: 'Added a second shirt at your request',
	});
	return { placed, committed, line };
}

const sales = async () => (await mock.nmiCalls()).filter((c) => c.type === 'sale').map((c) => c.amount);

test.describe('balance pay after an order edit', () => {
	test('send_pay_link + notify: one "order updated" email carries the pay link; the link pays the balance via NMI -> Paid, nothing due', async ({ apiProxyPage: page, api }) => {
		const email = `${uniq('bal')}@example.net`;
		const { placed, committed } = await editedUp(api, email, { type: 'send_pay_link' }, true);
		const original = await sales(); // the first checkout's charge ($30: shirt + shipping) is already behind us
		expect(original).toEqual(['30.00']);
		expect(committed).toMatchObject({ balance: 2500, amountDue: 2500, grandTotal: placed.grandTotal + 2500, settlement: { type: 'send_pay_link', status: 'sent' }, emailQueued: true });

		const detail = await api.order(placed.code);
		expect(detail.state).toBe('Paid');
		expect(detail.paymentStatus).toBe('balance_due');
		expect(detail.amountDue).toBe(2500);

		// The customer's mail: summary + amount due + a pay link carrying this order's receipt token.
		const rows = await sentEmails(api, email, 'order_updated');
		expect(rows).toHaveLength(1);
		const mail = await mailTo(email, (m) => /was updated/i.test(m.subject), 'order-updated email');
		expect(mail.text + mail.html).toMatch(/Amount due: 25\.00 USD/);
		const link = linkInMail(mail, '?rt=')!;
		expect(link).toBeTruthy();
		const url = new URL(link);
		expect(url.pathname).toBe(`/orders/${placed.code}`);
		expect(url.searchParams.get('pay')).toBe('balance');

		// The page shows what changed and exactly the amount due, and charges exactly that.
		await page.goto(link);
		await expect(page.getByTestId('balance-state-due')).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId('balance-amount')).toHaveText('$25');
		await expect(page.getByTestId('balance-changes')).toBeVisible();
		await setCardToken(page, 'tok_visa');
		await page.getByTestId('balance-pay-button').click();
		await expect(page.getByTestId('balance-state-settled')).toBeVisible({ timeout: 20_000 });
		await expect(page.getByRole('heading', { name: /balance paid/i })).toBeVisible();

		const after = await api.order(placed.code);
		expect(after.state).toBe('Paid');
		expect(after.paymentStatus).toBe('paid');
		expect(after.amountDue).toBe(0);
		expect(after.payments).toHaveLength(2);
		expect((await sales()).slice(original.length)).toEqual(['25.00']); // only the difference was charged
		// Reloading the link now says there is nothing left to pay (it can never be charged twice).
		await page.goto(link);
		await expect(page.getByTestId('balance-state-settled').or(page.getByTestId('balance-state-nothing-due'))).toBeVisible({ timeout: 20_000 });
		expect(await sales()).toHaveLength(original.length + 1);
	});

	test('send_pay_link without notify: the stand-alone "balance due" email carries the link; a declined card leaves the balance due', async ({ apiProxyPage: page, api }) => {
		const email = `${uniq('bal2')}@example.net`;
		const { placed, committed } = await editedUp(api, email, { type: 'send_pay_link' }, false);
		expect(committed.settlement).toMatchObject({ type: 'send_pay_link', status: 'sent' });
		await sentEmails(api, email, 'order_balance_due');
		const mail = await mailTo(email, (m) => /balance due/i.test(m.subject), 'balance-due email');
		const link = linkInMail(mail, '?rt=')!;

		await page.goto(link);
		await expect(page.getByTestId('balance-state-due')).toBeVisible({ timeout: 20_000 });
		await setCardToken(page, 'tok_decline');
		await page.getByTestId('balance-pay-button').click();
		await expect(page.getByTestId('balance-error')).toBeVisible({ timeout: 20_000 });
		expect((await api.order(placed.code)).amountDue).toBe(2500);

		// The shopper tries another card on the same page and pays.
		await setCardToken(page, 'tok_visa');
		await page.getByTestId('balance-pay-button').click();
		await expect(page.getByTestId('balance-state-settled')).toBeVisible({ timeout: 20_000 });
		expect((await api.order(placed.code)).amountDue).toBe(0);
	});

	test('leave_due + notify: the customer is told the amount due, no pay link is minted, and the bare order URL leads to the tracking lookup, not a dead end', async ({ apiProxyPage: page, api }) => {
		const email = `${uniq('bal3')}@example.net`;
		const { placed, committed } = await editedUp(api, email, { type: 'leave_due' }, true);
		expect(committed).toMatchObject({ balance: 2500, amountDue: 2500, settlement: { type: 'leave_due', status: 'due' } });
		await sentEmails(api, email, 'order_updated');
		const mail = await mailTo(email, (m) => /was updated/i.test(m.subject), 'order-updated email');
		expect(mail.text + mail.html).toMatch(/Amount due: 25\.00 USD/);
		expect(linkInMail(mail, 'pay=balance')).toBeUndefined();
		expect(linkInMail(mail, 'rt=')).toBeUndefined();
		expect((await api.order(placed.code)).paymentStatus).toBe('balance_due');

		// The order link every email carries (/orders/{code}, no receipt token) cannot pay anything; instead of a dead end it
		// takes a guest to the tracking lookup with the number filled in, and a signed-in customer to their account order.
		await page.goto(`/orders/${placed.code}`);
		await page.waitForURL(/\/track-order/, { timeout: 20_000 });
		await expect(page.locator('#orderCode')).toHaveValue(placed.code, { timeout: 15_000 });
		await expect(page.getByTestId('balance-state-due')).toHaveCount(0);
		expect(await readRows(api, `SELECT 1 FROM payment WHERE order_id = (SELECT id FROM "order" WHERE code = $1) AND state = 'Settled'`, [placed.code])).toHaveLength(1);
		expect(await sales()).toEqual(['30.00']); // nothing beyond the original checkout charge
	});
});
