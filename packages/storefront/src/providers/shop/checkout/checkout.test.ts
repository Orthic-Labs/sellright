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

const adoptConflict = vi.fn();
const retire = vi.fn();
// placeOrder only ever sees the lock SCOPE its caller was handed — never the service. Its read throws: placeOrder must
// not read the cart a second time. (The real ConvertedCartError class is kept: placeOrder throws it.)
vi.mock('~/services/CartService', async (importOriginal) => ({
	...(await importOriginal<typeof import('~/services/CartService')>()),
	CartService: {
		checkoutSnapshot: () => { throw new Error('placeOrder must not read the cart a second time'); },
		readFresh: () => { throw new Error('placeOrder must not read the cart a second time'); },
		refresh: () => { throw new Error('placeOrder must not read the cart a second time'); },
	},
}));

import { ConvertedCartError, type CartLockScope } from '~/services/CartService';
import { __resetAnalyticsForTests, setAnalyticsConsent } from '~/sellright/analytics';
import { captureAttribution } from '~/sellright/attribution';
import { isOutOfStockConflict, placeOrder, settleZeroDueOrder, getOrder, getShopConfig, getEligibleShippingMethods, createPaymentIntent, startGatewayPayment, verifyGatewayPayment } from './checkout';

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

const snap = { token: 'tok_srv', revision: 5, status: 'active' };
const scope: CartLockScope = {
	readFresh: () => { throw new Error('placeOrder must not read the cart a second time'); },
	adoptConflict: (...a) => adoptConflict(...a),
	retire: (...a) => retire(...a),
};
const form = {
	email: 'a@b.c',
	shippingAddress: { fullName: 'A B', streetLine1: '1 St', city: 'X', postalCode: '1', countryCode: 'US' },
	shippingMethodCode: 'std',
	items: [{ sku: 'SKU1', quantity: 1 }],
};

