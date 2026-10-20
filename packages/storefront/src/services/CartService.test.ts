/**
 * Consumer-contract tests for CartService — the single, server-owned cart.
 * Asserts the wire contract (blind append vs revisioned absolute set), the
 * 409-conflict retry-once behaviour, fail-closed stock reads, the dropped-
 * line notice, the one-time legacy-cart migration, and the converted-cart /
 * cross-tab invariants (docs/plans/2026-10-11-stale-cart-recovery.md §2, §7).
 * `fetch` is mocked; jsdom supplies `document.cookie` + `localStorage`; a
 * real-mutex `navigator.locks` fake (cart-test-harness) serialises "tabs".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto, randomUUID } from 'node:crypto';
import { CartService, CartError, ConvertedCartError, COUPON_SUPERSEDED, type CartLockScope } from './CartService';
import { deferred, freshTab, installLocks, removeLocks, settle, type FakeLocks } from './cart-test-harness';
import { placeOrder } from '~/providers/shop/checkout/checkout';
import { refreshStockBeforeSubmit } from '~/hooks/pre-submit-stock';
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
	couponCodes: over.coupon ? [over.coupon.code] : [],
	coupons: over.coupon ? [{ ...over.coupon, kind: 'fixed', appliedAmount: over.discountTotal ?? 0 }] : [],
	quoteHash: '', pricingIntent: 'preview', shippingMethodCode: null, pointsDiscount: 0,
	email: null,
	customerId: null,
	lines: [{ sku: 'SKU1', name: 'Widget', quantity: 1, unitPrice: 2500, lineSubtotal: 2500, lineDiscount: 0, lineTotal: 2500, available: true, availableQuantity: 999 }],
	...over,
});

const setCookie = (v: string) => { document.cookie = `sr_cart=${v}; Path=/`; };
const clearCookie = () => { document.cookie = 'sr_cart=; Path=/; Max-Age=0'; };
const cookieValue = () => document.cookie.match(/(?:^|; )sr_cart=([^;]*)/)?.[1] ?? null;
/** Test-only reset of the mirror (the public `discard` retires the cookie too; tests reset the mirror alone). */
const resetService = () => CartService['resetMirror']();
let locks: FakeLocks;

beforeEach(() => {
	vi.stubGlobal('crypto', { subtle: webcrypto.subtle, randomUUID });
	calls.length = 0;
	queue = [];
	clearCookie();
	try { localStorage.clear(); } catch { /* ignore */ }
	locks = installLocks();
	resetService();
	CartService.setQuoteContext({});
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
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	removeLocks();
	clearCookie();
});

const patchCalls = () => calls.filter((c) => c.init.method === 'PATCH');

