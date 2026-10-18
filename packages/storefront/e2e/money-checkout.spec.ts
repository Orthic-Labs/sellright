import { test, expect, skipExternal, setCardToken } from './fixtures';
import type { Page, Request } from '@playwright/test';
import { SHIPPING, SKU, readRows, sentEmails, uniq, PRODUCT } from './support/api';
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

	// Regression (was a product bug found by this suite): the Idempotency-Key for the gateway call used to be minted once
	// per PLACE ORDER and reused by every PAY click, so the API replayed the declined attempt and the shopper could never
	// pay with another card. Each PAY submit now carries its own key.
	test('after a decline, PAY with another card pays (each PAY submit is its own gateway attempt)', async ({ apiProxyPage: page, api }) => {
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
	async function flatShippingId(api: import('./support/api').AdminApi): Promise<string> {
		const flat = (await api.get<{ items: { id: string; code: string }[] }>('/shipping-methods')).items.find((m) => m.code === SHIPPING.flat)!;
		return flat.id;
	}

	/** A real merchant rate change makes the live pre-submit cart read reject the shopper's previously shown quote. */
	async function requestUpdatedQuote(page: Page) {
		const checkoutRequests: Request[] = [];
		page.on('request', (request) => {
			if (new URL(request.url()).pathname === '/v1/shop/checkout' && request.method() === 'POST') checkoutRequests.push(request);
		});
		const refreshed = page.waitForResponse((response) => {
			const url = new URL(response.url());
			return /^\/v1\/shop\/cart\/[^/]+$/.test(url.pathname) && response.request().method() === 'GET'
				&& url.searchParams.get('pricingIntent') === 'checkout';
		});
		await placeOrderButton(page).click();
		const response = await refreshed;
		expect(response.status(), 'live checkout quote').toBe(200);
		const quote = await response.json() as { quoteHash: string; subtotal: number; discountTotal: number; shippingTotal: number; taxTotal: number; grandTotal: number };
		expect(quote).toMatchObject({ subtotal: 2500, discountTotal: 0, shippingTotal: 800, taxTotal: 0, grandTotal: 3300 });
		expect(quote.quoteHash).toMatch(/^[0-9a-f]{64}$/);
		const notice = page.getByRole('alert', { name: 'Updated checkout quote' });
		await expect(notice).toContainText('Your total changed');
		await expect(notice.getByText('$8.00', { exact: true })).toBeVisible();
		await expect(notice.getByText('$33.00', { exact: true })).toBeVisible();
		expect(checkoutRequests, 'a fresh quote does not authorize order creation').toHaveLength(0);
		await expect(payButton(page)).toBeHidden();
		return { notice, quote, checkoutRequests };
	}

	test('shown $30.00, refreshed quote $33.00: confirming the quote and placing the order never charge; PAY charges exactly the accepted total', async ({ apiProxyPage: page, api }) => {
		const flatId = await flatShippingId(api);
		try {
			await addToCart(page, PRODUCT.shirt.slug);
			await goToCheckout(page);
			await fillShipping(page, `${uniq('chg')}@example.net`);
			await page.waitForLoadState('networkidle');
			await expect(page.getByText('$30.00').first()).toBeVisible();
			await api.patch(`/shipping-methods/${flatId}`, { calculator: { flat: 800 } });

			const salesBefore = (await mock.nmiCalls()).filter((c) => c.type === 'sale').length;
			const { notice, quote, checkoutRequests } = await requestUpdatedQuote(page);
			expect((await mock.nmiCalls()).filter((c) => c.type === 'sale')).toHaveLength(salesBefore);
			await notice.getByRole('button', { name: 'Confirm updated quote' }).click();
			await expect(notice).toBeHidden();
			expect(checkoutRequests, 'confirmation alone does not place an order').toHaveLength(0);
			expect((await mock.nmiCalls()).filter((c) => c.type === 'sale')).toHaveLength(salesBefore);
			const placed = await placeOrder(page);
			expect(placed.grandTotal, 'the order is priced by the accepted server quote').toBe(2500 + 800);
			expect(checkoutRequests).toHaveLength(1);
			expect(checkoutRequests[0]!.postDataJSON().acceptedQuoteHash).toBe(quote.quoteHash);

			await expect(payButton(page)).toContainText('$33.00');
			expect((await mock.nmiCalls()).filter((c) => c.type === 'sale')).toHaveLength(salesBefore);
			expect((await api.order(placed.code)).state).toBe('PendingPayment');

			await payAndConfirm(page, placed.code);
			const sales = (await mock.nmiCalls()).filter((c) => c.type === 'sale');
			expect(sales).toHaveLength(salesBefore + 1);
			expect(sales.at(-1)!.amount, 'the gateway is charged the order total').toBe('33.00');
			expect(await api.order(placed.code)).toMatchObject({ state: 'Paid', grandTotal: 3300, payments: [expect.objectContaining({ amount: 3300, state: 'captured' })] });
		} finally {
			await api.patch(`/shipping-methods/${flatId}`, { calculator: { flat: 500 } });
		}
	});

	test('a changed quote blocks order creation and payment until the shopper explicitly confirms its updated amounts', async ({ apiProxyPage: page, api }) => {
		const flatId = await flatShippingId(api);
		try {
			await addToCart(page, PRODUCT.shirt.slug);
			await goToCheckout(page);
			await fillShipping(page, `${uniq('chg2')}@example.net`);
			await page.waitForLoadState('networkidle');
			await expect(page.getByText('$30.00').first()).toBeVisible();
			const before = await api.stock(SKU.shirt);
			await api.patch(`/shipping-methods/${flatId}`, { calculator: { flat: 800 } });
			const { notice, quote, checkoutRequests } = await requestUpdatedQuote(page);
			// A repeated PLACE ORDER cannot accept the changed quote on the shopper's behalf.
			await placeOrderButton(page).click();
			await expect(page.getByText('Review updated amounts & confirm this quote before placing your order.', { exact: true })).toBeVisible();
			await expect(notice).toBeVisible();
			expect(checkoutRequests).toHaveLength(0);
			await expect(payButton(page)).toBeHidden();
			expect(await api.stock(SKU.shirt)).toEqual(before);
			expect((await mock.nmiCalls()).filter((c) => c.type === 'sale')).toHaveLength(0);

			await notice.getByRole('button', { name: 'Confirm updated quote' }).click();
			await expect(notice).toBeHidden();
			expect(checkoutRequests).toHaveLength(0);
			const placed = await placeOrder(page);
			expect(placed.grandTotal).toBe(3300);
			expect(checkoutRequests).toHaveLength(1);
			expect(checkoutRequests[0]!.postDataJSON().acceptedQuoteHash).toBe(quote.quoteHash);
			await expect(payButton(page)).toContainText('$33.00', { timeout: 5_000 });
			expect((await mock.nmiCalls()).filter((c) => c.type === 'sale')).toHaveLength(0);
			expect((await api.order(placed.code)).state).toBe('PendingPayment');
			await expect(payButton(page)).toBeEnabled();
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
