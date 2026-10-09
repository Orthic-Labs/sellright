import { test, expect, skipExternal, setCardToken } from './fixtures';
import { SHIPPING, SKU, clientIp, readRows, sentEmails, uniq, PRODUCT } from './support/api';
import { API_URL } from './support/env.mjs';
import { mock } from './support/mock';
import { addToCart, applyPromoAtCheckout, fillShipping, goToCheckout, clickPay, payAndConfirm, payButton, placeOrder, placeOrderButton } from './support/flows';

/**
 * Plan 1.3 P0 #1-#3 — the shopper's money path through the real storefront UI, real checkout + payment code in the API,
 * the NMI gateway mocked at the network edge (support/mock-gateways.mjs), real outbox workers and a real SMTP hop.
 * Stock assertions always re-read the live inventory endpoint (LOCKED stock rule: no fixtures, no cache, no debounce).
 *
 * Supersedes (once green on main): routes/e2e-checkout-gateway.test.ts, checkout.route.test.ts (pricing + stock reservation
 * paths), the NMI half of gateway-payments.route.test.ts.
 */
skipExternal();
test.beforeEach(() => mock.reset());

test.describe('#1 guest checkout, NMI card', () => {
	test('guest pays with a test card -> Paid -> confirmation page -> confirmation email sent -> stock allocated', async ({ apiProxyPage: page, api }) => {
		const email = `${uniq('guest')}@example.net`;
		const before = await api.stock(SKU.shirt);

		await addToCart(page, PRODUCT.shirt.slug);
		await goToCheckout(page);
		await fillShipping(page, email);
		const placed = await placeOrder(page);
		expect(placed.grandTotal).toBe(PRODUCT.shirt.price + 500);
		await expect(payButton(page)).toBeVisible();

		// PLACE ORDER reserves the unit at once (live read): allocated +1, available -1, on-hand untouched.
		const reserved = await api.stock(SKU.shirt);
		expect(reserved.allocated).toBe(before.allocated + 1);
		expect(reserved.available).toBe(before.available - 1);
		expect(reserved.onHand).toBe(before.onHand);
		// ...and nothing has been charged yet: PLACE ORDER never starts a payment.
		expect((await mock.nmiCalls()).filter((c) => c.type === 'sale')).toHaveLength(0);
		expect((await api.order(placed.code)).state).toBe('PendingPayment');

		await payAndConfirm(page, placed.code);
		await expect(page.getByText(`#${placed.code}`).first()).toBeVisible();

		// Order is Paid with exactly one settled NMI payment for the order total; the gateway saw one sale of that amount.
		const order = await api.order(placed.code);
		expect(order.state).toBe('Paid');
		expect(order.paymentStatus).toBe('paid');
		expect(order.payments).toHaveLength(1);
		expect(order.payments[0]).toMatchObject({ method: 'nmi', amount: placed.grandTotal, state: 'captured' });
		const sales = (await mock.nmiCalls()).filter((c) => c.type === 'sale' && c.amount === (placed.grandTotal / 100).toFixed(2));
		expect(sales).toHaveLength(1);

		// Stock stays allocated after payment (live read) — one unit committed, nothing shipped yet.
		const after = await api.stock(SKU.shirt);
		expect(after.allocated).toBe(before.allocated + 1);
		expect(after.available).toBe(before.available - 1);
		expect(after.onHand).toBe(before.onHand);

		// Confirmation email: durable outbox row drains to 'sent' through the real worker + SMTP, and the sink got it.
		const rows = await sentEmails(api, email, 'order_confirmation');
		expect(rows[0]!.status).toBe('sent');
		const mail = (await mock.mails()).find((m) => m.envelopeTo.includes(email) && m.text.includes(placed.code));
		expect(mail, 'confirmation mail in the SMTP sink').toBeTruthy();
		expect(mail!.subject).toContain(placed.code);
	});

	test('a declined card leaves the order unpaid with the unit still reserved and no confirmation email', async ({ apiProxyPage: page, api }) => {
		const email = `${uniq('decl')}@example.net`;
		const before = await api.stock(SKU.mug);
		await addToCart(page, PRODUCT.mug.slug);
		await goToCheckout(page);
		await fillShipping(page, email);
		const placed = await placeOrder(page);
		await expect(payButton(page)).toBeVisible();

		await setCardToken(page, 'tok_decline');
		await clickPay(page);
		await expect(page.getByText(/try a different card/i).first()).toBeVisible({ timeout: 15_000 });
		expect((await api.order(placed.code)).state).toBe('PendingPayment');
		// The decline is recorded on the ledger as a declined tender; nothing was captured.
		const tenders = (await api.order(placed.code)).payments as Array<{ state: string }>;
		expect(tenders.filter((p) => p.state === 'captured')).toHaveLength(0);
		expect(tenders.map((p) => p.state)).toEqual(['declined']);
		expect((await api.stock(SKU.mug)).allocated).toBe(before.allocated + 1);
		expect(await sentConfirmationCount(api, email)).toBe(0);
	});

	// PRODUCT BUG (found by this suite, storefront side): the Idempotency-Key for the gateway call is minted once per
	// PLACE ORDER (routes/checkout/index.tsx gatewayIdempotencyKey) and reused by every PAY click. The API replays the
	// attempt for a known key, so after a decline the PAY button can only ever return the same decline — the shopper
	// has to start over. Expected: PAY with another card pays. Remove test.fail()
	// when the NMI component mints a fresh key per tokenization.
	test('KNOWN BUG: after a decline, PAY with another card should pay (it replays the declined attempt)', async ({ apiProxyPage: page, api }) => {
		test.fail(true, 'gatewayIdempotencyKey is reused across PAY clicks, so the API replays the decline');
		await addToCart(page, PRODUCT.mug.slug);
		await goToCheckout(page);
		await fillShipping(page, `${uniq('retry')}@example.net`);
		const placed = await placeOrder(page);
		await setCardToken(page, 'tok_decline');
		await clickPay(page);
		await expect(page.getByText(/try a different card/i).first()).toBeVisible({ timeout: 15_000 });
		await setCardToken(page, 'tok_visa');
		await clickPay(page);
		await expect(page.getByRole('heading', { name: /thank you/i })).toBeVisible({ timeout: 10_000 });
		expect((await api.order(placed.code)).state).toBe('Paid');
	});
});