describe('addLine — blind append', () => {
  it('uses live shipping copy after refresh, including fresh tabs without enrichment', async () => {
    const shipDateLabel = 'Ships late fall & updates';
    const live = serverCart({ lines: [{ ...serverCart().lines[0], isPreOrder: true, shipDate: null, shipDateLabel }] });
    enqueue(respond(200, serverCart()), respond(200, live));
    const added = await CartService.addLine('SKU1', 1, { shipDateLabel: 'stale copy', shipDate: '2020-01-01', isPreOrder: false });
    expect(added.cart.lines[0]).toMatchObject({ shipDateLabel, shipDate: null, isPreOrder: true });
    resetService();
    setCookie('tok_srv');
    enqueue(respond(200, live));
    expect((await CartService.refresh()).cart.lines[0]).toMatchObject({ shipDateLabel, shipDate: null, isPreOrder: true });
  });

	it('falls back to the server line image when no enrichment exists, and enrichment wins when present', async () => {
		const withImage = serverCart({ lines: [{ ...serverCart().lines[0], image: 'store/media/preview/server.webp' }] });
		setCookie('tok_srv');
		enqueue(respond(200, withImage));
		expect((await CartService.refresh()).cart.lines[0].image).toBe('store/media/preview/server.webp');
		resetService();
		enqueue(respond(200, serverCart()), respond(200, withImage));
		const added = await CartService.addLine('SKU1', 1, { image: 'local/enriched.webp' });
		expect(added.cart.lines[0].image).toBe('local/enriched.webp');
	});

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
		expect(body).toEqual({ lines: [{ sku: 'SKU1', quantity: 2 }], shipCountry: 'US' });
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
		expect(get?.url.replace(/^https?:\/\/[^/]+/, '')).toBe('/v1/shop/cart/tok_srv?shipCountry=US');
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

	it('409 converted KEEPS the token, shows the converted snapshot and does not retry', async () => {
		setCookie('tok_srv');
		enqueue(
			respond(200, serverCart({ revision: 4 })),
			respond(409, { error: { code: 'CART_STALE', message: 'converted' }, code: 'converted', revision: 4, cart: serverCart({ status: 'converted' }) }),
		);
		const outcome = await CartService.updateLine('SKU1', 2).catch((e) => e);
		expect(outcome).toBeInstanceOf(ConvertedCartError);
		expect(outcome.message).toMatch(/checked out/);
		expect(cookieValue()).toBe('tok_srv');
		expect(CartService.getCart().status).toBe('converted');
		expect(patchCalls()).toHaveLength(1);
		expect(calls).toHaveLength(2);
	});

	it.each([undefined, 'stale', 'revision_required', 'converted', 'merged'] as const)(
		'a snapshotless budget refusal (%s) preserves its error and cart without retry',
		async code => {
			setCookie('tok_srv');
			enqueue(
				respond(200, serverCart({ revision: 4 })),
				respond(409, {
					error: { code: 'CART_TOO_LARGE', message: 'Cart exceeds 200 distinct SKUs' },
					code, revision: 6, status: code === 'converted' || code === 'merged' ? code : 'active',
				}),
			);
			await expect(CartService.updateLine('SKU1', 2)).rejects.toMatchObject({
				status: 409, code: 'CART_TOO_LARGE', message: 'Cart exceeds 200 distinct SKUs',
			});
			expect(patchCalls()).toHaveLength(1);
			expect(calls).toHaveLength(2);
			expect(cookieValue()).toBe('tok_srv');
			expect(CartService.getCart()).toMatchObject({
				revision: 4, status: 'active', lines: [{ sku: 'SKU1', quantity: 1 }],
			});
		},
	);

	it('404 CART_NOT_FOUND on refresh retires that cart and tells the shopper to re-add', async () => {
		setCookie('tok_srv');
		enqueue(respond(404, { error: { code: 'CART_NOT_FOUND', message: 'not found' } }));
		await expect(CartService.refresh()).rejects.toMatchObject({ code: 'not_found', message: expect.stringMatching(/re-add/) });
		expect(CartService.getCart().lines).toHaveLength(0);
		expect(cookieValue()).toBeNull();
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
	it('maps numeric legacy IDs through a committed receipt before deleting the original blob', async () => {
		const claimId = '11111111-1111-4111-8111-111111111111';
		vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(claimId);
		localStorage.setItem('vendure_local_cart', JSON.stringify({ items: [{ productVariantId: '17', quantity: 2 }],
			appliedCoupon: { code: 'SAVE', discountAmount: 99999 }, countryCode: 'CA', countryExplicitlySet: true }));
		enqueue(respond(200, { receipt: claimId, cart: serverCart(), couponCode: 'SAVE', countryCode: 'CA', unresolved: [] }),
			respond(200, serverCart({ revision: 2 })));
		await CartService.addLine('SKU3', 1);
		const request = calls.find(c => c.url.endsWith('/v1/shop/cart/legacy-migration'))!;
		expect(JSON.parse(request.init.body!)).toEqual({ claimId, items: [{ variantId: '17', quantity: 2 }], couponCode: 'SAVE', countryCode: 'CA' });
		expect(localStorage.getItem('vendure_local_cart')).toBeNull();
		expect(calls.filter(c => c.url.endsWith('/v1/shop/cart'))).toHaveLength(0);
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
		enqueue(respond(200, serverCart()), respond(200, serverCart({ coupon: { code: 'SAVE10', applied: true }, discountTotal: 500, subtotal: 2000 })));
		const res = await CartService.applyCoupon('SAVE10');
		expect(res.valid).toBe(true);
		expect(JSON.parse(calls[calls.length - 1].init.body!)).toMatchObject({ lines: [], couponCodes: ['SAVE10'], expectedRevision: 1 });
		expect(CartService.getCart().coupon?.applied).toBe(true);
	});

	it('a rejected code surfaces the server reason', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart()), respond(200, serverCart({ coupon: { code: 'BAD', applied: false, reason: 'expired' } })));
		const res = await CartService.applyCoupon('BAD');
		expect(res.valid).toBe(false);
		expect(res.reason).toBe('expired');
	});

	it('removeCoupon re-prices without the code', async () => {
		setCookie('tok_srv');
		enqueue(
			respond(200, serverCart()),
			respond(200, serverCart({ coupon: { code: 'SAVE10', applied: true }, discountTotal: 500 })),
			respond(200, serverCart({ coupon: null })),
		);
		await CartService.applyCoupon('SAVE10');
		await CartService.removeCoupon();
		expect(JSON.parse(calls[calls.length - 1].init.body!)).toMatchObject({ lines: [], couponCodes: [] });
		expect(CartService.getCart().coupon).toBeNull();
	});
});

