/**
 * Pre-submit stock check against the REAL CartService (only `fetch` and `navigator.locks` are faked). The check must
 * validate the exact response of its own read. Cart operations are serialised by the cart lock, so a read issued
 * while the pre-submit read is pending is sent only after it lands and can neither supply nor excuse its verdict; a
 * missing cookie, 404 or failed read must refuse. No cache, debounce or TTL is involved anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CartService } from '~/services/CartService';
import { installLocks, removeLocks } from '~/services/cart-test-harness';
import type { ServerCart } from '~/sellright/types/cart';
import { PreSubmitStockError, refreshStockBeforeSubmit } from './pre-submit-stock';

const respond = (status: number, body: unknown) =>
	Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const deferred = () => {
	let resolve!: (r: Response) => void;
	const promise = new Promise<Response>((r) => { resolve = r; });
	return { promise, resolve };
};
const serverCart = (over: Partial<ServerCart> = {}, available = true): ServerCart => ({
	token: 'tok_srv',
	revision: 1,
	status: 'active',
	currency: 'USD',
	subtotal: 2500,
	discountTotal: 0,
	shippingTotal: 0,
	taxTotal: 0,
	grandTotal: 2500,
	unavailable: [],
	coupon: null,
	email: null,
	customerId: null,
	lines: [{ sku: 'SKU1', name: 'Widget', quantity: 1, unitPrice: 2500, lineSubtotal: 2500, lineDiscount: 0, lineTotal: 2500, available, availableQuantity: available ? 5 : 0 }],
	...over,
});
const setCookie = (v: string) => { document.cookie = `sr_cart=${v}; Path=/`; };
const clearCookie = () => { document.cookie = 'sr_cart=; Path=/; Max-Age=0'; };

let queue: Promise<Response>[] = [];
let fetchCount = 0;

beforeEach(() => {
	queue = [];
	fetchCount = 0;
	clearCookie();
	installLocks();
	CartService['resetMirror']();
	vi.stubGlobal('fetch', vi.fn(async () => {
		fetchCount++;
		const next = queue.shift();
		if (!next) throw new Error('unstubbed fetch');
		return next;
	}));
});
afterEach(() => {
	vi.unstubAllGlobals();
	removeLocks();
	clearCookie();
});

describe('pre-submit stock check against the real CartService', () => {
	it('passes when the fresh response has every line available', async () => {
		setCookie('tok_srv');
		queue.push(respond(200, serverCart()));
		await expect(refreshStockBeforeSubmit()).resolves.toEqual({ token: 'tok_srv', revision: 1, status: 'active' });
		expect(fetchCount).toBe(1);
	});

	it('refuses on its own out-of-stock response even though the mirror held in-stock lines; a read issued meanwhile waits for it', async () => {
		setCookie('tok_srv');
		queue.push(respond(200, serverCart())); // seed the mirror: in stock
		await CartService.refresh();
		expect(CartService.validateStock().valid).toBe(true);

		const preSubmit = deferred();
		const overlapping = deferred();
		queue.push(preSubmit.promise, overlapping.promise);
		const submit = refreshStockBeforeSubmit();
		const submitOutcome = submit.then(() => 'passed', (e) => e);
		await vi.waitFor(() => expect(fetchCount).toBe(2));
		const overlap = CartService.refresh(); // queued behind the pre-submit read
		await new Promise((r) => setTimeout(r, 10));
		expect(fetchCount).toBe(2); // not sent while the pre-submit read holds the lock

		preSubmit.resolve(await respond(200, serverCart({}, false))); // fresh, out of stock
		const outcome = await submitOutcome;
		expect(outcome).toBeInstanceOf(PreSubmitStockError);
		await vi.waitFor(() => expect(fetchCount).toBe(3));
		overlapping.resolve(await respond(200, serverCart({}, false)));
		await overlap;
	});

	it('refuses an empty active cart from the live response', async () => {
		setCookie('tok_srv');
		queue.push(respond(200, serverCart({ lines: [] })));
		await expect(refreshStockBeforeSubmit()).rejects.toBeInstanceOf(PreSubmitStockError);
	});

	it('returns the revision of the response it validated, not of a read issued meanwhile', async () => {
		setCookie('tok_srv');
		const preSubmit = deferred();
		const overlapping = deferred();
		queue.push(preSubmit.promise, overlapping.promise);
		const submit = refreshStockBeforeSubmit();
		await vi.waitFor(() => expect(fetchCount).toBe(1));
		const overlap = CartService.refresh(); // queued: sent only after the pre-submit read lands
		preSubmit.resolve(await respond(200, serverCart({ revision: 4 })));
		await expect(submit).resolves.toEqual({ token: 'tok_srv', revision: 4, status: 'active' });
		await vi.waitFor(() => expect(fetchCount).toBe(2));
		overlapping.resolve(await respond(200, serverCart({ revision: 9 })));
		await overlap;
		expect(CartService.getCart().revision).toBe(9); // the later read is the newer mirror; the snapshot above is unaffected
	});

	it('refuses when the cart cookie is missing, without any request', async () => {
		await expect(refreshStockBeforeSubmit()).rejects.toThrow(/expired/);
		expect(fetchCount).toBe(0);
	});

	it('refuses on a 404 and retires the local cart', async () => {
		setCookie('tok_srv');
		queue.push(respond(404, { error: { code: 'CART_NOT_FOUND', message: 'not found' } }));
		await expect(refreshStockBeforeSubmit()).rejects.toThrow(/expired/);
		expect(CartService.getCart().lines).toHaveLength(0);
	});

	it('refuses on a failed read (500) and on a network error', async () => {
		setCookie('tok_srv');
		queue.push(respond(500, { error: { code: 'BOOM', message: 'boom' } }));
		await expect(refreshStockBeforeSubmit()).rejects.toThrow();
		queue.push(Promise.reject(new TypeError('network down')));
		await expect(refreshStockBeforeSubmit()).rejects.toThrow();
	});

	it('converted-cart recovery still passes when that same response is converted with an unavailable last unit', async () => {
		setCookie('tok_srv');
		queue.push(respond(200, serverCart({ status: 'converted' }, false)));
		await expect(refreshStockBeforeSubmit()).resolves.toEqual({ token: 'tok_srv', revision: 1, status: 'converted' });
	});

	it('a converted read issued meanwhile does not excuse an active, out-of-stock pre-submit response', async () => {
		setCookie('tok_srv');
		const preSubmit = deferred();
		const overlapping = deferred();
		queue.push(preSubmit.promise, overlapping.promise);
		const outcome = refreshStockBeforeSubmit().then(() => 'passed', (e) => e);
		await vi.waitFor(() => expect(fetchCount).toBe(1));
		const overlap = CartService.refresh();
		preSubmit.resolve(await respond(200, serverCart({}, false)));
		expect(await outcome).toBeInstanceOf(PreSubmitStockError);
		await vi.waitFor(() => expect(fetchCount).toBe(2));
		overlapping.resolve(await respond(200, serverCart({ status: 'converted' }, false)));
		await overlap;
	});

	it('inside the checkout lock the scoped read is used and the lock is taken once (no deadlock)', async () => {
		setCookie('tok_srv');
		queue.push(respond(200, serverCart({ revision: 3 })));
		const snapshot = await CartService.withLock((scope) => refreshStockBeforeSubmit(scope));
		expect(snapshot).toEqual({ token: 'tok_srv', revision: 3, status: 'active' });
		expect(fetchCount).toBe(1);
	});
});