async function sentConfirmationCount(api: Parameters<typeof sentEmails>[0], email: string) {
	return (await readRows(api, `SELECT 1 FROM email_outbox WHERE recipient = $1 AND kind = 'order_confirmation'`, [email.toLowerCase()])).length;
}

test.describe('#2 coupons and promotions', () => {
	test('a percentage coupon discounts merchandise only — shipping is unchanged — and the gateway is charged the discounted total', async ({ apiProxyPage: page, api }) => {
		const code = `PCT${uniq('c')}`.toUpperCase();
		await api.post('/discounts', { code, type: 'percentage', value: 10 });
		const email = `${uniq('pct')}@example.net`;

		await addToCart(page, PRODUCT.shirt.slug);
		await goToCheckout(page);
		await applyPromoAtCheckout(page, code);
		// 10% of $25.00 merchandise = $2.50 off; the $5.00 shipping is not discounted: 25.00 - 2.50 + 5.00.
		await expect(page.getByText('-$2.50').first()).toBeVisible();
		await fillShipping(page, email);
		const placed = await placeOrder(page);
		expect(placed.grandTotal).toBe(2500 - 250 + 500);
		await expect(payButton(page)).toContainText('$27.50');
		await payAndConfirm(page, placed.code);

		const order = await api.order(placed.code);
		expect(order).toMatchObject({ state: 'Paid', subtotal: 2500, discountTotal: 250, shippingTotal: 500, grandTotal: 2750 });
		expect((await mock.nmiCalls()).filter((c) => c.type === 'sale' && c.amount === '27.50')).toHaveLength(1);
		const used = await readRows<{ used_count: number }>(api, `SELECT used_count FROM promotion WHERE code = $1`, [code]);
		expect(used[0]!.used_count).toBe(1);
	});

	test('a percentage coupon on a two-line cart discounts the merchandise total, not each shipping rule', async ({ apiProxyPage: page, api }) => {
		const code = `PCT2${uniq('c')}`.toUpperCase();
		await api.post('/discounts', { code, type: 'percentage', value: 20 });
		await addToCart(page, PRODUCT.shirt.slug);
		await page.goto(`/products/${PRODUCT.mug.slug}/`);
		await page.waitForLoadState('networkidle');
		await page.getByRole('button', { name: /^add to cart$/i }).click();
		await expect(page.getByRole('button', { name: /remove item/i })).toHaveCount(2, { timeout: 10_000 });
		await goToCheckout(page);
		await applyPromoAtCheckout(page, code);
		await fillShipping(page, `${uniq('pct2')}@example.net`);
		const placed = await placeOrder(page);
		// merchandise 25.00 + 12.00 = 37.00; 20% = 7.40; shipping 5.00 untouched.
		expect(placed.grandTotal).toBe(3700 - 740 + 500);
		await payAndConfirm(page, placed.code);
		expect(await api.order(placed.code)).toMatchObject({ discountTotal: 740, shippingTotal: 500, grandTotal: 3460 });
	});

	test('a free-shipping promotion zeroes the shipping line and nothing else', async ({ apiProxyPage: page, api }) => {
		const code = `SHIP${uniq('f')}`.toUpperCase();
		await api.post('/discounts', { code, type: 'free_shipping' });
		const email = `${uniq('ship')}@example.net`;

		await addToCart(page, PRODUCT.shirt.slug);
		await goToCheckout(page);
		await applyPromoAtCheckout(page, code);
		await fillShipping(page, email);
		const placed = await placeOrder(page);
		// Server-priced: $25.00 merchandise, $0 shipping, no merchandise discount.
		expect(placed.grandTotal).toBe(2500);
		await payAndConfirm(page, placed.code);

		expect(await api.order(placed.code)).toMatchObject({ state: 'Paid', subtotal: 2500, discountTotal: 0, shippingTotal: 0, grandTotal: 2500 });
		expect((await mock.nmiCalls()).filter((c) => c.type === 'sale' && c.amount === '25.00').length).toBeGreaterThanOrEqual(1);
	});

	test('a percentage coupon with free shipping layered on top (one code, both effects)', async ({ apiProxyPage: page, api }) => {
		const code = `BOTH${uniq('b')}`.toUpperCase();
		await api.post('/discounts', { code, type: 'percentage', value: 10, freeShipping: true });
		await addToCart(page, PRODUCT.shirt.slug);
		await goToCheckout(page);
		await applyPromoAtCheckout(page, code);
		await fillShipping(page, `${uniq('both')}@example.net`);
		const placed = await placeOrder(page);
		expect(placed.grandTotal).toBe(2500 - 250);
		await payAndConfirm(page, placed.code);
		expect(await api.order(placed.code)).toMatchObject({ discountTotal: 250, shippingTotal: 0, grandTotal: 2250 });
	});
});