beforeEach(() => {
	calls.length = 0;
	queue = [];
	adoptConflict.mockReset();
	retire.mockReset();
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
		const res = await placeOrder({ ...form, redeemPoints: 1000 }, snap, scope);
		expect(lastBody().redeemPoints).toBe(1000);
		expect(res.pointsDiscount).toBe(1000);

		enqueue(respond(200, { code: 'OQ', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_q' }));
		await placeOrder({ ...form, redeemPoints: 0 }, snap, scope);
		expect(lastBody()).not.toHaveProperty('redeemPoints');
	});

	it('sends cartToken + live revision + shippingMethodCode, server cart wins', async () => {
		enqueue(respond(200, { code: 'O1', state: 'PendingPayment', grandTotal: 5800, receiptToken: 'rt_1' }));
		const res = await placeOrder(form, snap, scope);
		expect(calls[0].url).toContain('/v1/shop/checkout');
		const body = lastBody();
		expect(body.cartToken).toBe('tok_srv');
		expect(body.expectedRevision).toBe(5);
		expect(body.shippingMethodCode).toBe('std');
		expect(body.email).toBe('a@b.c');
		expect(res.code).toBe('O1');
		expect(res.receiptToken).toBe('rt_1');
	});

	it('sends the stored landing attribution with consent, and none without it', async () => {
		try {
			enqueue(respond(200, { code: 'OA', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_a' }));
			await placeOrder(form, snap, scope);
			expect(lastBody()).not.toHaveProperty('attribution');

			setAnalyticsConsent(true);
			captureAttribution('https://shop.test/products/tee/?utm_source=chatgpt&utm_medium=cpc&utm_campaign=rh_us_shirts_202610&utm_content=test&oppref=op1');
			enqueue(respond(200, { code: 'OB', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_b' }));
			await placeOrder(form, snap, scope);
			expect(lastBody().attribution).toEqual({ utm_source: 'chatgpt', utm_medium: 'cpc', utm_campaign: 'rh_us_shirts_202610', utm_content: 'test', oppref: 'op1' });

			setAnalyticsConsent(false);
			enqueue(respond(200, { code: 'OC', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_c' }));
			await placeOrder(form, snap, scope);
			expect(lastBody()).not.toHaveProperty('attribution');
		} finally {
			__resetAnalyticsForTests();
			sessionStorage.clear();
		}
	});

	it('sends the bootstrap line and the snapshot token/revision when the form has no items', async () => {
		enqueue(respond(200, { code: 'O0', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_0' }));
		await placeOrder({ items: [] }, snap, scope);
		const body = lastBody();
		expect(body.items).toEqual([{ sku: '__cart__', quantity: 1 }]);
		expect(body.cartToken).toBe('tok_srv');
		expect(body.expectedRevision).toBe(5);
	});

	it('uses exactly the snapshot it is given — no second cart read, never a tokenless submit', async () => {
		enqueue(respond(200, { code: 'O0b', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_0b' }));
		await placeOrder(form, { token: 'tok_other', revision: 12, status: 'active' }, scope);
		expect(calls).toHaveLength(1); // only the POST; the mocked CartService throws on any read
		expect(lastBody().cartToken).toBe('tok_other');
		expect(lastBody().expectedRevision).toBe(12);
	});

	it('refuses to submit without a usable snapshot (missing, no token, non-numeric revision)', async () => {
		for (const bad of [undefined, null, { token: '', revision: 1, status: 'active' }, { token: 't', revision: undefined, status: 'active' }]) {
			await expect(placeOrder(form, bad as never, scope)).rejects.toThrow(/could not be verified/);
		}
		expect(calls).toHaveLength(0);
	});

	it('a converted snapshot is never POSTed: ConvertedCartError, no request, nothing retired', async () => {
		const outcome = await placeOrder(form, { token: 'tok_srv', revision: 6, status: 'converted' }, scope).catch((e) => e);
		expect(outcome).toBeInstanceOf(ConvertedCartError);
		expect(calls).toHaveLength(0);
		expect(retire).not.toHaveBeenCalled();
		expect(adoptConflict).not.toHaveBeenCalled();
	});

	it('after a stale conflict the next attempt needs a new snapshot: the old revision is not resent by the module', async () => {
		const conflictCart = { token: 'tok_srv', revision: 9, status: 'active', currency: 'USD', subtotal: 0, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 0, unavailable: [], coupon: null, lines: [], email: null, customerId: null };
		enqueue(respond(409, { error: { code: 'CART_STALE', message: 'cart changed' }, code: 'stale', revision: 9, cart: conflictCart }), respond(200, { code: 'OS', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_s' }));
		await expect(placeOrder(form, snap, scope)).rejects.toThrow('cart changed');
		await placeOrder(form, { token: 'tok_srv', revision: 9, status: 'active' }, scope); // caller re-validated with a fresh read
		expect((calls[1].body as Record<string, unknown>).expectedRevision).toBe(9);
	});

	it('reuses one Idempotency-Key across retries of the same attempt', async () => {
		enqueue(respond(500, { error: { code: 'UNKNOWN_ERROR', message: 'blip' } }), respond(200, { code: 'O2', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_2' }));
		await placeOrder(form, snap, scope).catch(() => {});
		await placeOrder(form, snap, scope);
		const keys = calls.map((c) => c.headers.get('idempotency-key'));
		expect(keys[0]).toBeTruthy();
		expect(keys[0]).toBe(keys[1]);
	});

	it('rotates the key only on payload_mismatch', async () => {
		enqueue(respond(409, { error: { code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', message: 'mismatch' }, reason: 'payload_mismatch' }), respond(200, { code: 'O3', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_3' }));
		await placeOrder(form, snap, scope).catch(() => {});
		await placeOrder(form, snap, scope);
		const keys = calls.map((c) => c.headers.get('idempotency-key'));
		expect(keys[0]).toBeTruthy();
		expect(keys[1]).toBeTruthy();
		expect(keys[1]).not.toBe(keys[0]);
	});

	it('does NOT rotate the key for an unrelated 409 (e.g. out of stock)', async () => {
		enqueue(respond(409, { error: { code: 'OUT_OF_STOCK', message: 'SKU1 is out of stock' }, skus: ['SKU1'] }), respond(200, { code: 'O3b', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_3b' }));
		await expect(placeOrder(form, snap, scope)).rejects.toThrow('SKU1 is out of stock');
		await placeOrder(form, snap, scope);
		const keys = calls.map((c) => c.headers.get('idempotency-key'));
		expect(keys[1]).toBe(keys[0]);
	});

	it('marks an OUT_OF_STOCK refusal (and only that) so the caller re-reads live stock', async () => {
		enqueue(respond(409, { error: { code: 'OUT_OF_STOCK', message: 'SKU1 is out of stock' }, skus: ['SKU1'] }), respond(409, { error: { code: 'CART_STALE', message: 'cart changed' }, reason: 'payload_mismatch' }));
		const outOfStock = await placeOrder(form, snap, scope).catch((e) => e);
		expect(isOutOfStockConflict(outOfStock)).toBe(true);
		const other = await placeOrder(form, snap, scope).catch((e) => e);
		expect(isOutOfStockConflict(other)).toBe(false);
		expect(isOutOfStockConflict(new Error('SKU1 is out of stock'))).toBe(false);
		expect(isOutOfStockConflict(undefined)).toBe(false);
	});

	it('stale-cart conflict adopts the server snapshot and tells the shopper to review', async () => {
		const conflictCart = { token: 'tok_srv', revision: 9, status: 'active', currency: 'USD', subtotal: 0, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 0, unavailable: [], coupon: null, lines: [], email: null, customerId: null };
		enqueue(respond(409, { error: { code: 'CART_STALE', message: 'cart changed' }, code: 'stale', revision: 9, cart: conflictCart }));
		await expect(placeOrder(form, snap, scope)).rejects.toThrow('cart changed');
		expect(adoptConflict).toHaveBeenCalledWith(conflictCart, 'tok_srv'); // bound to the submitted token
		expect(retire).not.toHaveBeenCalled();
	});

	it('revision_required conflict adopts the snapshot the same way as stale', async () => {
		const conflictCart = { token: 'tok_srv', revision: 1, status: 'active', currency: 'USD', subtotal: 0, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 0, unavailable: [], coupon: null, lines: [], email: null, customerId: null };
		enqueue(respond(409, { error: { code: 'REVISION_REQUIRED', message: 'revision required' }, code: 'revision_required', revision: 1, cart: conflictCart }));
		await expect(placeOrder(form, snap, scope)).rejects.toThrow('review it and try again');
		expect(adoptConflict).toHaveBeenCalledWith(conflictCart, 'tok_srv');
	});

	it('converted conflict KEEPS the token: the snapshot is adopted for the submitted token and a ConvertedCartError is thrown', async () => {
		const conflictCart = { token: 'tok_srv', revision: 2, status: 'converted', currency: 'USD', subtotal: 0, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 0, unavailable: [], coupon: null, lines: [], email: null, customerId: null };
		enqueue(respond(409, { error: { code: 'CART_STALE', message: 'cart already converted' }, code: 'converted', revision: 2, cart: conflictCart }));
		const outcome = await placeOrder(form, snap, scope).catch((e) => e);
		expect(outcome).toBeInstanceOf(ConvertedCartError);
		expect(outcome.message).toBe('cart already converted');
		expect(adoptConflict).toHaveBeenCalledWith(conflictCart, 'tok_srv');
		expect(retire).not.toHaveBeenCalled();
	});

	it('merged conflict retires exactly the submitted token', async () => {
		const conflictCart = { token: 'tok_srv', revision: 2, status: 'merged', currency: 'USD', subtotal: 0, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 0, unavailable: [], coupon: null, lines: [], email: null, customerId: null };
		enqueue(respond(409, { error: { code: 'CART_STALE', message: 'cart merged' }, code: 'merged', revision: 2, cart: conflictCart }));
		await expect(placeOrder(form, snap, scope)).rejects.toThrow('cart merged');
		expect(retire).toHaveBeenCalledWith('tok_srv');
		expect(adoptConflict).not.toHaveBeenCalled();
	});

	it('merged local snapshot refuses to place — no double submit of moved lines', async () => {
		await expect(placeOrder(form, { token: 'tok_srv', revision: 5, status: 'merged' }, scope)).rejects.toThrow('merged');
		expect(retire).toHaveBeenCalledWith('tok_srv');
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
		enqueue(respond(400, { error: { code: 'ORDER_ALREADY_PAID', message: 'Already covered' }, state: 'Paid' }));
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

describe('startGatewayPayment → POST /v1/shop/orders/{code}/gateway-payment', () => {
	it('nmi: sends the Collect.js token + Idempotency-Key header, no x-receipt-token when omitted', async () => {
		enqueue(respond(200, { attemptId: '11111111-1111-1111-1111-111111111111', status: 'settled' }));
		const res = await startGatewayPayment('O1', 'nmi', { token: 'tok_collectjs', idempotencyKey: 'idem-1' });
		expect(calls[0].url).toContain('/v1/shop/orders/O1/gateway-payment');
		expect(calls[0].body).toEqual({ method: 'nmi', token: 'tok_collectjs' });
		expect(calls[0].headers.get('idempotency-key')).toBe('idem-1');
		expect(calls[0].headers.has('x-receipt-token')).toBe(false);
		expect(res.status).toBe('settled');
	});

	it('sezzle: sends no token, returns the hosted checkoutUrl, forwards x-receipt-token when given', async () => {
		enqueue(respond(200, { attemptId: '22222222-2222-2222-2222-222222222222', status: 'pending', checkoutUrl: 'https://pay.example/session/abc' }));
		const res = await startGatewayPayment('O1', 'sezzle', { idempotencyKey: 'idem-2', receiptToken: 'rt_1' });
		expect(calls[0].body).toEqual({ method: 'sezzle' });
		expect(calls[0].headers.get('x-receipt-token')).toBe('rt_1');
		expect(res.checkoutUrl).toBe('https://pay.example/session/abc');
	});
});

describe('verifyGatewayPayment → POST /v1/shop/orders/{code}/gateway-payment/{attempt}/verify', () => {
	it('reconciles a Sezzle return by attempt id, forwarding the receipt token', async () => {
		enqueue(respond(200, { attemptId: '22222222-2222-2222-2222-222222222222', status: 'settled' }));
		const res = await verifyGatewayPayment('O1', '22222222-2222-2222-2222-222222222222', 'rt_1');
		expect(calls[0].url).toContain('/v1/shop/orders/O1/gateway-payment/22222222-2222-2222-2222-222222222222/verify');
		expect(calls[0].headers.get('x-receipt-token')).toBe('rt_1');
		expect(res.status).toBe('settled');
	});
});

describe('shipping quote is the server\'s, from the cart', () => {
	it('POSTs the cart items, country and coupons, and sends no subtotal', async () => {
		enqueue(respond(200, { methods: [{ code: 'free-shipping', name: 'Free Shipping', rate: 0, price: 0 }] }));
		const methods = await getEligibleShippingMethods('us', [{ sku: 'S1', quantity: 2 }, { sku: 'S2', quantity: 0 }], ['SAVE10']);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toContain('/v1/shop/shipping-methods');
		expect(calls[0].method).toBe('POST');
		expect(lastBody()).toEqual({ country: 'US', items: [{ sku: 'S1', quantity: 2 }], couponCodes: ['SAVE10'] });
		expect(methods.map((m) => m.code)).toEqual(['free-shipping']);
	});

	it('an empty cart or no country asks the server nothing', async () => {
		expect(await getEligibleShippingMethods('US', [])).toEqual([]);
		expect(await getEligibleShippingMethods('', [{ sku: 'S1', quantity: 1 }])).toEqual([]);
		expect(calls).toHaveLength(0);
	});
});

// An HTTP 204 or a JSON `null` body is a FAILED read for every call checkout depends on — never a value to read fields
// from (a null order used to throw outside the guarded read and strand the payment recovery with controls locked).
describe('empty response bodies are failed reads', () => {
	const noContent = () => Promise.resolve(new Response(null, { status: 204 }));
	const reads: [string, () => Promise<unknown>][] = [
		['getOrder', () => getOrder('O1', 'rt_1')],
		['getShopConfig', () => getShopConfig()],
		['getEligibleShippingMethods', () => getEligibleShippingMethods('US', [{ sku: 'S1', quantity: 1 }])],
		['createPaymentIntent', () => createPaymentIntent('O1')],
		['settleZeroDueOrder', () => settleZeroDueOrder('O1')],
		['startGatewayPayment', () => startGatewayPayment('O1', 'nmi', { token: 't', idempotencyKey: 'k' })],
		['verifyGatewayPayment', () => verifyGatewayPayment('O1', '11111111-1111-1111-1111-111111111111')],
	];
	for (const [name, call] of reads) {
		it(`${name} rejects on HTTP 204`, async () => {
			enqueue(noContent());
			await expect(call()).rejects.toThrow(/Empty .* response/);
		});
		it(`${name} rejects on a JSON null body`, async () => {
			enqueue(respond(200, null));
			await expect(call()).rejects.toThrow(/Empty .* response/);
		});
	}
});

// #362: one config read per page in the browser — widgets on one page share it; a new page or a failed read asks again.
describe('getShopConfig shares one read per page', () => {
	const cfg = { stripeMode: 'test', stripePublishableKey: null, stripeConfigured: false, gateways: { nmi: null, sezzle: false }, loyalty: null, auth: { magicLink: false, passkeys: false, googleClientId: null, appleServicesId: null } };
	afterEach(() => window.history.replaceState(null, '', '/'));

	it('concurrent and later callers on the same page get the same read', async () => {
		window.history.replaceState(null, '', '/products/share-a/');
		enqueue(respond(200, cfg));
		const [a, b] = await Promise.all([getShopConfig(), getShopConfig()]);
		expect(await getShopConfig()).toBe(a);
		expect(b).toBe(a);
		expect(calls.filter((c) => c.url.includes('/v1/shop/config'))).toHaveLength(1);
	});

	it('a different page reads again', async () => {
		window.history.replaceState(null, '', '/products/share-b/');
		enqueue(respond(200, cfg), respond(200, cfg));
		await getShopConfig();
		window.history.replaceState(null, '', '/checkout/');
		await getShopConfig();
		expect(calls.filter((c) => c.url.includes('/v1/shop/config'))).toHaveLength(2);
	});

	it('a failed read is not kept', async () => {
		window.history.replaceState(null, '', '/products/share-c/');
		enqueue(respond(500, { error: 'down' }), respond(200, cfg));
		await expect(getShopConfig()).rejects.toThrow();
		await Promise.resolve();
		await expect(getShopConfig()).resolves.toEqual(cfg);
		expect(calls.filter((c) => c.url.includes('/v1/shop/config'))).toHaveLength(2);
	});
});
