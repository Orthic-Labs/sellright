/**
 * Consumer-contract tests for CartService — the single, server-owned cart.
 * Asserts the wire contract (blind append vs revisioned absolute set), the
 * 409-conflict retry-once behaviour, fail-closed stock reads, the dropped-
 * line notice, and the one-time legacy-cart migration. `fetch` is mocked;
 * jsdom supplies `document.cookie` + `localStorage`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CartService, CartError, COUPON_SUPERSEDED } from './CartService';
import { isLineAvailable, remainingQuantity, canRequestQuantity, type ServerCart, type ServerCartLine } from '~/sellright/types/cart';

// `~/sellright/client.ts` wraps server-side requests in a `new Request(...)`
// (the bounded-timeout path), so the mock must normalize both call shapes —
// `fetch(url, init)` and `fetch(request)` — into a plain { method, body }.
type FetchCall = { url: string; init: { method?: string; body?: string } };
const calls: FetchCall[] = [];
let queue: Promise<Response>[] = [];
const respond = (status: number, body: unknown) =>
	Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const enqueue = (...r: Promise<Response>[]) => queue.push(...r);

const serverCart = (over: Partial<ServerCart> = {}): ServerCart => ({
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
	lines: [{ sku: 'SKU1', name: 'Widget', quantity: 1, unitPrice: 2500, lineSubtotal: 2500, lineDiscount: 0, lineTotal: 2500, available: true, availableQuantity: 999 }],
	...over,
});

const setCookie = (v: string) => { document.cookie = `sr_cart=${v}; Path=/`; };
const clearCookie = () => { document.cookie = 'sr_cart=; Path=/; Max-Age=0'; };

beforeEach(() => {
	calls.length = 0;
	queue = [];
	clearCookie();
	try { localStorage.clear(); } catch { /* ignore */ }
	CartService.discard();
	vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
		let url: string;
		let method: string | undefined;
		let body: string | undefined;
		if (input instanceof Request) {
			url = input.url;
			method = input.method;
			body = input.body ? await input.clone().text() : undefined;
		} else {
			url = String(input);
			method = init?.method;
			body = typeof init?.body === 'string' ? init.body : undefined;
		}
		calls.push({ url, init: { method, body } });
		const next = queue.shift();
		if (!next) throw new Error(`unstubbed fetch: ${method ?? 'GET'} ${url}`);
		return next;
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
	clearCookie();
});

const patchCalls = () => calls.filter((c) => c.init.method === 'PATCH');

describe('addLine — blind append', () => {
	it('creates the cart lazily then appends without a revision', async () => {
		enqueue(
			respond(200, serverCart()), // POST /cart (ensureCart)
			respond(200, serverCart({ revision: 2, lines: [{ sku: 'SKU1', name: 'Widget', quantity: 2, unitPrice: 2500, lineSubtotal: 5000, lineDiscount: 0, lineTotal: 5000, available: true, availableQuantity: 999 }], subtotal: 5000 })), // PATCH lines
		);
		const res = await CartService.addLine('SKU1', 2);
		const create = calls.find((c) => c.url.endsWith('/v1/shop/cart'));
		expect(create?.init.method).toBe('POST');
		const patch = patchCalls()[0];
		expect(patch.url.replace(/^https?:\/\/[^/]+/, '')).toBe('/v1/shop/cart/tok_srv/lines');
		const body = JSON.parse(String(patch.init.body));
		expect(body).toEqual({ lines: [{ sku: 'SKU1', quantity: 2 }] });
		expect(body.expectedRevision).toBeUndefined();
		expect(res.cart.lines[0].quantity).toBe(2);
		expect(res.cart.subtotal).toBe(5000); // server-priced mirror wins
		expect(res.dropped).toEqual([]);
	});
});