test.describe('#3 changed-total consent gate', () => {
	/**
	 * The merchant has raised the flat rate to $8.00, but the quote the shopper's page holds is the old $5.00 one (a page
	 * left open, a quote that ignores a server-side adjustment, ...): the quote endpoint is made to keep answering $5.00
	 * while the server prices every order at $8.00. Returns the shipping method id so the caller can restore the rate.
	 */
	async function staleShippingQuote(page: import('@playwright/test').Page, api: import('./support/api').AdminApi) {
		const flat = (await api.get<{ items: { id: string; code: string }[] }>('/shipping-methods')).items.find((m) => m.code === SHIPPING.flat)!;
		await api.patch(`/shipping-methods/${flat.id}`, { calculator: { flat: 800 } });
		await page.route((url) => url.pathname === '/v1/shop/shipping-methods', async (route) => {
			const u = new URL(route.request().url());
			const real = await fetch(API_URL + u.pathname + u.search, { headers: { 'x-real-ip': clientIp() } });
			const body = (await real.json()) as { methods: Array<{ code: string; rate: number }> };
			body.methods = body.methods.map((m) => (m.code === SHIPPING.flat ? { ...m, rate: 500 } : m));
			await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
		});
		return flat.id;
	}

	test('estimate $30.00, server total $33.00: PLACE ORDER never charges, only the second click (PAY) pays — exactly the server total, never the estimate', async ({ apiProxyPage: page, api }) => {
		const flatId = await staleShippingQuote(page, api);
		try {
			await addToCart(page, PRODUCT.shirt.slug);
			await goToCheckout(page);
			await fillShipping(page, `${uniq('chg')}@example.net`);
			await expect(page.getByText('$30.00').first()).toBeVisible(); // the estimate on screen: $25.00 + $5.00

			const salesBefore = (await mock.nmiCalls()).filter((c) => c.type === 'sale').length;
			const placed = await placeOrder(page);
			expect(placed.grandTotal, 'the order is priced by the server, not by the estimate').toBe(2500 + 800);

			// Click #1 (PLACE ORDER) did not start a payment: no gateway call, the order is unpaid, a PAY step is offered.
			await expect(payButton(page)).toBeVisible();
			expect((await mock.nmiCalls()).filter((c) => c.type === 'sale')).toHaveLength(salesBefore);
			expect((await api.order(placed.code)).state).toBe('PendingPayment');

			// Click #2 (PAY) pays the server's total.
			await payAndConfirm(page, placed.code);
			const sales = (await mock.nmiCalls()).filter((c) => c.type === 'sale');
			expect(sales).toHaveLength(salesBefore + 1);
			expect(sales.at(-1)!.amount, 'the gateway is charged the order total').toBe('33.00');
			expect(await api.order(placed.code)).toMatchObject({ state: 'Paid', grandTotal: 3300, payments: [expect.objectContaining({ amount: 3300, state: 'captured' })] });
		} finally {
			await api.patch(`/shipping-methods/${flatId}`, { calculator: { flat: 500 } });
		}
	});

	// PRODUCT GAP (found by this suite, storefront side): once the order exists the PAY step keeps showing the client's own
	// estimate (subtotal - discount + re-quoted shipping, routes/checkout/index.tsx checkoutTotalCents) instead of the
	// order's grandTotal (useCheckout keeps it in state.grandTotal but nothing renders it). When the two differ — a stale
	// quote, tax, any server-side adjustment — the shopper is charged an amount they were never shown and there is no
	// "your total changed, confirm" step. Expected: after PLACE ORDER the button/summary show the order total, and a total
	// that moved requires an explicit second confirmation. Remove test.fail() when the PAY step renders the order total.
	test('KNOWN BUG: when the order total differs from the estimate, the PAY step shows the order total before the shopper pays', async ({ apiProxyPage: page, api }) => {
		test.fail(true, 'the PAY button renders the client estimate, not the order total');
		const flatId = await staleShippingQuote(page, api);
		try {
			await addToCart(page, PRODUCT.shirt.slug);
			await goToCheckout(page);
			await fillShipping(page, `${uniq('chg2')}@example.net`);
			const placed = await placeOrder(page);
			expect(placed.grandTotal).toBe(3300);
			await expect(payButton(page)).toContainText('$33.00', { timeout: 5_000 });
		} finally {
			await api.patch(`/shipping-methods/${flatId}`, { calculator: { flat: 500 } });
		}
	});

	test('the shipping estimate re-prices when a coupon changes the basis, and PLACE ORDER still only creates the order', async ({ apiProxyPage: page, api }) => {
		const code = `GATE${uniq('g')}`.toUpperCase();
		await api.post('/discounts', { code, type: 'fixed', value: 500 });
		await addToCart(page, PRODUCT.shirt.slug);
		await goToCheckout(page);
		await applyPromoAtCheckout(page, code);
		await fillShipping(page, `${uniq('gate')}@example.net`);
		const salesBefore = (await mock.nmiCalls()).filter((c) => c.type === 'sale').length;
		const placed = await placeOrder(page);
		expect(placed.grandTotal).toBe(2500 - 500 + 500);
		expect((await mock.nmiCalls()).filter((c) => c.type === 'sale')).toHaveLength(salesBefore);
		await expect(placeOrderButton(page).or(payButton(page)).first()).toBeVisible();
	});
});
