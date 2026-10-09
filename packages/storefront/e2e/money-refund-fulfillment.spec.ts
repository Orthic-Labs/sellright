import { createHmac } from 'node:crypto';
import { test, expect, skipExternal } from './fixtures';
import { ensureCustomer, eventually, paidOrder, readRows, sentEmails, SKU, uniq } from './support/api';
import { mock } from './support/mock';

/**
 * Plan 1.3 P0 #4-#5 — what the merchant does after the sale: refund per line (with restock) and ship in parts. Orders are
 * arranged through the real storefront checkout + NMI payment path; the merchant's actions go through the real admin
 * API; every consequence is read back live (stock, order state, outbox, webhook receiver, SMTP sink).
 *
 * Supersedes: admin-orders.refund*.test.ts, refunds.stock-hook.test.ts, admin.partial-fulfillment.test.ts,
 * the order.shipped parts of emit.test.ts.
 */
skipExternal();
test.beforeEach(() => mock.reset());

type OrderLine = { id: string; sku: string; quantity: number };

test.describe('#4 refund per line with restock', () => {
	test('refunding line by line (restock on the shipped one) ends Refunded, releases the allocation, restocks, queues a refund email each time', async ({ api }) => {
		const email = `${uniq('refund')}@example.net`; // a guest: the refund email must still reach the checkout address
		const base = { shirt: await api.stock(SKU.shirt), mug: await api.stock(SKU.mug) };
		const placed = await paidOrder({ email, items: [{ sku: SKU.shirt, quantity: 2 }, { sku: SKU.mug, quantity: 1 }] });
		expect(placed.grandTotal).toBe(2 * 2500 + 1200 + 500);
		const order = await api.order(placed.code);
		const shirt = (order.lines as OrderLine[]).find((l) => l.sku === SKU.shirt)!;
		const mug = (order.lines as OrderLine[]).find((l) => l.sku === SKU.mug)!;

		// Paid and reserved: 2 shirts + 1 mug allocated (live reads).
		expect((await api.stock(SKU.shirt)).allocated).toBe(base.shirt.allocated + 2);
		expect((await api.stock(SKU.mug)).allocated).toBe(base.mug.allocated + 1);

		// The mug ships first (one unit leaves the shelf: on-hand -1, allocation -1).
		await api.post(`/orders/${placed.code}/fulfillments`, { lines: [{ orderLineId: mug.id, quantity: 1 }], notifyCustomer: false });
		expect(await api.stock(SKU.mug)).toMatchObject({ onHand: base.mug.onHand - 1, allocated: base.mug.allocated });

		// Refund #1: both shirts (never shipped). Money back via the gateway, allocation released, order PartiallyRefunded.
		const r1 = await api.post(`/orders/${placed.code}/refund`, { idempotencyKey: uniq('rf'), lines: [{ orderLineId: shirt.id, quantity: 2, restock: true }], reason: 'e2e refund shirts' });
		expect(r1).toMatchObject({ refundState: 'Settled', state: 'PartiallyRefunded', refunded: 5000 });
		expect(await api.stock(SKU.shirt)).toMatchObject({ allocated: base.shirt.allocated, onHand: base.shirt.onHand }); // released, not restocked: nothing had left
		expect((await api.order(placed.code)).state).toBe('PartiallyRefunded');

		// Refund #2: the shipped mug WITH restock (comes back on the shelf) plus the shipping charge -> everything is refunded.
		const r2 = await api.post(`/orders/${placed.code}/refund`, { idempotencyKey: uniq('rf'), lines: [{ orderLineId: mug.id, quantity: 1, restock: true }], shippingAmount: 500 });
		expect(r2).toMatchObject({ refundState: 'Settled', state: 'Refunded', refunded: 1700 });
		expect(await api.stock(SKU.mug)).toMatchObject({ onHand: base.mug.onHand, allocated: base.mug.allocated }); // restocked: back to where it started
		expect(await api.stock(SKU.shirt)).toMatchObject({ onHand: base.shirt.onHand, allocated: base.shirt.allocated });

		const final = await api.order(placed.code);
		expect(final.state).toBe('Refunded');
		expect(final.paymentStatus).toMatch(/refunded/);
		expect((final.refunds as Array<{ lines: Array<{ restock: boolean }> }>).map((r) => r.lines.map((l) => l.restock))).toEqual([[true], [true]]);

		// The gateway was asked for exactly the two refund amounts.
		const refunds = (await mock.nmiCalls()).filter((c) => c.type === 'refund').map((c) => c.amount).sort();
		expect(refunds).toEqual(['17.00', '50.00']);

		// One refund email per refund, drained to 'sent' and received by the sink.
		const rows = await sentEmails(api, email, 'order-refund-confirmation', 2);
		expect(rows).toHaveLength(2);
		await eventually(async () => (await mock.mails()).filter((m) => m.envelopeTo.includes(email) && /refund/i.test(m.subject + m.text)).length >= 2, 'two refund emails in the SMTP sink');
	});

	test('a refund cannot exceed what was paid, and a replayed refund request is idempotent (one gateway call, one email)', async ({ api }) => {
		const email = `${uniq('refund2')}@example.net`;
		const placed = await paidOrder({ email, items: [{ sku: SKU.book, quantity: 1 }] });
		const key = uniq('rf');
		const first = await api.post(`/orders/${placed.code}/refund`, { idempotencyKey: key, amount: 500, reason: 'goodwill' });
		const replay = await api.post(`/orders/${placed.code}/refund`, { idempotencyKey: key, amount: 500, reason: 'goodwill' });
		expect(replay.refundId).toBe(first.refundId);
		expect((await mock.nmiCalls()).filter((c) => c.type === 'refund' && c.amount === '5.00')).toHaveLength(1);
		const tooMuch = await api.raw('POST', `/orders/${placed.code}/refund`, { idempotencyKey: uniq('rf'), amount: placed.grandTotal });
		expect(tooMuch.status).toBe(409);
		await sentEmails(api, email, 'order-refund-confirmation', 1);
		expect(await readRows(api, `SELECT 1 FROM email_outbox WHERE recipient = $1 AND kind = 'order-refund-confirmation'`, [email])).toHaveLength(1);
	});
});