describe('updateLine — revisioned absolute set', () => {
	it('echoes the live revision; quantity 0 removes and is not reported as dropped', async () => {
		setCookie('tok_srv');
		enqueue(
			respond(200, serverCart({ revision: 4 })), // GET (ensureRevision)
			respond(200, serverCart({ revision: 5, lines: [], subtotal: 0, grandTotal: 0 })), // PATCH set
		);
		const res = await CartService.updateLine('SKU1', 0);
		const get = calls.find((c) => !c.init.method || c.init.method === 'GET');
		expect(get?.url.replace(/^https?:\/\/[^/]+/, '')).toBe('/v1/shop/cart/tok_srv');
		const patch = patchCalls()[0];
		const body = JSON.parse(String(patch.init.body));
		expect(body.expectedRevision).toBe(4);
		expect(body.lines).toEqual([{ sku: 'SKU1', quantity: 0 }]);
		expect(res.cart.lines).toHaveLength(0);
		// The caller asked to remove SKU1 — it must not show up as "dropped".
		expect(res.dropped).toEqual([]);
	});

	it('on a 409 stale conflict, adopts the server snapshot and retries exactly once', async () => {
		setCookie('tok_srv');
		enqueue(
			respond(200, serverCart({ revision: 4 })), // GET (ensureRevision)
			respond(409, {
				error: { code: 'CART_STALE', message: 'cart changed' }, code: 'stale', revision: 6,
				cart: serverCart({ revision: 6, lines: [{ sku: 'SKU1', name: 'Widget', quantity: 3, unitPrice: 2400, lineSubtotal: 7200, lineDiscount: 0, lineTotal: 7200, available: true, availableQuantity: 999 }], subtotal: 7200 }),
			}),
			respond(200, serverCart({ revision: 7, lines: [{ sku: 'SKU1', name: 'Widget', quantity: 5, unitPrice: 2400, lineSubtotal: 12000, lineDiscount: 0, lineTotal: 12000, available: true, availableQuantity: 999 }], subtotal: 12000 })), // retry succeeds
		);
		const res = await CartService.updateLine('SKU1', 5);
		expect(patchCalls()).toHaveLength(2);
		const retryBody = JSON.parse(String(patchCalls()[1].init.body));
		expect(retryBody.expectedRevision).toBe(6); // retried with the conflict's fresh revision
		expect(res.cart.lines[0].quantity).toBe(5);
		expect(res.cart.subtotal).toBe(12000);
	});

	it('a second consecutive 409 does not retry again — surfaces a recoverable error', async () => {
		setCookie('tok_srv');
		enqueue(
			respond(200, serverCart({ revision: 4 })),
			respond(409, { error: { code: 'CART_STALE', message: 'stale' }, code: 'stale', revision: 6, cart: serverCart({ revision: 6 }) }),
			respond(409, { error: { code: 'CART_STALE', message: 'stale' }, code: 'stale', revision: 7, cart: serverCart({ revision: 7 }) }),
		);
		await expect(CartService.updateLine('SKU1', 5)).rejects.toThrow(/try again/);
		expect(patchCalls()).toHaveLength(2); // exactly one retry, never a loop
	});

	it('409 converted retires the token and cart outright', async () => {
		setCookie('tok_srv');
		enqueue(
			respond(200, serverCart({ revision: 4 })),
			respond(409, { error: { code: 'CART_STALE', message: 'converted' }, code: 'converted', revision: 4, cart: serverCart({ status: 'converted' }) }),
		);
		await expect(CartService.updateLine('SKU1', 2)).rejects.toThrow(/checked out/);
		expect(CartService.getCart().lines).toHaveLength(0);
		expect(document.cookie).not.toContain('sr_cart=tok_srv');
	});

	it('404 on refresh retires the local cart', async () => {
		setCookie('tok_srv');
		enqueue(respond(404, { error: { code: 'CART_NOT_FOUND', message: 'not found' } }));
		await CartService.refresh();
		expect(CartService.getCart().lines).toHaveLength(0);
	});
});

describe('dropped-line notice', () => {
	it('reports a SKU that vanished server-side without the caller asking for it', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart())); // seed mirror with SKU1
		await CartService.refresh();

		enqueue(respond(200, serverCart({ lines: [] }))); // SKU1 silently gone
		const res = await CartService.refresh();
		expect(res.dropped).toEqual(['SKU1']);
	});
});

describe('fail-closed stock', () => {
	const line = (over: Partial<ServerCartLine> = {}): ServerCartLine => ({
		sku: 'X', name: 'X', quantity: 1, unitPrice: 100, lineSubtotal: 100, lineDiscount: 0, lineTotal: 100,
		available: true, availableQuantity: 5, ...over,
	});

	it('missing/false `available` is unavailable, never assumed in stock', () => {
		expect(isLineAvailable(line({ available: true }))).toBe(true);
		expect(isLineAvailable(line({ available: false }))).toBe(false);
		expect(isLineAvailable(line({ available: undefined as unknown as boolean }))).toBe(false);
	});

	it('`availableQuantity: null` is uncapped; anything else is a hard ceiling', () => {
		expect(remainingQuantity(line({ availableQuantity: null }))).toBeNull();
		expect(remainingQuantity(line({ availableQuantity: 3 }))).toBe(3);
		expect(remainingQuantity(line({ availableQuantity: undefined as unknown as null }))).toBe(0); // fails closed, never Infinity
	});

	it('canRequestQuantity fails closed on an unavailable line even under the cap', () => {
		expect(canRequestQuantity(line({ available: false, availableQuantity: 999 }), 1)).toBe(false);
	});

	it('canRequestQuantity allows any quantity when uncapped and available', () => {
		expect(canRequestQuantity(line({ available: true, availableQuantity: null }), 10_000)).toBe(true);
	});

	it('validateStock flags any line the server marks unavailable', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart({ lines: [{ sku: 'SKU1', name: 'Widget', quantity: 1, unitPrice: 2500, lineSubtotal: 2500, lineDiscount: 0, lineTotal: 2500, available: false, availableQuantity: 0 }] })));
		await CartService.refresh();
		const result = CartService.validateStock();
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain('Out of stock');
	});
});

