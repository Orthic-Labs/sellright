import { test, expect, prepareShopperPage, skipExternal } from './fixtures';
import { AdminApi, eventually, readRows, SHIPPING, SKU, sentEmails, shopCheckout, shopGatewayPayment, uniq } from './support/api';
import { mock, postSezzleWebhook, signedSezzleWebhook } from './support/mock';
import { addToCart, fillShipping, goToCheckout, payAndConfirm, payButton, placeOrderButton } from './support/flows';
import { SEZZLE_ACCOUNT } from './support/env.mjs';

/**
 * Plan 1.3 P0 #6-#7 — replayed provider webhooks must not double-settle, and the last unit can only be sold once.
 *
 * Supersedes: gateway-payments.webhook.test.ts, gateway-replay.test.ts, the stock-reservation race paths of
 * orders/stock-reservation.test.ts + cart-hardening.db.test.ts.
 */
skipExternal();
test.beforeEach(() => mock.reset());

const orderId = async (api: AdminApi, code: string) => (await readRows<{ id: string }>(api, `SELECT id FROM "order" WHERE code = $1`, [code]))[0]!.id;
const storeIdOf = async (api: AdminApi) => (await api.get<{ stores: { storeId: string; slug: string }[] }>('/me')).stores.find((s) => s.slug === api.slug)!.storeId;

