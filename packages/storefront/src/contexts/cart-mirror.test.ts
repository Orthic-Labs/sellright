/**
 * CartContext must follow the CartService mirror after CLASSIFIED FAILURES too: the service's error boundary changes
 * the mirror (installs a converted snapshot, retires a missing cart) and then throws, so a context that only copied the
 * mirror after a successful operation would keep an active cart on screen. Real CartService; only `fetch` and
 * `navigator.locks` are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CartError, CartService } from '~/services/CartService';
import { installLocks, removeLocks } from '~/services/cart-test-harness';
import { EMPTY_CART, type Cart, type ServerCart } from '~/sellright/types/cart';
import { decideCheckoutEntry } from '~/hooks/checkout-stage';
import { bindCartMirror, commitMirror, isDefinitiveCartFailure, totalQuantityOf } from './cart-mirror';

let queue: Promise<Response>[] = [];
const respond = (status: number, body: unknown) =>
	Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const serverCart = (over: Partial<ServerCart> = {}): ServerCart => ({
	token: 'tok_srv',
	revision: 4,
	status: 'active',
	currency: 'USD',
	subtotal: 5000,
	discountTotal: 0,
	shippingTotal: 0,
	taxTotal: 0,
	grandTotal: 5000,
	unavailable: [],
	coupon: null,
	couponCodes: [],
	coupons: [],
	email: null,
	customerId: null,
	lines: [{ sku: 'SKU1', name: 'Widget', quantity: 2, unitPrice: 2500, lineSubtotal: 5000, lineDiscount: 0, lineTotal: 5000, available: true, availableQuantity: 999 }],
	...over,
});
const setCookie = (v: string) => { document.cookie = `sr_cart=${v}; Path=/`; };
const clearCookie = () => { document.cookie = 'sr_cart=; Path=/; Max-Age=0'; };
const newContext = (): { cart: Cart } => ({ cart: EMPTY_CART });
const events: number[] = [];
const onEvent = (e: Event) => events.push((e as CustomEvent<{ totalQuantity: number }>).detail.totalQuantity);

beforeEach(() => {
	queue = [];
	events.length = 0;
	clearCookie();
	installLocks();
	CartService['resetMirror']();
	vi.stubGlobal('fetch', vi.fn(async () => {
		const next = queue.shift();
		if (!next) throw new Error('unstubbed fetch');
		return next;
	}));
	window.addEventListener('cart-updated', onEvent);
});

afterEach(() => {
	window.removeEventListener('cart-updated', onEvent);
	vi.unstubAllGlobals();
	removeLocks();
	clearCookie();
});

describe('cart context follows the service mirror', () => {
	it('after a converted 409 the context shows the converted cart, not the old active one', async () => {
		setCookie('tok_srv');
		const ctx = newContext();
		bindCartMirror(ctx);
		queue.push(respond(200, serverCart())); // cold-start revision read
		queue.push(respond(409, { error: { code: 'CART_STALE', message: 'converted' }, code: 'converted', revision: 4, cart: serverCart({ status: 'converted' }) }));

		await expect(CartService.updateLine('SKU1', 3)).rejects.toMatchObject({ code: 'converted' });

		expect(ctx.cart.status).toBe('converted');
		expect(ctx.cart).toBe(CartService.getCart());
	});

	it('after a CART_NOT_FOUND the context no longer shows the retired cart\'s lines', async () => {
		setCookie('tok_srv');
		const ctx = newContext();
		bindCartMirror(ctx);
		queue.push(respond(200, serverCart()));
		await CartService.refresh();
		expect(totalQuantityOf(ctx.cart)).toBe(2);

		queue.push(respond(404, { error: { code: 'CART_NOT_FOUND', message: 'cart not found' } }));
		await expect(CartService.refresh()).rejects.toMatchObject({ code: 'not_found' });

		expect(ctx.cart.lines).toHaveLength(0);
		expect(ctx.cart.token).toBe('');
		expect(events[events.length - 1]).toBe(0); // the badge is told too
	});

	it('commitMirror alone (the catch-path sync) repairs a context nobody notified', async () => {
		setCookie('tok_srv');
		const ctx = newContext(); // deliberately NOT bound
		queue.push(respond(200, serverCart()));
		await CartService.refresh();
		commitMirror(ctx);
		expect(ctx.cart.lines).toHaveLength(1);

		queue.push(respond(404, { error: { code: 'CART_NOT_FOUND', message: 'cart not found' } }));
		await expect(CartService.refresh()).rejects.toThrow();
		expect(ctx.cart.lines).toHaveLength(1); // stale: this is the failure mode the sync exists to close

		commitMirror(ctx);
		expect(ctx.cart.lines).toHaveLength(0);
	});

	it('announces the committed mirror\'s quantity on every change', async () => {
		setCookie('tok_srv');
		const ctx = newContext();
		bindCartMirror(ctx);
		queue.push(respond(200, serverCart()));
		await CartService.refresh();
		expect(events).toContain(2);
		expect(ctx.cart.lines[0]?.quantity).toBe(2);
	});

	it('binding again replaces the previous subscription (a single follower)', async () => {
		setCookie('tok_srv');
		const first = newContext();
		const second = newContext();
		bindCartMirror(first);
		bindCartMirror(second);
		queue.push(respond(200, serverCart()));
		await CartService.refresh();
		expect(second.cart.lines).toHaveLength(1);
		expect(first.cart).toBe(EMPTY_CART);
	});
});

describe('failed entry reads (a failure is not an answer)', () => {
	it('only classified outcomes are definitive; network, timeout, 5xx and other 404s are not', () => {
		for (const code of ['not_found', 'merged', 'converted']) expect(isDefinitiveCartFailure(new CartError(code, 'x'))).toBe(true);
		expect(isDefinitiveCartFailure(new CartError('conflict', 'x'))).toBe(false);
		expect(isDefinitiveCartFailure(new CartError(undefined, 'x'))).toBe(false);
		expect(isDefinitiveCartFailure(new TypeError('network down'))).toBe(false);
	});

	it('a network failure on the live read leaves the token and mirror untouched (nothing to infer an empty/active cart from)', async () => {
		setCookie('tok_srv');
		const ctx = newContext();
		bindCartMirror(ctx);
		queue.push(Promise.reject(new TypeError('network down')));
		const err = await CartService.refresh().catch((e) => e);
		expect(isDefinitiveCartFailure(err)).toBe(false);
		expect(document.cookie).toContain('sr_cart=tok_srv');
		expect(ctx.cart.status).toBe(EMPTY_CART.status);
	});

	it('a converted cart whose live read fails can still be looked up read-only (resume needs no repricing)', async () => {
		setCookie('tok_srv');
		queue.push(Promise.reject(new TypeError('network down'))); // GET /cart/{token}
		queue.push(respond(200, { code: 'ORD-A', state: 'PendingPayment', grandTotal: 5800, receiptToken: 'rt_a', currency: 'USD' }));
		await expect(CartService.refresh()).rejects.toBeDefined();
		const lookup = await CartService.lookupConvertedCheckout('tok_srv');
		expect(lookup).toMatchObject({ ok: true, order: { code: 'ORD-A', state: 'PendingPayment' } });
		expect(document.cookie).toContain('sr_cart=tok_srv');
	});
});

describe('an empty cart response is an ambiguous failure, not a missing cart', () => {
	for (const [label, response] of [
		['HTTP 204', () => Promise.resolve(new Response(null, { status: 204 }))],
		['JSON null', () => respond(200, null)],
	] as const) {
		it(`${label} on the live read: not definitive, token and mirror kept, entry never picks the normal checkout`, async () => {
			setCookie('tok_srv');
			queue.push(response());
			const err = await CartService.refresh().catch((e) => e);
			expect(err).toBeInstanceOf(CartError);
			expect(err.code).toBe('empty_response');
			expect(isDefinitiveCartFailure(err)).toBe(false);
			expect(document.cookie).toContain('sr_cart=tok_srv');
			// refreshCartLive reports this as 'failed' -> a token with a failed read is probed, never "normal".
			expect(decideCheckoutEntry({ status: CartService.getCart().status, readFailed: !isDefinitiveCartFailure(err), hasToken: true })).toBe('probe');
		});
	}

	it('only the typed CART_NOT_FOUND stays definitive', async () => {
		setCookie('tok_srv');
		queue.push(respond(404, { error: { code: 'CART_NOT_FOUND', message: 'gone' } }));
		const err = await CartService.refresh().catch((e) => e);
		expect(isDefinitiveCartFailure(err)).toBe(true);
	});
});