describe('legacy cart migration', () => {
	it('seeds the server cart from the pre-native localStorage cart by SKU, then deletes the key', async () => {
		localStorage.setItem('sellright_legacy_local_cart', JSON.stringify({
			items: [
				{ productVariantId: 'SKU1', quantity: 2, productVariant: { id: 'SKU1', name: 'Widget', product: { slug: 'widget' }, featuredAsset: { preview: '/w.jpg' } } },
				{ sku: 'SKU2', quantity: 1, productVariant: { id: 'SKU2', name: 'Gadget', product: { slug: 'gadget' } } },
			],
		}));
		const migratedCart = serverCart({
			lines: [
				{ sku: 'SKU1', name: 'Widget', quantity: 2, unitPrice: 2500, lineSubtotal: 5000, lineDiscount: 0, lineTotal: 5000, available: true, availableQuantity: 999 },
				{ sku: 'SKU2', name: 'Gadget', quantity: 1, unitPrice: 1000, lineSubtotal: 1000, lineDiscount: 0, lineTotal: 1000, available: true, availableQuantity: 999 },
			],
			subtotal: 6000,
		});
		enqueue(
			respond(200, migratedCart), // POST /cart — seeded from the legacy lines
			respond(200, { ...migratedCart, lines: [...migratedCart.lines, { sku: 'SKU3', name: 'Thing', quantity: 1, unitPrice: 500, lineSubtotal: 500, lineDiscount: 0, lineTotal: 500, available: true, availableQuantity: 999 }], subtotal: 6500 }), // PATCH lines — appends SKU3
		);

		const res = await CartService.addLine('SKU3', 1); // any first mutation triggers ensureCart()
		const create = calls.find((c) => c.url.endsWith('/v1/shop/cart'));
		const body = JSON.parse(create!.init.body!);
		expect(body.items).toEqual(expect.arrayContaining([{ sku: 'SKU1', quantity: 2 }, { sku: 'SKU2', quantity: 1 }]));
		expect(localStorage.getItem('sellright_legacy_local_cart')).toBeNull();
		// The mirror carries the migrated lines' enrichment (image/slug) even
		// though the server line itself has no such fields.
		expect(res.cart.lines.find((l) => l.sku === 'SKU1')?.slug).toBe('widget');
	});

	it('a missing or empty legacy cart creates a plain new cart', async () => {
		enqueue(
			respond(200, serverCart({ lines: [], subtotal: 0 })), // POST /cart — nothing to seed
			respond(200, serverCart({ lines: [{ sku: 'SKU1', name: 'Widget', quantity: 1, unitPrice: 2500, lineSubtotal: 2500, lineDiscount: 0, lineTotal: 2500, available: true, availableQuantity: 999 }] })),
		);
		await CartService.addLine('SKU1', 1);
		const create = calls.find((c) => c.url.endsWith('/v1/shop/cart'));
		const body = JSON.parse(create!.init.body!);
		expect(body.items).toBeUndefined();
	});
});

describe('coupon apply/remove — server-priced', () => {
	it('applyCoupon validates against the real cart and stores the code', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart({ coupon: { code: 'SAVE10', applied: true }, discountTotal: 500, subtotal: 2000 })));
		const res = await CartService.applyCoupon('SAVE10');
		expect(res.valid).toBe(true);
		expect(calls[calls.length - 1].url).toContain('couponCode=SAVE10');
		expect(CartService.getCart().coupon?.applied).toBe(true);
	});

	it('a rejected code surfaces the server reason', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart({ coupon: { code: 'BAD', applied: false, reason: 'expired' } })));
		const res = await CartService.applyCoupon('BAD');
		expect(res.valid).toBe(false);
		expect(res.reason).toBe('expired');
	});

	it('removeCoupon re-prices without the code', async () => {
		setCookie('tok_srv');
		enqueue(
			respond(200, serverCart({ coupon: { code: 'SAVE10', applied: true }, discountTotal: 500 })),
			respond(200, serverCart({ coupon: null })),
		);
		await CartService.applyCoupon('SAVE10');
		await CartService.removeCoupon();
		expect(calls[calls.length - 1].url).not.toContain('couponCode=');
		expect(CartService.getCart().coupon).toBeNull();
	});
});

/**
 * Request-sequence guard: server-snapshot reads that overlap must never let an
 * OLDER response overwrite a newer one (the coupon "revalidation race"). Each
 * test holds responses open with deferreds so the arrival order is explicit.
 */