test.describe('#6 webhook replay', () => {
	test('the same signed Sezzle event delivered twice (and again after settlement) -> one event row, one payment, one attempt, one confirmation email', async ({ api }) => {
		const email = `${uniq('replay')}@example.net`;
		const storeId = await storeIdOf(api);
		const placed = await shopCheckout({ email });
		const session = await shopGatewayPayment(placed.code, placed.receiptToken, { method: 'sezzle' });
		expect(session.status).toBe(200);
		const sezzle = (await mock.sezzleSessions()).find((s) => s.complete_url.includes(placed.code))!;
		await mock.sezzleCapture(sezzle.uuid); // the shopper approved on Sezzle's page; Sezzle captured

		const event = signedSezzleWebhook({ eventId: `evt-${uniq('e')}`, event: 'order.captured', orderUuid: sezzle.uuid, referenceId: sezzle.reference_id });
		// Sezzle retries aggressively: same body, same signature, back to back.
		expect(await postSezzleWebhook(storeId, event)).toBe(200);
		expect(await postSezzleWebhook(storeId, event)).toBe(200);

		await eventually(async () => (await api.order(placed.code)).state === 'Paid', 'the order to settle from the webhook');
		// ...and a late third delivery after it is already Paid.
		expect(await postSezzleWebhook(storeId, event)).toBe(200);
		// A DIFFERENT event id for the same capture (Sezzle re-emitting) must not settle it twice either.
		const reEmitted = signedSezzleWebhook({ eventId: `evt-${uniq('r')}`, event: 'order.captured', orderUuid: sezzle.uuid, referenceId: sezzle.reference_id });
		expect(await postSezzleWebhook(storeId, reEmitted)).toBe(200);
		await eventually(async () => (await readRows<{ status: string }>(api, `SELECT status FROM gateway_event WHERE provider_ref = $1`, [sezzle.uuid])).every((e) => e.status === 'processed'), 'every stored event processed');

		const id = await orderId(api, placed.code);
		const events = await readRows<{ event_id: string }>(api, `SELECT event_id FROM gateway_event WHERE provider_ref = $1`, [sezzle.uuid]);
		expect(events.map((e) => e.event_id).sort(), 'the replayed event is stored once; the re-emitted one is its own row').toEqual([JSON.parse(event.raw).uuid, JSON.parse(reEmitted.raw).uuid].sort());
		expect(await readRows(api, `SELECT 1 FROM payment WHERE order_id = $1`, [id]), 'exactly one payment').toHaveLength(1);
		expect(await readRows(api, `SELECT 1 FROM payment_attempt WHERE order_id = $1`, [id]), 'exactly one attempt').toHaveLength(1);
		const order = await api.order(placed.code);
		expect(order).toMatchObject({ state: 'Paid', paymentStatus: 'paid' });
		expect(order.payments).toHaveLength(1);
		expect(order.payments[0]).toMatchObject({ method: 'sezzle', amount: placed.grandTotal, state: 'captured', providerRef: sezzle.uuid });
		await sentEmails(api, email, 'order_confirmation', 1);
		expect(await readRows(api, `SELECT 1 FROM email_outbox WHERE recipient = $1 AND kind = 'order_confirmation'`, [email]), 'one confirmation email').toHaveLength(1);
	});

	test('a webhook with a bad signature, or for the wrong store, is rejected and settles nothing', async ({ api }) => {
		const storeId = await storeIdOf(api);
		const placed = await shopCheckout({ email: `${uniq('forged')}@example.net`, items: [{ sku: SKU.book, quantity: 1 }] });
		await shopGatewayPayment(placed.code, placed.receiptToken, { method: 'sezzle' });
		const sezzle = (await mock.sezzleSessions()).find((s) => s.complete_url.includes(placed.code))!;
		await mock.sezzleCapture(sezzle.uuid);
		const event = signedSezzleWebhook({ eventId: `evt-${uniq('f')}`, event: 'order.captured', orderUuid: sezzle.uuid, referenceId: sezzle.reference_id });
		expect(await postSezzleWebhook(storeId, { raw: event.raw, signature: '0'.repeat(64) })).toBe(401);
		const res = await fetch(`${api.baseUrl}/v1/webhooks/sezzle/00000000-0000-4000-8000-000000000000/${SEZZLE_ACCOUNT}`, { method: 'POST', headers: { 'sezzle-signature': event.signature }, body: event.raw });
		expect(res.status).toBe(404);
		await new Promise((r) => setTimeout(r, 2500)); // longer than a few worker ticks
		expect((await api.order(placed.code)).state).toBe('PendingPayment');
		expect(await readRows(api, `SELECT 1 FROM gateway_event WHERE provider_ref = $1`, [sezzle.uuid])).toHaveLength(0);
	});

	test('replaying the same payment request (same Idempotency-Key) returns the first attempt: one NMI sale, one payment', async ({ api }) => {
		const placed = await shopCheckout({ email: `${uniq('idem')}@example.net`, items: [{ sku: SKU.mug, quantity: 1 }] });
		const key = crypto.randomUUID();
		const first = await shopGatewayPayment(placed.code, placed.receiptToken, { method: 'nmi', token: 'tok_visa' }, key);
		const second = await shopGatewayPayment(placed.code, placed.receiptToken, { method: 'nmi', token: 'tok_visa' }, key);
		expect(first.body.state).toBe('Paid');
		expect(second.body.attemptId).toBe(first.body.attemptId);
		expect((await mock.nmiCalls()).filter((c) => c.type === 'sale')).toHaveLength(1);
		expect((await api.order(placed.code)).payments).toHaveLength(1);
		// A NEW key against an already-paid order is refused, not charged again.
		const third = await shopGatewayPayment(placed.code, placed.receiptToken, { method: 'nmi', token: 'tok_visa' });
		expect(third.status).toBe(409);
		expect((await mock.nmiCalls()).filter((c) => c.type === 'sale')).toHaveLength(1);
	});
});

