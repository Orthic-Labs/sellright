import { test, expect, skipExternal } from './fixtures';
import { eventually, readRows, sentEmails, SKU, uniq, PRODUCT } from './support/api';
import { mock, postSezzleWebhook, signedSezzleWebhook } from './support/mock';
import { addToCart, fillShipping, goToCheckout, placeOrder, recoverFormIfWiped } from './support/flows';
import { STORE_URL } from './support/env.mjs';
import type { AdminApi } from './support/api';

/**
 * Plan 1.3 P0 #8 — Sezzle. Sezzle's sandbox sits behind a CAPTCHA, so the browser leg stops at the redirect: the spec
 * proves the session the API creates (amounts, return URLs, reference), the redirect URL shape the shopper is sent to
 * (the hosted page itself is stubbed — the real host is never contacted), and that a signed webhook fixture, and the
 * shopper's return, each take the order to Paid.
 *
 * Supersedes: sezzle.test.ts + sezzle-reconcile.test.ts (adapter-through-route paths), the Sezzle half of
 * e2e-checkout-gateway.test.ts.
 */
skipExternal();
test.beforeEach(() => mock.reset());

const storeIdOf = async (api: AdminApi) => (await api.get<{ stores: { storeId: string; slug: string }[] }>('/me')).stores.find((s) => s.slug === api.slug)!.storeId;
const SEZZLE_HOSTED = 'https://sandbox.checkout.sezzle.com/**';