/**
 * Operations of a cooperating tab are serialised by the cart lock, so reads and mutations never overlap: each test
 * holds a response open with a deferred and proves the NEXT request is not even sent until it lands. The sequence
 * guard still orders responses when there is no lock (a lock-free refresh) — covered at the end.
 */
describe('serialised operations and the request-sequence guard', () => {
	const appliedCoupon = { code: 'SAVE10', applied: true } as const;
	const waitForCalls = (n: number) => vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(n));

	it('a coupon apply issued during a refresh is sent only after it lands; the coupon ends applied', async () => {
		setCookie('tok_srv');
		const refreshRes = deferred();
		enqueue(refreshRes.promise, respond(200, serverCart({ revision: 2, coupon: appliedCoupon, discountTotal: 250, grandTotal: 2250 })));

		const refreshP = CartService.refresh();
		const applyP = CartService.applyCoupon('SAVE10');
		await waitForCalls(1);
		await settle();
		expect(calls).toHaveLength(1); // the apply is queued behind the refresh

		refreshRes.resolve(await respond(200, serverCart({ revision: 1, coupon: null })));
		expect((await refreshP).dropped).toEqual([]);
		expect(await applyP).toEqual({ valid: true });
		expect(CartService.getCart().coupon).toEqual(appliedCoupon);
		expect(CartService.getCart().revision).toBe(2);
		expect(locks.maxConcurrent).toBe(1);
	});

	it('a removal queued behind an in-flight apply runs after it: the coupon ends removed and is not remembered', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart())); await CartService.refresh(); calls.length = 0;
		const applyRes = deferred();
		enqueue(applyRes.promise, respond(200, serverCart({ revision: 2, coupon: null })), respond(200, serverCart({ coupon: null })));

		const applyP = CartService.applyCoupon('SAVE10');
		await waitForCalls(1);
		const removeP = CartService.removeCoupon();
		await settle();
		expect(calls).toHaveLength(1);

		applyRes.resolve(await respond(200, serverCart({ revision: 1, coupon: appliedCoupon })));
		expect(await applyP).toEqual({ valid: true });
		await removeP;

		expect(CartService.getCart().coupon).toBeNull();
		await CartService.refresh();
		expect(calls[calls.length - 1].url).not.toContain('couponCode=');
	});

	it('a refresh issued during a mutation is sent only after the mutation lands', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart({ revision: 1 }))); // seed the mirror
		await CartService.refresh();
		calls.length = 0;

		const patchRes = deferred();
		enqueue(patchRes.promise, respond(200, serverCart({ revision: 2 })));
		const updateP = CartService.updateLine('SKU1', 2);
		await waitForCalls(1);
		const refreshP = CartService.refresh();
		await settle();
		expect(calls).toHaveLength(1); // only the PATCH

		const two = [{ sku: 'SKU1', name: 'Widget', quantity: 2, unitPrice: 2500, lineSubtotal: 5000, lineDiscount: 0, lineTotal: 5000, available: true, availableQuantity: 999 }];
		patchRes.resolve(await respond(200, serverCart({ revision: 2, lines: two, subtotal: 5000 })));
		await updateP;
		await refreshP;
		expect(calls).toHaveLength(2);
		expect(CartService.getCart().revision).toBe(2);
	});

	it('sequential reads are unaffected (each adopts its own response)', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart({ revision: 1 })), respond(200, serverCart({ revision: 2 })));
		await CartService.refresh();
		await CartService.refresh();
		expect(CartService.getCart().revision).toBe(2);
	});

	it('without Web Locks, an older refresh landing last cannot overwrite a newer one (sequence guard)', async () => {
		removeLocks();
		setCookie('tok_srv');
		const older = deferred();
		const newer = deferred();
		enqueue(older.promise, newer.promise);

		const olderP = CartService.refresh();
		await waitForCalls(1);
		const newerP = CartService.refresh();
		await waitForCalls(2);

		newer.resolve(await respond(200, serverCart({ revision: 2 })));
		await newerP;
		older.resolve(await respond(200, serverCart({ revision: 1 })));
		await olderP;
		expect(CartService.getCart().revision).toBe(2);
	});

	it('without Web Locks, a refresh in flight when the cart is retired elsewhere cannot resurrect it', async () => {
		removeLocks();
		setCookie('tok_srv');
		const refreshRes = deferred();
		enqueue(refreshRes.promise);

		const refreshP = CartService.refresh();
		await waitForCalls(1);
		clearCookie(); // another tab retired the cart
		refreshRes.resolve(await respond(200, serverCart()));
		await refreshP;

		expect(CartService.getCart().lines).toHaveLength(0);
		expect(cookieValue()).toBeNull();
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

// ── converted-cart handling and cross-tab invariants (design §2, §7) ───────────
const oneLine = (sku: string, quantity = 1) => [
	{ sku, name: sku, quantity, unitPrice: 2500, lineSubtotal: 2500 * quantity, lineDiscount: 0, lineTotal: 2500 * quantity, available: true, availableQuantity: 999 },
];
const notFound = () => respond(404, { error: { code: 'CART_NOT_FOUND', message: 'cart not found' } });
const converted409 = (cart: Partial<ServerCart> = {}) =>
	respond(409, { error: { code: 'CART_STALE', message: 'converted' }, code: 'converted', revision: 4, cart: serverCart({ status: 'converted', ...cart }) });
const stale409 = (revision: number) =>
	respond(409, { error: { code: 'CART_STALE', message: 'stale' }, code: 'stale', revision, cart: serverCart({ revision }) });
const merged409 = () =>
	respond(409, { error: { code: 'CART_STALE', message: 'merged' }, code: 'merged', revision: 4, cart: serverCart({ status: 'merged', lines: [] }) });
const lookupBody = (over: Record<string, unknown> = {}) => ({
	code: 'ORD-A', state: 'PendingPayment', grandTotal: 5800, discountTotal: 0, couponApplied: false, giftCardApplied: 0,
	pointsDiscount: 0, pointsRedeemed: 0, receiptToken: 'rt_a', currency: 'USD', replay: true, ...over,
});
const seedMirror = async (token = 'tok_srv', revision = 1) => {
	setCookie(token);
	enqueue(respond(200, serverCart({ token, revision })));
	await CartService.refresh();
	calls.length = 0;
};
const waitForCalls = (n: number) => vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(n));
const createCalls = () => calls.filter((c) => c.init.method === 'POST' && /\/v1\/shop\/cart$/.test(c.url));

describe('one cart creation across tabs (I4)', () => {
	it('concurrent first add in two tabs → exactly one POST /cart; both lines land on one token', async () => {
		const tabB = (await freshTab()).CartService;
		const createRes = deferred();
		enqueue(
			createRes.promise,
			respond(200, serverCart({ revision: 2, lines: oneLine('SKU1') })), // tab A PATCH
			respond(200, serverCart({ revision: 3, lines: [...oneLine('SKU1'), ...oneLine('SKU2')] })), // tab B PATCH
		);

		const addA = CartService.addLine('SKU1', 1);
		const addB = tabB.addLine('SKU2', 1);
		await waitForCalls(1);
		await settle();
		expect(calls).toHaveLength(1); // tab B waits for the lock instead of creating a competing cart

		createRes.resolve(await respond(200, serverCart({ lines: [] })));
		await Promise.all([addA, addB]);

		expect(createCalls()).toHaveLength(1);
		expect(patchCalls().map((c) => c.url.replace(/^https?:\/\/[^/]+/, ''))).toEqual(['/v1/shop/cart/tok_srv/lines', '/v1/shop/cart/tok_srv/lines']);
		expect(patchCalls().map((c) => JSON.parse(String(c.init.body)).lines[0].sku)).toEqual(['SKU1', 'SKU2']);
		expect(cookieValue()).toBe('tok_srv');
		expect(tabB.getCart().lines).toHaveLength(2);
		expect(locks.maxConcurrent).toBe(1);
	});

	it('serializes two tabs around one legacy receipt & preserves blob until response', async () => {
		const claimId = '22222222-2222-4222-8222-222222222222';
		vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(claimId);
		const raw = JSON.stringify({ items: [{ productVariantId: '9', quantity: 3 }] });
		localStorage.setItem('vendure_local_cart', raw);
		const tabB = (await freshTab()).CartService;
		const createRes = deferred();
		enqueue(createRes.promise, respond(200, serverCart({ revision: 2 })), respond(200, serverCart({ revision: 3 })));
		const addA = CartService.addLine('SKU1', 1);
		const addB = tabB.addLine('SKU2', 1);
		await waitForCalls(1);
		expect(localStorage.getItem('vendure_local_cart')).toBe(raw);
		createRes.resolve(await respond(200, { receipt: claimId, cart: serverCart({ lines: oneLine('SKU9', 3) }), couponCode: null, countryCode: null, unresolved: [] }));
		await Promise.all([addA, addB]);
		expect(calls.filter(c => c.url.endsWith('/v1/shop/cart/legacy-migration'))).toHaveLength(1);
		expect(localStorage.getItem('vendure_local_cart')).toBeNull();
	});
});

describe('a response for T never changes U (I3)', () => {
	it('a delayed refresh for T after the cookie moved to U → U\'s cookie and the mirror are untouched', async () => {
		await seedMirror('tok_srv', 1);
		const refreshRes = deferred();
		enqueue(refreshRes.promise);

		const refreshP = CartService.refresh();
		await waitForCalls(1);
		setCookie('tok_u'); // a writer outside this tab's lock replaced the cart
		refreshRes.resolve(await respond(200, serverCart({ token: 'tok_srv', revision: 9 })));
		const res = await refreshP;

		expect(cookieValue()).toBe('tok_u');
		expect(res.dropped).toEqual([]);
		expect(CartService.getCart().revision).toBe(1); // the late response for T was not installed
	});

	it('a delayed mutation response for T after the cookie moved to U → nothing is written', async () => {
		await seedMirror('tok_srv', 1);
		const patchRes = deferred();
		enqueue(patchRes.promise);

		const addP = CartService.addLine('SKU1', 1);
		await waitForCalls(1);
		setCookie('tok_u');
		patchRes.resolve(await respond(200, serverCart({ token: 'tok_srv', revision: 9 })));
		await addP;

		expect(cookieValue()).toBe('tok_u');
		expect(CartService.getCart().revision).toBe(1);
	});

	it('a delayed checkout 409 `stale` for T after U is current → no adoption (R2-2)', async () => {
		await seedMirror('tok_srv', 1);
		const postRes = deferred();
		enqueue(postRes.promise);

		const order = CartService.withLock((scope) =>
			placeOrder({ items: [{ sku: 'SKU1', quantity: 1 }] }, { token: 'tok_srv', revision: 1, status: 'active' }, scope),
		).catch((e) => e);
		await waitForCalls(1);
		setCookie('tok_u');
		postRes.resolve(await respond(409, { error: { code: 'CART_STALE', message: 'cart changed' }, code: 'stale', revision: 6, cart: serverCart({ token: 'tok_srv', revision: 6 }) }));

		expect(((await order) as Error).message).toMatch(/cart changed/);
		expect(cookieValue()).toBe('tok_u');
		expect(CartService.getCart().revision).toBe(1);
	});

	it('a delayed CART_NOT_FOUND for T after U → U is kept (R1-2)', async () => {
		await seedMirror('tok_srv', 1);
		const readRes = deferred();
		enqueue(readRes.promise);

		const refreshP = CartService.refresh().catch((e) => e);
		await waitForCalls(1);
		setCookie('tok_u');
		readRes.resolve(await notFound());

		expect(await refreshP).toMatchObject({ code: 'not_found' });
		expect(cookieValue()).toBe('tok_u');
	});

	it('a coupon validated for T after the cookie moved to U is reported superseded and its code is not remembered', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart())); await CartService.refresh(); calls.length = 0;
		const couponRes = deferred();
		enqueue(couponRes.promise, respond(200, serverCart({ token: 'tok_u' })));

		const applyP = CartService.applyCoupon('SAVE10');
		await waitForCalls(1);
		setCookie('tok_u');
		couponRes.resolve(await respond(200, serverCart({ token: 'tok_srv', coupon: { code: 'SAVE10', applied: true } })));

		expect(await applyP).toEqual({ valid: false, reason: COUPON_SUPERSEDED });
		expect(CartService.getCart().coupon).toBeNull();
		await CartService.refresh();
		expect(calls[calls.length - 1].url).not.toContain('couponCode=');
	});

	it('a delayed merged 409 retires only the token it was sent for', async () => {
		await seedMirror('tok_srv', 4);
		const patchRes = deferred();
		enqueue(patchRes.promise);

		const updateP = CartService.updateLine('SKU1', 2).catch((e) => e);
		await waitForCalls(1);
		setCookie('tok_u');
		patchRes.resolve(await merged409());

		expect(await updateP).toMatchObject({ code: 'merged' });
		expect(cookieValue()).toBe('tok_u');
	});

	it('token() is the cookie, never an older mirror; the next operation resets a mirror another tab replaced', async () => {
		await seedMirror('tok_srv', 1);
		setCookie('tok_u');
		expect(CartService.token()).toBe('tok_u');
		expect(CartService.getCart().token).toBe('tok_srv');

		enqueue(respond(500, { error: { code: 'BOOM', message: 'boom' } }));
		await expect(CartService.refresh()).rejects.toThrow();
		expect(CartService.getCart().token).toBe(''); // reset on lock entry, before the request
		expect(cookieValue()).toBe('tok_u');
	});
});