test.describe('#7 last-unit race', () => {
	test('two shoppers, one unit: exactly one order is created and paid; the other gets the fail-closed out-of-stock message and no order', async ({ api, browser }) => {
		// A product with exactly one unit on hand (live stock is read back at every step — no stock fixtures).
		const tag = uniq('last');
		const sku = `E2E-LAST-${tag}`.toUpperCase();
		const slug = `e2e-last-${tag}`;
		const { id } = await api.post<{ id: string }>('/products', { name: `E2E Last Unit ${tag}`, slug, status: 'active' });
		await api.post(`/products/${id}/variants`, { sku, name: `E2E Last Unit ${tag}`, price: 2000, onHand: 1 });
		expect(await api.stock(sku)).toMatchObject({ onHand: 1, allocated: 0, available: 1 });

		const [ctxA, ctxB] = await Promise.all([browser.newContext(), browser.newContext()]);
		try {
			const [a, b] = await Promise.all([ctxA.newPage(), ctxB.newPage()]).then((ps) => Promise.all(ps.map(prepareShopperPage)));
			// Both shoppers see the unit available and put it in their cart (a cart is not a reservation)...
			await Promise.all([addToCart(a, slug), addToCart(b, slug)]);
			await Promise.all([goToCheckout(a), goToCheckout(b)]);
			await fillShipping(a, `${uniq('racea')}@example.net`, { first: 'Alice', last: 'Racer' });
			await fillShipping(b, `${uniq('raceb')}@example.net`, { first: 'Bob', last: 'Racer' });
			expect((await api.stock(sku)).available, 'still one unit: nothing is reserved before PLACE ORDER').toBe(1);

			// ...and both press PLACE ORDER at the same moment.
			const checkoutResponse = (p: typeof a) => p.waitForResponse((r) => r.url().includes('/v1/shop/checkout') && r.request().method() === 'POST');
			const [ra, rb] = [checkoutResponse(a), checkoutResponse(b)];
			await Promise.all([placeOrderButton(a).click(), placeOrderButton(b).click()]);
			const [resA, resB] = await Promise.all([ra, rb]);
			const outcomes = [resA.status(), resB.status()].sort();
			expect(outcomes, 'one 200 (reserved), one conflict (out of stock)').toEqual([200, 409]);
			const [winner, loser, loserRes] = resA.status() === 200 ? [a, b, resB] : [b, a, resA];
			expect((await loserRes.json()).error?.code).toBe('OUT_OF_STOCK');

			// The loser is told, in the UI, and is never offered a way to pay.
			await expect(loser.getByText(/out of stock|insufficient stock|no longer available|sold out|not enough/i).first()).toBeVisible({ timeout: 10_000 });
			await expect(payButton(loser)).toHaveCount(0);

			// The unit is reserved by exactly one order (live read) and only that one is payable.
			expect(await api.stock(sku)).toMatchObject({ onHand: 1, allocated: 1, available: 0 });
			const lines = await readRows<{ code: string; state: string }>(api, `SELECT o.code, o.state FROM order_line l JOIN "order" o ON o.id = l.order_id WHERE l.variant_sku = $1`, [sku]);
			expect(lines).toHaveLength(1);
			expect(lines[0]!.state).toBe('PendingPayment');

			await expect(payButton(winner)).toBeVisible();
			await payAndConfirm(winner, lines[0]!.code);
			expect((await api.order(lines[0]!.code)).state).toBe('Paid');
			expect(await api.stock(sku)).toMatchObject({ onHand: 1, allocated: 1, available: 0 });

			// After the sale the loser still cannot get one: whatever the form lets them press, no second order appears and
			// the stock never goes negative (fail closed).
			await placeOrderButton(loser).click({ timeout: 3_000 }).catch(() => undefined);
			await loser.waitForTimeout(1_500);
			expect(await readRows(api, `SELECT 1 FROM order_line WHERE variant_sku = $1`, [sku])).toHaveLength(1);
			expect(await api.stock(sku)).toMatchObject({ allocated: 1, available: 0 });
			await expect(payButton(loser)).toHaveCount(0);
		} finally {
			await Promise.all([ctxA.close(), ctxB.close()]);
		}
	});

	test('a unit someone else has reserved cannot be checked out through the API either (409 OUT_OF_STOCK, nothing created)', async ({ api }) => {
		const tag = uniq('lastapi');
		const sku = `E2E-LAST-${tag}`.toUpperCase();
		const { id } = await api.post<{ id: string }>('/products', { name: `E2E Last API ${tag}`, slug: `e2e-last-${tag}`, status: 'active' });
		await api.post(`/products/${id}/variants`, { sku, name: `E2E Last API ${tag}`, price: 1500, onHand: 1 });
		const first = await shopCheckout({ email: `${uniq('w')}@example.net`, items: [{ sku, quantity: 1 }], shippingMethodCode: SHIPPING.flat });
		expect(first.state).toBe('PendingPayment');
		await expect(shopCheckout({ email: `${uniq('l')}@example.net`, items: [{ sku, quantity: 1 }] })).rejects.toMatchObject({ status: 409 });
		expect(await api.stock(sku)).toMatchObject({ allocated: 1, available: 0 });
		expect(await readRows(api, `SELECT 1 FROM order_line WHERE variant_sku = $1`, [sku])).toHaveLength(1);
	});
});