describe('overlapping reads — request-sequence guard', () => {
	const deferred = () => {
		let resolve!: (r: Response) => void;
		const promise = new Promise<Response>((r) => { resolve = r; });
		return { promise, resolve };
	};
	const appliedCoupon = { code: 'SAVE10', applied: true } as const;
	const waitForCalls = (n: number) => vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(n));

	it('a stale refresh (sent before the coupon apply) cannot wipe the applied coupon, whichever lands last', async () => {
		setCookie('tok_srv');
		const refreshRes = deferred();
		const applyRes = deferred();
		enqueue(refreshRes.promise, applyRes.promise);

		const refreshP = CartService.refresh();
		const applyP = CartService.applyCoupon('SAVE10');
		await waitForCalls(2);

		applyRes.resolve(await respond(200, serverCart({ revision: 2, coupon: appliedCoupon, discountTotal: 250, grandTotal: 2250 })));
		expect(await applyP).toEqual({ valid: true });
		refreshRes.resolve(await respond(200, serverCart({ revision: 1, coupon: null })));
		const refreshed = await refreshP;

		expect(refreshed.dropped).toEqual([]);
		expect(CartService.getCart().coupon).toEqual(appliedCoupon);
		expect(CartService.getCart().revision).toBe(2);
	});

	it('removing a coupon beats an older in-flight apply: the late apply is ignored and its code is not remembered', async () => {
		setCookie('tok_srv');
		const applyRes = deferred();
		const removeRes = deferred();
		enqueue(applyRes.promise, removeRes.promise, respond(200, serverCart({ coupon: null })));

		const applyP = CartService.applyCoupon('SAVE10');
		await waitForCalls(1);
		const removeP = CartService.removeCoupon();
		await waitForCalls(2);

		removeRes.resolve(await respond(200, serverCart({ revision: 2, coupon: null })));
		await removeP;
		applyRes.resolve(await respond(200, serverCart({ revision: 1, coupon: appliedCoupon })));
		const applied = await applyP;

		expect(applied).toEqual({ valid: false, reason: COUPON_SUPERSEDED });
		expect(CartService.getCart().coupon).toBeNull();
		// The late apply must not have re-armed the coupon for later reads.
		await CartService.refresh();
		expect(calls[calls.length - 1].url).not.toContain('couponCode=');
	});

	it('a refresh still in flight when the cart is discarded cannot resurrect it', async () => {
		setCookie('tok_srv');
		const refreshRes = deferred();
		enqueue(refreshRes.promise);

		const refreshP = CartService.refresh();
		await waitForCalls(1);
		CartService.discard();
		refreshRes.resolve(await respond(200, serverCart()));
		await refreshP;

		expect(CartService.getCart().lines).toHaveLength(0);
		expect(document.cookie).not.toContain('sr_cart=tok_srv');
	});

	it('a read issued while a mutation was in flight cannot overwrite the mutation result', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart({ revision: 1 }))); // seed the mirror
		await CartService.refresh();

		const patchRes = deferred();
		const refreshRes = deferred();
		enqueue(patchRes.promise, refreshRes.promise);
		const updateP = CartService.updateLine('SKU1', 2);
		await waitForCalls(2);
		const refreshP = CartService.refresh();
		await waitForCalls(3);

		const two = [{ sku: 'SKU1', name: 'Widget', quantity: 2, unitPrice: 2500, lineSubtotal: 5000, lineDiscount: 0, lineTotal: 5000, available: true, availableQuantity: 999 }];
		patchRes.resolve(await respond(200, serverCart({ revision: 2, lines: two, subtotal: 5000 })));
		await updateP;
		refreshRes.resolve(await respond(200, serverCart({ revision: 1 }))); // computed before the PATCH landed
		await refreshP;

		expect(CartService.getCart().lines[0]?.quantity).toBe(2);
		expect(CartService.getCart().revision).toBe(2);
	});

	it('sequential reads are unaffected (each adopts its own response)', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart({ revision: 1 })), respond(200, serverCart({ revision: 2 })));
		await CartService.refresh();
		await CartService.refresh();
		expect(CartService.getCart().revision).toBe(2);
	});
});

describe('checkoutSnapshot', () => {
	it('returns token + live revision + status for checkout', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart({ revision: 8 })));
		const snap = await CartService.checkoutSnapshot();
		expect(snap).toEqual({ token: 'tok_srv', revision: 8, status: 'active' });
	});

	it('returns null when no token exists', async () => {
		expect(await CartService.checkoutSnapshot()).toBeNull();
		expect(calls).toHaveLength(0);
	});
});

describe('CartError', () => {
	it('carries a stable code distinct from its message', () => {
		const err = new CartError('not_found', 'Your cart expired');
		expect(err.code).toBe('not_found');
		expect(err.name).toBe('CartError');
	});
});