describe('retirement needs proof (I1, I2, I5)', () => {
	it('a 404 with another code, and a network timeout, keep the cookie and the mirror', async () => {
		await seedMirror('tok_srv', 1);
		enqueue(respond(404, { error: { code: 'NOT_FOUND', message: 'route not found' } }));
		await expect(CartService.refresh()).rejects.toThrow();
		expect(cookieValue()).toBe('tok_srv');
		expect(CartService.getCart().revision).toBe(1);

		enqueue(Promise.reject(new TypeError('network down')));
		await expect(CartService.refresh()).rejects.toThrow();
		expect(cookieValue()).toBe('tok_srv');
		expect(CartService.getCart().revision).toBe(1);
	});

	it('converted 409 on the first attempt and on the retry → token kept, mirror converted, no further request', async () => {
		await seedMirror('tok_srv', 4);
		enqueue(converted409());
		await expect(CartService.updateLine('SKU1', 2)).rejects.toMatchObject({ code: 'converted' });
		expect(patchCalls()).toHaveLength(1);
		expect(calls).toHaveLength(1);
		expect(cookieValue()).toBe('tok_srv');
		expect(CartService.getCart().status).toBe('converted');

		resetService();
		calls.length = 0;
		await seedMirror('tok_srv', 4);
		enqueue(stale409(6), converted409());
		const outcome = await CartService.updateLine('SKU1', 2).catch((e) => e);
		expect(outcome).toBeInstanceOf(ConvertedCartError); // not a generic "cart changed"
		expect(patchCalls()).toHaveLength(2); // one retry, never a third
		expect(calls).toHaveLength(2);
		expect(cookieValue()).toBe('tok_srv');
		expect(CartService.getCart().status).toBe('converted');
	});

	it('an add against a converted cart is reported as converted and keeps the token', async () => {
		setCookie('tok_srv');
		enqueue(converted409());
		await expect(CartService.addLine('SKU1', 1)).rejects.toMatchObject({ code: 'converted' });
		expect(cookieValue()).toBe('tok_srv');
		expect(CartService.getCart().status).toBe('converted');
	});

	it('cold-start revision read hitting CART_NOT_FOUND retires the token: one GET, no PATCH', async () => {
		setCookie('tok_srv');
		enqueue(notFound());
		await expect(CartService.updateLine('SKU1', 2)).rejects.toMatchObject({ code: 'not_found' });
		expect(calls).toHaveLength(1);
		expect(patchCalls()).toHaveLength(0);
		expect(cookieValue()).toBeNull();
	});

	it('a merged 409 retires its own token', async () => {
		await seedMirror('tok_srv', 4);
		enqueue(merged409());
		await expect(CartService.updateLine('SKU1', 2)).rejects.toMatchObject({ code: 'merged' });
		expect(cookieValue()).toBeNull();
		expect(CartService.getCart().lines).toHaveLength(0);
	});

	it('the failed operation never creates or seeds a replacement cart', async () => {
		setCookie('tok_srv');
		enqueue(notFound());
		await expect(CartService.addLine('SKU1', 1)).rejects.toMatchObject({ code: 'not_found' });
		expect(createCalls()).toHaveLength(0);
	});
});