test.describe('#8 Sezzle', () => {
	test('PLACE ORDER -> Installments -> session created with reconciling amounts -> shopper redirected to the hosted checkout URL -> signed webhook -> Paid', async ({ apiProxyPage: page, api }) => {
		const email = `${uniq('sezzle')}@example.net`;
		// The hosted page is a stand-in: reaching it is all the browser leg proves.
		await page.route(SEZZLE_HOSTED, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Sezzle sandbox (stub)</title><h1>sezzle hosted checkout</h1>' }));
		const before = await api.stock(SKU.shirt);

		await addToCart(page, PRODUCT.shirt.slug);
		await goToCheckout(page);
		await fillShipping(page, email);
		// Both gateways are configured, so the shopper chooses: Card (NMI) or Installments (Sezzle).
		await page.getByRole('radio', { name: /installments/i }).click();
		const placed = await placeOrder(page);
		expect(placed.grandTotal).toBe(2500 + 500);
		const startButton = page.getByRole('button', { name: /^continue/i });
		await expect(startButton).toContainText('$30.00');

		// Clicking it asks the API for a Sezzle session, then sends the browser to Sezzle's hosted checkout.
		await recoverFormIfWiped(page);
		await startButton.click();
		await page.waitForURL(/sandbox\.checkout\.sezzle\.com/, { timeout: 15_000 });
		const redirect = new URL(page.url());
		expect(redirect.protocol).toBe('https:');
		expect(redirect.hostname).toBe('sandbox.checkout.sezzle.com');
		expect(redirect.username + redirect.password).toBe('');
		const session = (await mock.sezzleSessions()).find((s) => s.complete_url.includes(placed.code))!;
		expect(session, 'the API created exactly this order\'s session').toBeTruthy();
		expect(redirect.searchParams.get('id')).toBe(session.uuid);

		// The session the API sent to Sezzle: amounts reconcile, return URLs point back at this storefront, the
		// reference ties it to our payment attempt.
		const body = session.session;
		expect(body.order).toMatchObject({ intent: 'CAPTURE', order_amount: { amount_in_cents: 3000, currency: 'USD' }, shipping_amount: { amount_in_cents: 500 }, tax_amount: { amount_in_cents: 0 } });
		expect(body.order.items).toEqual([expect.objectContaining({ sku: SKU.shirt, quantity: 1, price: { amount_in_cents: 2500, currency: 'USD' } })]);
		expect(body.customer.email).toBe(email);
		const complete = new URL(session.complete_url);
		expect(complete.origin).toBe(new URL(STORE_URL).origin);
		expect(complete.pathname).toBe(`/checkout/confirmation/${placed.code}`);
		expect(complete.searchParams.get('rt')).toBe(placed.receiptToken);
		expect(complete.searchParams.get('paymentAttempt')).toBe(session.reference_id);
		expect(new URL(session.cancel_url).pathname).toBe('/checkout');
		const attempts = await readRows<{ id: string; status: string; method: string; operation: string }>(api, `SELECT a.id, a.status, a.method, a.operation FROM payment_attempt a JOIN "order" o ON o.id = a.order_id WHERE o.code = $1`, [placed.code]);
		expect(attempts).toEqual([{ id: session.reference_id, status: 'pending', method: 'sezzle', operation: 'session' }]);

		// Until Sezzle says otherwise the order is unpaid with the unit held.
		expect((await api.order(placed.code)).state).toBe('PendingPayment');
		expect((await api.stock(SKU.shirt)).allocated).toBe(before.allocated + 1);

		// The shopper approves on Sezzle (offscreen); Sezzle captures and posts its signed webhook.
		await mock.sezzleCapture(session.uuid);
		const hook = signedSezzleWebhook({ eventId: `evt-${uniq('s')}`, event: 'order.captured', orderUuid: session.uuid, referenceId: session.reference_id });
		expect(await postSezzleWebhook(await storeIdOf(api), hook)).toBe(200);
		await eventually(async () => (await api.order(placed.code)).state === 'Paid', 'the signed webhook to settle the order');

		const order = await api.order(placed.code);
		expect(order.payments).toHaveLength(1);
		expect(order.payments[0]).toMatchObject({ method: 'sezzle', amount: 3000, state: 'captured', providerRef: session.uuid });
		expect(await api.stock(SKU.shirt)).toMatchObject({ allocated: before.allocated + 1, onHand: before.onHand });
		await sentEmails(api, email, 'order_confirmation', 1);

		// The shopper comes back from Sezzle: the confirmation page shows a paid order.
		await page.unroute(SEZZLE_HOSTED);
		await page.goto(session.complete_url);
		await expect(page.getByRole('heading', { name: /thank you/i })).toBeVisible({ timeout: 20_000 });
		await expect(page.getByText(`#${placed.code}`).first()).toBeVisible();
	});

	test('the shopper returning from Sezzle before any webhook arrives still ends Paid (the confirmation page verifies the session)', async ({ apiProxyPage: page, api }) => {
		await page.route(SEZZLE_HOSTED, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>stub</h1>' }));
		await addToCart(page, PRODUCT.mug.slug);
		await goToCheckout(page);
		await fillShipping(page, `${uniq('sezret')}@example.net`);
		await page.getByRole('radio', { name: /installments/i }).click();
		const placed = await placeOrder(page);
		await recoverFormIfWiped(page);
		await page.getByRole('button', { name: /^continue/i }).click();
		await page.waitForURL(/sandbox\.checkout\.sezzle\.com/, { timeout: 15_000 });
		const session = (await mock.sezzleSessions()).find((s) => s.complete_url.includes(placed.code))!;

		// A shopper who abandons the hosted page and returns without approving is NOT paid.
		await page.unroute(SEZZLE_HOSTED);
		await page.goto(session.complete_url);
		await page.waitForTimeout(3000);
		expect((await api.order(placed.code)).state).toBe('PendingPayment');

		// Approve + return: the confirmation page's own verify call settles it, no webhook involved.
		await mock.sezzleCapture(session.uuid);
		await page.goto(session.complete_url);
		await expect(page.getByRole('heading', { name: /thank you/i })).toBeVisible({ timeout: 20_000 });
		expect((await api.order(placed.code)).state).toBe('Paid');
		expect((await api.order(placed.code)).payments).toHaveLength(1);
	});
});
