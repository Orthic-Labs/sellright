import { test, expect, skipExternal } from './fixtures';
import { STRIPE_ENABLED } from './support/env.mjs';
import { PRODUCT, uniq } from './support/api';
import { mock } from './support/mock';
import { addToCart, clickPay, fillShipping, goToCheckout, payButton, placeOrder } from './support/flows';
import { installStripeStub } from './support/stripe-stub';

/**
 * #205 leftovers: the payment component failing to INITIALISE in a real browser, against the real checkout route. Only the
 * third-party script is stubbed (Stripe.js / NMI Collect.js, at the network edge); the retry UI, the remount, the order and
 * the gateway calls are all the product's own.
 *   - Stripe: the Payment Element fires `loaderror` -> the checkout shows the recoverable error, fails closed (no PAY), and
 *     "Try again" remounts the element against the SAME order and PaymentIntent.
 *   - NMI: Collect.js loads but its hosted fields never become available and Collect.js reports its timeout -> same
 *     recoverable state; "Try again" remounts the card form and the shopper can pay.
 * Stripe needs the Stripe-enabled harness (E2E_STRIPE=1); NMI runs in the default one (with both enabled the method
 * selector offers two identical "Card" buttons, so the NMI case is not run there).
 */
skipExternal();
test.beforeEach(() => mock.reset());

const retryAlert = (page: import('@playwright/test').Page) => page.getByTestId('payment-init-failed');

test.describe('Stripe Elements loaderror', () => {
	test.skip(!STRIPE_ENABLED, 'needs E2E_STRIPE=1 (Stripe seeded as the checkout card method): did not run, missing coverage');

	test('loaderror shows a recoverable error with no PAY; Try again remounts on the same order and intent and PAY then confirms', async ({ apiProxyPage: page, api }) => {
		const stub = await installStripeStub(page);
		await page.addInitScript(() => { (window as unknown as { __STRIPE_LOADERROR: string }).__STRIPE_LOADERROR = 'Stripe could not load the payment form'; });

		await addToCart(page, PRODUCT.mug.slug);
		await goToCheckout(page);
		await fillShipping(page, `${uniq('loaderr')}@example.net`);
		const placed = await placeOrder(page);

		await expect(retryAlert(page)).toBeVisible({ timeout: 15_000 });
		await expect(retryAlert(page)).toContainText(/couldn.t load/i);
		// Fail closed: nothing to pay with, nothing was confirmed, the order is untouched.
		await expect(payButton(page)).toHaveCount(0);
		const before = await stub.calls();
		expect(before.filter((c) => c.fn === 'confirmPayment')).toEqual([]);
		expect(before.filter((c) => c.fn === 'elements.create')).toHaveLength(1);
		expect((await api.order(placed.code)).state).toBe('PendingPayment');

		// The shopper's network recovers; retry remounts the element (a fresh create) and the form becomes payable.
		await page.evaluate(() => { delete (window as unknown as { __STRIPE_LOADERROR?: string }).__STRIPE_LOADERROR; });
		await retryAlert(page).getByRole('button', { name: /try again/i }).click();
		await expect(retryAlert(page)).toHaveCount(0);
		await expect(payButton(page)).toBeVisible();
		await expect(page.getByText(/loading secure payment/i)).toHaveCount(0);
		expect((await stub.calls()).filter((c) => c.fn === 'elements.create')).toHaveLength(2);

		// Same order, same PaymentIntent: the retry minted nothing new, and both mounts were created with that intent's client secret and PAY confirms.
		const intents = (await mock.stripeIntents()).filter((i) => i.metadata.orderCode === placed.code);
		expect(intents).toHaveLength(1);
		await clickPay(page);
		await expect.poll(async () => (await stub.calls()).filter((c) => c.fn === 'confirmPayment')).toHaveLength(1);
		const calls = await stub.calls();
		const secrets = calls.filter((c) => c.fn === 'elements').map((c) => (c.opts as { clientSecret: string }).clientSecret);
		expect(secrets, 'both mounts (the failed one and the retry) used the order intent\'s client secret').toEqual([intents[0]!.client_secret, intents[0]!.client_secret]);
		expect(calls.filter((c) => c.fn === 'confirmPayment')).toEqual([expect.objectContaining({ hasElements: true })]);
		stub.assertReached();
	});
});

test.describe('NMI Collect.js init timeout', () => {
	test.skip(STRIPE_ENABLED, 'with Stripe seeded the method selector has two identical "Card" buttons; NMI runs in the default harness');

	// Stands in for hosted Collect.js. configure() #1: the hosted fields never become available (fieldsAvailableCallback is
	// never called) and, like the real library, it later calls `timeoutCallback`, 10s later on the page's clock.
	// configure() #2 (the product's retry reconfigures the loaded library): healthy.
	const COLLECT_JS = `
window.__collect = { configures: 0 };
window.CollectJS = {
	_cfg: null,
	configure(cfg) {
		this._cfg = cfg;
		const n = ++window.__collect.configures;
		if (n === 1) setTimeout(() => cfg.timeoutCallback && cfg.timeoutCallback(), 10000);
		else setTimeout(() => cfg.fieldsAvailableCallback && cfg.fieldsAvailableCallback(), 0);
	},
	startPaymentRequest() { const cfg = this._cfg; setTimeout(() => cfg.callback({ token: 'tok_visa' }), 0); },
};`;
	const configures = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __collect?: { configures: number } }).__collect?.configures ?? 0);

	test('fields never initialise -> timeout shows the recoverable error with no PAY; Try again reconfigures it and the card then pays', async ({ apiProxyPage: page, api }) => {
		await page.route('https://sandbox.nmi.com/token/Collect.js', (route) =>
			route.fulfill({ status: 200, contentType: 'application/javascript', body: COLLECT_JS }));
		await page.clock.install();

		await addToCart(page, PRODUCT.mug.slug);
		await goToCheckout(page);
		await fillShipping(page, `${uniq('nmito')}@example.net`);
		const placed = await placeOrder(page);

		// Collect.js loaded and was configured, but it never reported the fields: still waiting, no error yet.
		await expect.poll(() => configures(page)).toBe(1);
		await expect(retryAlert(page)).toHaveCount(0);

		// The vendor timeout elapses (deterministic: the page clock, no sleeping).
		await page.clock.fastForward(11_000);
		await expect(retryAlert(page)).toBeVisible();
		await expect(retryAlert(page)).toContainText(/couldn.t load/i);
		await expect(payButton(page)).toHaveCount(0);
		expect((await mock.nmiCalls()).filter((c) => c.type === 'sale')).toHaveLength(0);
		expect((await api.order(placed.code)).state).toBe('PendingPayment');

		// Retry remounts the card form, which configures Collect.js again; this time the fields become available.
		await retryAlert(page).getByRole('button', { name: /try again/i }).click();
		await expect(retryAlert(page)).toHaveCount(0);
		await expect(payButton(page)).toBeVisible();
		expect(await configures(page)).toBe(2);

		await clickPay(page);
		await expect(page).toHaveURL(new RegExp(`/checkout/confirmation/${placed.code}`), { timeout: 20_000 });
		await expect(page.getByRole('heading', { name: /thank you/i })).toBeVisible();
		const order = await api.order(placed.code);
		expect(order.state).toBe('Paid');
		expect(order.payments).toHaveLength(1);
		expect(order.payments[0]).toMatchObject({ method: 'nmi', amount: placed.grandTotal, state: 'captured' });
	});
});