test.describe('#5 partial fulfillment with tracking + notify', () => {
	// The merchant's endpoint (created in global setup): a public-looking address the API reaches via the preload's
	// reroute to the mock receiver. Its signing secret is handed over through the environment.
	const hookSecret = () => process.env.E2E_HOOK_SECRET!;

	test('ship one of two lines with tracking and notify -> signed order.shipped webhook delivered + shipping email sent; the rest ships later', async ({ api }) => {
		const email = `${uniq('ship')}@example.net`;
		await ensureCustomer(api, email); // the shipping email goes to the customer record (see the guest test below)
		const base = { shirt: await api.stock(SKU.shirt), mug: await api.stock(SKU.mug) };
		const placed = await paidOrder({ email, items: [{ sku: SKU.shirt, quantity: 1 }, { sku: SKU.mug, quantity: 1 }] });
		const lines = (await api.order(placed.code)).lines as OrderLine[];
		const shirt = lines.find((l) => l.sku === SKU.shirt)!;
		const mug = lines.find((l) => l.sku === SKU.mug)!;

		const tracking = `1ZE2E${Date.now().toString(36).toUpperCase()}`;
		await api.post(`/orders/${placed.code}/fulfillments`, { lines: [{ orderLineId: shirt.id, quantity: 1 }], trackingCode: tracking, carrier: 'UPS', notifyCustomer: true });

		const partly = await api.order(placed.code);
		expect(partly.fulfillmentStatus).toBe('partially_fulfilled');
		expect(partly.fulfillments).toHaveLength(1);
		expect(partly.fulfillments[0]).toMatchObject({ state: 'Shipped', trackingCode: tracking, carrier: 'UPS' });
		// Live stock: the shipped shirt left the shelf (on-hand -1, allocation -1); the unshipped mug is still allocated.
		expect(await api.stock(SKU.shirt)).toMatchObject({ onHand: base.shirt.onHand - 1, allocated: base.shirt.allocated });
		expect(await api.stock(SKU.mug)).toMatchObject({ onHand: base.mug.onHand, allocated: base.mug.allocated + 1 });

		// Webhook: delivered to the receiver, signed with the endpoint secret, carrying the shipment.
		const delivered = await eventually(async () => (await mock.hooks()).find((h) => JSON.parse(h.body).payload?.code === placed.code), 'order.shipped delivery at the receiver');
		expect(delivered.headers['x-sr-topic']).toBe('order.shipped');
		expect(delivered.headers['x-sr-signature']).toBe(createHmac('sha256', hookSecret()).update(delivered.body).digest('hex'));
		expect(JSON.parse(delivered.body)).toMatchObject({ topic: 'order.shipped', payload: { code: placed.code, trackingCode: tracking, carrier: 'UPS', partial: true } });
		await eventually(async () => (await readRows<{ status: string }>(api, `SELECT status FROM webhook_delivery WHERE topic = 'order.shipped' AND payload->>'code' = $1`, [placed.code])).every((r) => r.status === 'delivered'), 'webhook_delivery rows marked delivered');

		// Email: queued -> sent -> in the sink, naming the tracking number.
		await sentEmails(api, email, 'shipping_notification', 1);
		const mail = await eventually(async () => (await mock.mails()).find((m) => m.envelopeTo.includes(email) && (m.text + m.html).includes(tracking)), 'shipping email with the tracking number');
		expect(mail.subject).toContain(placed.code);

		// The remaining line ships later: a second webhook, no second email (notify off), order fully fulfilled.
		await api.post(`/orders/${placed.code}/fulfillments`, { lines: [{ orderLineId: mug.id, quantity: 1 }], trackingCode: `${tracking}B`, carrier: 'UPS', notifyCustomer: false });
		await eventually(async () => (await mock.hooks()).filter((h) => JSON.parse(h.body).payload?.code === placed.code).length === 2, 'second order.shipped delivery');
		expect((await api.order(placed.code)).fulfillmentStatus).toBe('fulfilled');
		expect(await readRows(api, `SELECT 1 FROM email_outbox WHERE recipient = $1 AND kind = 'shipping_notification'`, [email])).toHaveLength(1);
		expect(await api.stock(SKU.mug)).toMatchObject({ onHand: base.mug.onHand - 1, allocated: base.mug.allocated });
	});

	test('a failing receiver does not lose the event: the delivery is retried, never marked delivered, and no shipment is rolled back', async ({ api }) => {
		const email = `${uniq('shipfail')}@example.net`;
		const placed = await paidOrder({ email, items: [{ sku: SKU.book, quantity: 1 }] });
		const line = ((await api.order(placed.code)).lines as OrderLine[])[0]!;
		await mock.failNextHooks(1);
		await api.post(`/orders/${placed.code}/fulfillments`, { lines: [{ orderLineId: line.id, quantity: 1 }], trackingCode: 'RETRY1', carrier: 'UPS', notifyCustomer: false });
		const attempted = await eventually(async () => (await mock.hooks()).find((h) => JSON.parse(h.body).payload?.code === placed.code), 'first delivery attempt (answered 500)');
		expect(attempted.path).toContain('/hook');
		await eventually(async () => {
			const rows = await readRows<{ status: string; attempts: number; last_error: string | null }>(api, `SELECT status, attempts, last_error FROM webhook_delivery WHERE payload->>'code' = $1`, [placed.code]);
			return rows.length === 1 && rows[0]!.status === 'pending' && rows[0]!.attempts === 1 && /500/.test(rows[0]!.last_error ?? '') ? rows : null;
		}, 'delivery parked for retry with the HTTP 500 recorded');
		expect((await api.order(placed.code)).fulfillmentStatus).toBe('fulfilled');
	});

	// PRODUCT GAP (found by this suite): the shipping email is only queued when the order has a customer record
	// (routes/admin.ts: `if (body.notifyCustomer && o.customerId)`), but a guest checkout leaves customerId null — the
	// address lives in order.metadata.contact.email, which the refund email already falls back to. Remove test.fail()
	// when the shipping path uses the same recipient fallback.
	test('KNOWN BUG: a guest order shipped with notify on should get a shipping email', async ({ api }) => {
		test.fail(true, 'shipping_notification is only enqueued for orders with customerId; guest checkouts have none');
		const email = `${uniq('shipguest')}@example.net`;
		const placed = await paidOrder({ email, items: [{ sku: SKU.book, quantity: 1 }] });
		const line = ((await api.order(placed.code)).lines as OrderLine[])[0]!;
		await api.post(`/orders/${placed.code}/fulfillments`, { lines: [{ orderLineId: line.id, quantity: 1 }], trackingCode: 'GUEST1', carrier: 'UPS', notifyCustomer: true });
		await sentEmails(api, email, 'shipping_notification', 1);
	});
});