describe('retireSettled — order-bound retirement', () => {
	const lookupUrl = (token: string) => `/v1/shop/cart/${token}/checkout`;

	it('an old confirmation (code A) while the cookie names a newer cart → 404 or a code mismatch keeps it (R2-3)', async () => {
		setCookie('tok_new');
		enqueue(respond(404, { error: { code: 'ORDER_NOT_FOUND', message: 'order not found' } }));
		expect(await CartService.retireSettled('ORD-A')).toBe(false);
		expect(calls[0].url).toContain(lookupUrl('tok_new'));
		expect(cookieValue()).toBe('tok_new');

		enqueue(respond(200, lookupBody({ code: 'ORD-B', state: 'Paid' })));
		expect(await CartService.retireSettled('ORD-A')).toBe(false);
		expect(cookieValue()).toBe('tok_new');
	});

	it('a failed lookup, PendingPayment or an unknown state keeps the token', async () => {
		setCookie('tok_srv');
		// Thunks: a pre-built rejected promise would be reported unhandled until its turn comes.
		for (const response of [
			() => respond(500, { error: { code: 'BOOM', message: 'boom' } }),
			() => Promise.reject(new TypeError('network down')),
			() => respond(200, lookupBody({ state: 'PendingPayment' })),
			() => respond(200, lookupBody({ state: 'Declined' })),
			() => respond(200, lookupBody({ state: 'AddingItems' })),
		]) {
			enqueue(response());
			expect(await CartService.retireSettled('ORD-A')).toBe(false);
			expect(cookieValue()).toBe('tok_srv');
		}
	});

	it('Paid or Cancelled with a matching code retires; the lookup is read-only', async () => {
		for (const state of ['Paid', 'Cancelled']) {
			setCookie('tok_srv');
			enqueue(respond(200, lookupBody({ state })));
			expect(await CartService.retireSettled('ORD-A')).toBe(true);
			expect(cookieValue()).toBeNull();
		}
		expect(calls.every((c) => !c.init.method || c.init.method === 'GET')).toBe(true);
	});

	it('without an expected code (the drawer) a settled order retires too', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, lookupBody({ state: 'Paid' })));
		expect(await CartService.retireSettled()).toBe(true);
		expect(cookieValue()).toBeNull();
	});

	it('no cookie → nothing to retire, no request', async () => {
		expect(await CartService.retireSettled('ORD-A')).toBe(false);
		expect(calls).toHaveLength(0);
	});
});

