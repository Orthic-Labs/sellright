/**
 * Consumer-contract tests for ServerCartService — the server-authoritative
 * cart mirror. Asserts the wire contract (append vs revisioned set), conflict
 * adoption, and terminal-cart retirement. fetch is mocked; jsdom supplies
 * document.cookie + localStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/services/LocalCartService', () => {
	let stored: any = { items: [], totalQuantity: 0, subTotal: 0, currencyCode: 'USD', countryCode: 'US', countryExplicitlySet: false, appliedCoupon: null };
	return {
		LocalCartService: {
			getCart: () => stored,
			saveCart: (c: any) => { stored = c; },
			getCountry: () => 'US',
			hasExplicitCountrySelection: () => false,
			lineUnitPrice: (i: any) => i.productVariant?.price ?? 0,
			getCartQuantityFromStorage: () => stored.totalQuantity,
			__set: (c: any) => { stored = c; },
			__get: () => stored,
		},
	};
});

import { ServerCartService } from './ServerCartService';
import { LocalCartService } from '~/services/LocalCartService';

const LCS = LocalCartService as unknown as {
	__set: (c: any) => void;
	__get: () => any;
};

type FetchCall = { url: string; init: RequestInit };
const calls: FetchCall[] = [];
let queue: Promise<Response>[] = [];
const respond = (status: number, body: unknown) =>
	Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const enqueue = (...r: Promise<Response>[]) => queue.push(...r);

const serverCart = (over: Record<string, unknown> = {}) => ({
	token: 'tok_srv',
	revision: 1,
	status: 'active',
	currency: 'USD',
	subtotal: 2500,
	discountTotal: 0,
	lines: [{ sku: 'SKU1', name: 'Widget', quantity: 1, unitPrice: 2500, available: true }],
	...over,
});

const item = (qty = 1) => ({
	productVariantId: 'SKU1',
	quantity: qty,
	productVariant: {
		id: 'SKU1',
		name: 'Widget',
		price: 2500,
		stockLevel: '999',
		product: { id: 'p1', name: 'Widget', slug: 'widget' },
		options: [],
		featuredAsset: null,
	},
	sku: 'SKU1',
}) as any;

const setCookie = (v: string) => { document.cookie = `sr_cart=${v}; Path=/`; };
const clearCookie = () => { document.cookie = 'sr_cart=; Path=/; Max-Age=0'; };

beforeEach(() => {
	calls.length = 0;
	queue = [];
	clearCookie();
	LCS.__set({ items: [], totalQuantity: 0, subTotal: 0, currencyCode: 'USD', countryCode: 'US', countryExplicitlySet: false, appliedCoupon: null });
	// Reset the service's statics via a discard (also clears token/revision).
	ServerCartService.discardLocal();
	vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		const next = queue.shift();
		if (!next) throw new Error(`unstubbed fetch: ${url}`);
		return next;
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
	clearCookie();
});

const patchCalls = () => calls.filter((c) => c.init.method === 'PATCH');

describe('addItem — blind append', () => {
	it('creates the cart lazily then appends without a revision', async () => {
		enqueue(
			respond(200, serverCart()),                       // POST /cart (ensureCart)
			respond(200, serverCart({ revision: 2, lines: [{ sku: 'SKU1', name: 'Widget', quantity: 2, unitPrice: 2500, available: true }], subtotal: 5000 })), // PATCH lines
		);
		const res = await ServerCartService.addItem(item(2));
		const create = calls.find((c) => c.url.endsWith('/v1/shop/cart'));
		expect(create?.init.method).toBe('POST');
		const patch = patchCalls()[0];
		expect(patch.url.replace(/^https?:\/\/[^/]+/, '')).toBe('/v1/shop/cart/tok_srv/lines');
		const body = JSON.parse(String(patch.init.body));
		expect(body).toEqual({ lines: [{ sku: 'SKU1', quantity: 2 }] });
		expect(body.expectedRevision).toBeUndefined();
		expect(res.cart.totalQuantity).toBe(2);
		expect(res.cart.subTotal).toBe(5000); // server-priced mirror wins
	});
});

describe('updateItemQuantity — revisioned absolute set', () => {
	it('echoes the live revision; quantity 0 removes', async () => {
		setCookie('tok_srv');
		LCS.__set({ items: [item(1)], totalQuantity: 1, subTotal: 2500, currencyCode: 'USD', countryCode: 'US', countryExplicitlySet: false, appliedCoupon: null });
		enqueue(
			respond(200, serverCart({ revision: 4 })),        // GET (ensureRevision)
			respond(200, serverCart({ revision: 5, lines: [], subtotal: 0 })), // PATCH set
		);
		const res = await ServerCartService.updateItemQuantity('SKU1', 0);
		const get = calls.find((c) => !c.init.method || c.init.method === 'GET');
		expect(get?.url.replace(/^https?:\/\/[^/]+/, '')).toBe('/v1/shop/cart/tok_srv');
		const patch = patchCalls()[0];
		const body = JSON.parse(String(patch.init.body));
		expect(body.expectedRevision).toBe(4);
		// Absolute SET touches only sent lines — removal is an explicit qty-0 row.
		expect(body.lines).toEqual([{ sku: 'SKU1', quantity: 0 }]);
		expect(res.cart.items).toHaveLength(0);
	});
});

describe('conflict + terminal handling', () => {
	it('409 stale adopts the server snapshot and reports a recoverable error', async () => {
		setCookie('tok_srv');
		LCS.__set({ items: [item(1)], totalQuantity: 1, subTotal: 2500, currencyCode: 'USD', countryCode: 'US', countryExplicitlySet: false, appliedCoupon: null });
		enqueue(
			respond(200, serverCart({ revision: 4 })),        // GET (ensureRevision)
			respond(409, {
				error: 'cart changed', code: 'stale', revision: 6,
				cart: serverCart({ revision: 6, lines: [{ sku: 'SKU1', name: 'Widget', quantity: 3, unitPrice: 2400, available: true }], subtotal: 7200 }),
			}),
		);
		const res = await ServerCartService.updateItemQuantity('SKU1', 5);
		expect(res.stockResult.success).toBe(false);
		expect(res.stockResult.error).toContain('Cart changed');
		// Mirror adopted the conflict snapshot — not the optimistic 5.
		const mirror = ServerCartService.getCart();
		expect(mirror.items[0].quantity).toBe(3);
		expect(mirror.subTotal).toBe(7200);
	});

	it('409 converted retires the token and mirror outright', async () => {
		setCookie('tok_srv');
		LCS.__set({ items: [item(1)], totalQuantity: 1, subTotal: 2500, currencyCode: 'USD', countryCode: 'US', countryExplicitlySet: false, appliedCoupon: null });
		enqueue(
			respond(200, serverCart({ revision: 4 })),
			respond(409, { error: 'converted', code: 'converted', revision: 4, cart: serverCart({ status: 'converted' }) }),
		);
		const res = await ServerCartService.updateItemQuantity('SKU1', 2);
		expect(res.stockResult.success).toBe(false);
		expect(res.stockResult.error).toContain('checked out');
		expect(ServerCartService.getCart().items).toHaveLength(0);
		expect(document.cookie).not.toContain('sr_cart=tok_srv');
	});

	it('404 on refresh retires the local cart', async () => {
		setCookie('tok_srv');
		LCS.__set({ items: [item(1)], totalQuantity: 1, subTotal: 2500, currencyCode: 'USD', countryCode: 'US', countryExplicitlySet: false, appliedCoupon: null });
		enqueue(respond(404, { error: 'not found' }));
		await ServerCartService.refresh();
		expect(ServerCartService.getCart().items).toHaveLength(0);
	});
});

describe('coupon apply/remove — server-priced', () => {
	it('applyCoupon validates against the real cart and stores the code', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart({
			coupon: { code: 'SAVE10', applied: true },
			discountTotal: 500,
			subtotal: 2000,
		})));
		const res = await ServerCartService.applyCoupon('SAVE10');
		expect(res.valid).toBe(true);
		const url = calls[calls.length - 1].url;
		expect(url).toContain('couponCode=SAVE10');
		expect(ServerCartService.getCart().appliedCoupon?.code).toBe('SAVE10');
		expect(ServerCartService.getCart().appliedCoupon?.discountAmount).toBe(500);
	});

	it('a rejected code surfaces the server reason and keeps no coupon', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart({ coupon: { code: 'BAD', applied: false, reason: 'expired' } })));
		const res = await ServerCartService.applyCoupon('BAD');
		expect(res.valid).toBe(false);
		expect(res.reason).toBe('expired');
	});

	it('subsequent priced calls re-pass the held coupon', async () => {
		setCookie('tok_srv');
		enqueue(
			respond(200, serverCart({ coupon: { code: 'SAVE10', applied: true }, discountTotal: 500 })),
			respond(200, serverCart({ revision: 2 })),
		);
		await ServerCartService.applyCoupon('SAVE10');
		await ServerCartService.refresh();
		expect(calls[calls.length - 1].url).toContain('couponCode=SAVE10');
	});

	it('removeCoupon re-prices without the code and clears it', async () => {
		setCookie('tok_srv');
		enqueue(
			respond(200, serverCart({ coupon: { code: 'SAVE10', applied: true }, discountTotal: 500 })),
			respond(200, serverCart({ coupon: null })),
		);
		await ServerCartService.applyCoupon('SAVE10');
		await ServerCartService.removeCoupon();
		expect(calls[calls.length - 1].url).not.toContain('couponCode=');
		expect(ServerCartService.getCart().appliedCoupon).toBeNull();
	});
});

describe('checkoutSnapshot', () => {
	it('returns token + live revision + status for checkout', async () => {
		setCookie('tok_srv');
		enqueue(respond(200, serverCart({ revision: 8 })));
		const snap = await ServerCartService.checkoutSnapshot();
		expect(snap).toEqual({ token: 'tok_srv', revision: 8, status: 'active' });
	});

	it('returns null when no token exists', async () => {
		expect(await ServerCartService.checkoutSnapshot()).toBeNull();
		expect(calls).toHaveLength(0);
	});
});
