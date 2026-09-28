/**
 * Checkout provider contract — POST /v1/shop/checkout via the native
 * `sellright()` typed client: server-cart token + live revision, the
 * selected shippingMethodCode, one Idempotency-Key per attempt (reused
 * across retries of the SAME attempt, rotated only on payload_mismatch),
 * conflict adoption, and the merged-cart double-submit guard. Also covers
 * the zero-due settle path and the order read used by confirmation +
 * error-recovery. Global `fetch` is stubbed; nothing hits a real network.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const snapshot = vi.fn();
const adoptConflictCart = vi.fn();
const discardLocal = vi.fn();
vi.mock('~/services/ServerCartService', () => ({
	ServerCartService: {
		checkoutSnapshot: (...a: unknown[]) => snapshot(...a),
		adoptConflictCart: (...a: unknown[]) => adoptConflictCart(...a),
		discardLocal: (...a: unknown[]) => discardLocal(...a),
	},
}));

import { placeOrder, settleZeroDueOrder, getOrder, createPaymentIntent } from './checkout';

// `sellright()` (openapi-fetch + the transport middleware in
// src/sellright/client.ts) invokes the platform `fetch` as `fetch(request)`
// with a single `Request` instance — never the legacy `fetch(url, init)`
// tuple. Capture calls by reading the Request itself.
type FetchCall = { url: string; method: string; headers: Headers; body: unknown };
const calls: FetchCall[] = [];
let queue: Promise<Response>[] = [];
const respond = (status: number, body: unknown) =>
	Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const enqueue = (...r: Promise<Response>[]) => queue.push(...r);

const form = {
	email: 'a@b.c',
	shippingAddress: { fullName: 'A B', streetLine1: '1 St', city: 'X', postalCode: '1', countryCode: 'US' },
	shippingMethodCode: 'std',
	items: [{ sku: 'SKU1', quantity: 1 }],
};

beforeEach(() => {
	calls.length = 0;
	queue = [];
	snapshot.mockReset().mockResolvedValue({ token: 'tok_srv', revision: 5, status: 'active' });
	adoptConflictCart.mockReset();
	discardLocal.mockReset();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (request: Request) => {
			const bodyText = await request.clone().text().catch(() => '');
			calls.push({
				url: request.url,
				method: request.method,
				headers: request.headers,
				body: bodyText ? JSON.parse(bodyText) : undefined,
			});
			const next = queue.shift();
			if (!next) throw new Error(`unstubbed fetch: ${request.method} ${request.url}`);
			return next;
		}),
	);
});

afterEach(() => vi.unstubAllGlobals());

const lastBody = () => calls[calls.length - 1].body as Record<string, unknown>;

describe('placeOrder → POST /v1/shop/checkout', () => {
	it('forwards redeemPoints only when points are being spent', async () => {
		enqueue(respond(200, { code: 'OP', state: 'PendingPayment', grandTotal: 9900, receiptToken: 'rt_p', pointsRedeemed: 1000, pointsDiscount: 1000 }));
		const res = await placeOrder({ ...form, redeemPoints: 1000 });
		expect(lastBody().redeemPoints).toBe(1000);
		expect(res.pointsDiscount).toBe(1000);

		enqueue(respond(200, { code: 'OQ', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_q' }));
		await placeOrder({ ...form, redeemPoints: 0 });
		expect(lastBody()).not.toHaveProperty('redeemPoints');
	});

	it('sends cartToken + live revision + shippingMethodCode, server cart wins', async () => {
		enqueue(respond(200, { code: 'O1', state: 'PendingPayment', grandTotal: 5800, receiptToken: 'rt_1' }));
		const res = await placeOrder(form);
		expect(calls[0].url).toContain('/v1/shop/checkout');
		const body = lastBody();
		expect(body.cartToken).toBe('tok_srv');
		expect(body.expectedRevision).toBe(5);
		expect(body.shippingMethodCode).toBe('std');
		expect(body.email).toBe('a@b.c');
		expect(res.code).toBe('O1');
		expect(res.receiptToken).toBe('rt_1');
	});

	it('falls back to a bootstrap line when there is no cart token', async () => {
		snapshot.mockResolvedValueOnce(null);
		enqueue(respond(200, { code: 'O0', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_0' }));
		await placeOrder({ items: [] });
		const body = lastBody();
		expect(body.items).toEqual([{ sku: '__cart__', quantity: 1 }]);
		expect(body).not.toHaveProperty('cartToken');
	});

	it('reuses one Idempotency-Key across retries of the same attempt', async () => {
		enqueue(respond(500, { error: 'blip' }), respond(200, { code: 'O2', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_2' }));
		await placeOrder(form).catch(() => {});
		await placeOrder(form);
		const keys = calls.map((c) => c.headers.get('idempotency-key'));
		expect(keys[0]).toBeTruthy();
		expect(keys[0]).toBe(keys[1]);
	});

	it('rotates the key only on payload_mismatch', async () => {
		enqueue(respond(409, { error: 'mismatch', reason: 'payload_mismatch' }), respond(200, { code: 'O3', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_3' }));
		await placeOrder(form).catch(() => {});
		await placeOrder(form);
		const keys = calls.map((c) => c.headers.get('idempotency-key'));
		expect(keys[0]).toBeTruthy();
		expect(keys[1]).toBeTruthy();
		expect(keys[1]).not.toBe(keys[0]);
	});

	it('does NOT rotate the key for an unrelated 409 (e.g. out of stock)', async () => {
		enqueue(respond(409, { error: 'SKU1 is out of stock', skus: ['SKU1'] }), respond(200, { code: 'O3b', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_3b' }));
		await expect(placeOrder(form)).rejects.toThrow('SKU1 is out of stock');
		await placeOrder(form);
		const keys = calls.map((c) => c.headers.get('idempotency-key'));
		expect(keys[1]).toBe(keys[0]);
	});

	it('stale-cart conflict adopts the server snapshot and tells the shopper to review', async () => {
		const conflictCart = { token: 'tok_srv', revision: 9, status: 'active', currency: 'USD', subtotal: 0, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 0, unavailable: [], coupon: null, lines: [], email: null, customerId: null };
		enqueue(respond(409, { error: 'cart changed', code: 'stale', revision: 9, cart: conflictCart }));
		await expect(placeOrder(form)).rejects.toThrow('cart changed');
		expect(adoptConflictCart).toHaveBeenCalledWith(conflictCart);
		expect(discardLocal).not.toHaveBeenCalled();
	});

	it('revision_required conflict adopts the snapshot the same way as stale', async () => {
		const conflictCart = { token: 'tok_srv', revision: 1, status: 'active', currency: 'USD', subtotal: 0, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 0, unavailable: [], coupon: null, lines: [], email: null, customerId: null };
		enqueue(respond(409, { error: 'revision required', code: 'revision_required', revision: 1, cart: conflictCart }));
		await expect(placeOrder(form)).rejects.toThrow('review it and try again');
		expect(adoptConflictCart).toHaveBeenCalledWith(conflictCart);
	});

	it('converted/merged conflict discards the local mirror instead of adopting', async () => {
		const conflictCart = { token: 'tok_srv', revision: 2, status: 'converted', currency: 'USD', subtotal: 0, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 0, unavailable: [], coupon: null, lines: [], email: null, customerId: null };
		enqueue(respond(409, { error: 'cart already converted', code: 'converted', revision: 2, cart: conflictCart }));
		await expect(placeOrder(form)).rejects.toThrow('cart already converted');
		expect(discardLocal).toHaveBeenCalled();
		expect(adoptConflictCart).not.toHaveBeenCalled();
	});

	it('merged local snapshot refuses to place — no double submit of moved lines', async () => {
		snapshot.mockResolvedValueOnce({ token: 'tok_srv', revision: 5, status: 'merged' });
		await expect(placeOrder(form)).rejects.toThrow('merged');
		expect(discardLocal).toHaveBeenCalled();
		expect(calls).toHaveLength(0);
	});
});

describe('settleZeroDueOrder → POST /v1/shop/orders/{code}/pay', () => {
	it('settles with method stripe (the only tender this API exposes)', async () => {
		enqueue(respond(200, { code: 'O9', state: 'Paid', payment: 'settled' }));
		const res = await settleZeroDueOrder('O9');
		expect(calls[0].url).toContain('/v1/shop/orders/O9/pay');
		expect(lastBody()).toEqual({ method: 'stripe' });
		expect(res?.state).toBe('Paid');
	});

	it('treats "already covered" (400) as a no-op success, not an error', async () => {
		enqueue(respond(400, { error: 'Already covered', state: 'Paid' }));
		const res = await settleZeroDueOrder('O10');
		expect(res).toBeNull();
	});
});

describe('getOrder → GET /v1/shop/orders/{code}', () => {
	it('scopes the read with the receipt token', async () => {
		enqueue(respond(200, { code: 'O1', state: 'Paid', currency: 'USD', subtotal: 100, shippingTotal: 0, taxTotal: 0, discountTotal: 0, grandTotal: 100, placedAt: null, customerEmail: null, promotionCode: null, payments: [], fulfillments: [], lines: [] }));
		await getOrder('O1', 'rt_1');
		expect(calls[0].url).toContain('/v1/shop/orders/O1');
		expect(calls[0].url).toContain('rt=rt_1');
	});

	it('omits rt entirely for an authed-owner read', async () => {
		enqueue(respond(200, { code: 'O1', state: 'Paid', currency: 'USD', subtotal: 100, shippingTotal: 0, taxTotal: 0, discountTotal: 0, grandTotal: 100, placedAt: null, customerEmail: null, promotionCode: null, payments: [], fulfillments: [], lines: [] }));
		await getOrder('O1');
		expect(calls[0].url).not.toContain('rt=');
	});
});

describe('createPaymentIntent → POST /v1/shop/orders/{code}/payment-intent', () => {
	it('returns the client secret for the Stripe Payment Element', async () => {
		enqueue(respond(200, { clientSecret: 'pi_secret_123', intentId: 'pi_123' }));
		const res = await createPaymentIntent('O1');
		expect(calls[0].url).toContain('/v1/shop/orders/O1/payment-intent');
		expect(res.clientSecret).toBe('pi_secret_123');
	});
});