describe('lookupConvertedCheckout', () => {
	it('returns the original order and writes nothing', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, lookupBody()));
		expect(await CartService.lookupConvertedCheckout('tok_srv')).toEqual({
			ok: true,
			order: { code: 'ORD-A', state: 'PendingPayment', grandTotal: 5800, receiptToken: 'rt_a', currency: 'USD' },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].init.method).toBe('GET');
		expect(cookieValue()).toBe('tok_srv');
	});

	it('404 ORDER_NOT_FOUND is not_converted; any other failure is unavailable', async () => {
		enqueue(respond(404, { error: { code: 'ORDER_NOT_FOUND', message: 'order not found' } }));
		expect(await CartService.lookupConvertedCheckout('tok_srv')).toEqual({ ok: false, reason: 'not_converted' });
		enqueue(respond(404, { error: { code: 'NOT_FOUND', message: 'nope' } }));
		expect(await CartService.lookupConvertedCheckout('tok_srv')).toEqual({ ok: false, reason: 'unavailable' });
		enqueue(respond(500, { error: { code: 'BOOM', message: 'boom' } }));
		expect(await CartService.lookupConvertedCheckout('tok_srv')).toEqual({ ok: false, reason: 'unavailable' });
		enqueue(Promise.reject(new TypeError('network down')));
		expect(await CartService.lookupConvertedCheckout('tok_srv')).toEqual({ ok: false, reason: 'unavailable' });
	});

	it('stays available without Web Locks (an unpaid order must stay payable)', async () => {
		removeLocks();
		enqueue(respond(200, lookupBody()));
		expect(await CartService.lookupConvertedCheckout('tok_srv')).toMatchObject({ ok: true });
	});
});

describe('no Web Locks → cart-changing flows fail closed (§6)', () => {
	it('every mutation throws `unsupported` before any request', async () => {
		removeLocks();
		setCookie('tok_srv');
		const attempts: Array<() => Promise<unknown>> = [
			() => CartService.addLine('SKU1', 1),
			() => CartService.updateLine('SKU1', 2),
			() => CartService.removeLine('SKU1'),
			() => CartService.applyCoupon('SAVE10'),
			() => CartService.removeCoupon(),
			() => CartService.captureEmail('a@b.c'),
			() => CartService.merge(),
			() => CartService.readFresh(),
			() => CartService.checkoutSnapshot(),
			() => CartService.retireSettled('ORD-A'),
			() => CartService.adoptConflict(serverCart(), 'tok_srv'),
			() => CartService.withLock(async () => 'never'),
		];
		for (const attempt of attempts) {
			await expect(attempt()).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/update your browser/) });
		}
		expect(calls).toHaveLength(0);
		expect(cookieValue()).toBe('tok_srv');
	});

	it('refresh stays available, updates the mirror only, and never clears the cookie', async () => {
		removeLocks();
		setCookie('tok_srv');
		enqueue(respond(200, serverCart({ revision: 3 })));
		await CartService.refresh();
		expect(CartService.getCart().revision).toBe(3);

		enqueue(notFound());
		await expect(CartService.refresh()).rejects.toMatchObject({ code: 'not_found' });
		expect(cookieValue()).toBe('tok_srv');
	});
});

describe('one lock owner per public operation (design §4.1a)', () => {
	it('the checkout runs the pre-submit read and the order POST inside ONE lock without deadlocking', async () => {
		setCookie('tok_srv');
		enqueue(
			respond(200, serverCart({ revision: 5 })), // live pre-submit read
			respond(200, { code: 'ORD-N', state: 'PendingPayment', grandTotal: 2500, receiptToken: 'rt_n' }),
		);
		const created = await CartService.withLock(async (scope) => {
			const snapshot = await refreshStockBeforeSubmit(scope);
			return placeOrder({ items: [{ sku: 'SKU1', quantity: 1 }] }, snapshot, scope);
		});
		expect(created.code).toBe('ORD-N');
		expect(locks.requests).toBe(1);
		const post = calls.find((c) => c.init.method === 'POST');
		expect(JSON.parse(String(post!.init.body))).toMatchObject({ cartToken: 'tok_srv', expectedRevision: 5 });
	});

	it('an independent refresh started during the checkout queues behind it', async () => {
		setCookie('tok_srv');
		const readRes = deferred();
		enqueue(readRes.promise, respond(200, serverCart({ revision: 6 })));

		const checkout = CartService.withLock(async (scope) => (await scope.readFresh()).revision);
		await waitForCalls(1);
		const refreshP = CartService.refresh();
		await settle();
		expect(calls).toHaveLength(1);

		readRes.resolve(await respond(200, serverCart({ revision: 5 })));
		expect(await checkout).toBe(5);
		await refreshP;
		expect(calls).toHaveLength(2);
		expect(CartService.getCart().revision).toBe(6);
		expect(locks.maxConcurrent).toBe(1);
	});

	it('removeLine takes the lock exactly once (it delegates to updateLine)', async () => {
		await seedMirror('tok_srv', 2);
		const before = locks.requests;
		enqueue(respond(200, serverCart({ revision: 3, lines: [] })));
		await CartService.removeLine('SKU1');
		expect(locks.requests - before).toBe(1);
	});

	it('a scope is dead once the lock is released', async () => {
		setCookie('tok_srv');
		let captured!: CartLockScope;
		await CartService.withLock(async (scope) => {
			captured = scope;
		});
		expect(() => captured.retire('tok_srv')).toThrow(/released/);
		expect(() => captured.adoptConflict(serverCart(), 'tok_srv')).toThrow(/released/);
		expect(() => captured.readFresh()).toThrow(/released/);
		expect(cookieValue()).toBe('tok_srv');
	});
});

describe('placeOrder with a converted cart (design §4.2)', () => {
	const form = { items: [{ sku: 'SKU1', quantity: 1 }] };

	it('a converted snapshot throws ConvertedCartError without any POST and keeps the token', async () => {
		setCookie('tok_srv');
		const outcome = await CartService.withLock((scope) =>
			placeOrder(form, { token: 'tok_srv', revision: 4, status: 'converted' }, scope),
		).catch((e) => e);
		expect(outcome).toBeInstanceOf(ConvertedCartError);
		expect(calls).toHaveLength(0);
		expect(cookieValue()).toBe('tok_srv');
	});

	it('a converted 409 keeps the token and mirrors the converted snapshot; a merged 409 retires it', async () => {
		setCookie('tok_srv');
		enqueue(respond(409, { error: { code: 'CART_CONVERTED', message: 'cart already converted' }, code: 'converted', revision: 4, cart: serverCart({ status: 'converted' }) }));
		const outcome = await CartService.withLock((scope) =>
			placeOrder(form, { token: 'tok_srv', revision: 4, status: 'active' }, scope),
		).catch((e) => e);
		expect(outcome).toBeInstanceOf(ConvertedCartError);
		expect(cookieValue()).toBe('tok_srv');
		expect(CartService.getCart().status).toBe('converted');

		enqueue(respond(409, { error: { code: 'CART_MERGED', message: 'cart merged' }, code: 'merged', revision: 4, cart: serverCart({ status: 'merged', lines: [] }) }));
		await CartService.withLock((scope) => placeOrder(form, { token: 'tok_srv', revision: 4, status: 'active' }, scope)).catch(() => undefined);
		expect(cookieValue()).toBeNull();
	});
});

describe('addLine — the add\'s own outcome (brand views PR2 §5)', () => {
	it('applied, with the response body\'s own line (not the mirror)', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart({ lines: [{ sku: 'SKU1', name: 'Widget', quantity: 4, unitPrice: 2500, lineSubtotal: 10000, lineDiscount: 0, lineTotal: 10000, available: false, availableQuantity: 3 }] })));
		const res = await CartService.addLine('SKU1', 1);
		expect(res.applied).toBe(true);
		expect(res.line).toMatchObject({ sku: 'SKU1', quantity: 4, available: false, availableQuantity: 3 });
	});

	it('not applied when another tab replaced the cookie while the request ran; the mirror is untouched by that response', async () => {
		setCookie('tok_srv');
		const gate = deferred<Response>();
		enqueue(gate.promise);
		const pending = CartService.addLine('SKU1', 1);
		await settle();
		setCookie('tok_other');
		gate.resolve(new Response(JSON.stringify(serverCart()), { status: 200, headers: { 'content-type': 'application/json' } }));
		const res = await pending;
		expect(res.applied).toBe(false);
		expect(res.cart.lines.find((l) => l.sku === 'SKU1')).toBeUndefined();
	});

	it('no line for the SKU in the response: line is null', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart({ lines: [] })));
		const res = await CartService.addLine('SKU9', 1);
		expect(res.applied).toBe(true);
		expect(res.line).toBeNull();
	});

	it('discard forgets the token and the mirror without a network call', async () => {
		setCookie('tok_srv');
		await CartService.discard();
		expect(cookieValue()).toBeNull();
		expect(calls).toHaveLength(0);
		expect(CartService.getCart().lines).toEqual([]);
	});
});
