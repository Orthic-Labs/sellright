/**
 * V27: a document loaded AT checkout makes ONE live cart GET for boot + checkout entry (the provider defers its boot to
 * the entry); any other path keeps the boot and the entry's own live read. Real CartService; only `fetch` and
 * `navigator.locks` are faked. The LOCKED entry read is never skipped: every entry makes a live GET.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// CartContext.tsx is a Qwik module: without the optimizer `$()` throws, so the QRL wrappers become plain functions here.
vi.mock('@qwik.dev/core', () => ({
	$: <T>(fn: T) => fn,
	component$: <T>(fn: T) => fn,
	createContextId: (id: string) => ({ id }),
	useContext: () => undefined,
	useContextProvider: () => undefined,
	useStore: <T>(v: T) => v,
	useOnDocument: () => undefined,
	Slot: () => null,
}));
import { CartService } from '~/services/CartService';
import { installLocks, removeLocks } from '~/services/cart-test-harness';
import { EMPTY_CART, type ServerCart } from '~/sellright/types/cart';
import { deferBootToCheckoutEntry, isBootDeferredToCheckoutEntry, isCheckoutEntryPath, loadCartIfNeeded, refreshCartLive, resetCheckoutBootForTest, startCheckoutEntryBoot, type CartContextState } from './CartContext';

/** The checkout route's entry sequence (routes/checkout/index.tsx enterCheckout), minus its view-generation checks. */
const readCartAtCheckoutEntry = async (state: CartContextState): Promise<'ok' | 'failed'> => {
	if (!isBootDeferredToCheckoutEntry(state)) await loadCartIfNeeded(state);
	return refreshCartLive(state);
};

let queue: Promise<Response>[] = [];
const respond = (status: number, body: unknown) =>
	Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const serverCart = (over: Partial<ServerCart> = {}): ServerCart => ({
	token: 'tok_srv', revision: 4, status: 'active', currency: 'USD', subtotal: 5000, discountTotal: 0, shippingTotal: 0, taxTotal: 0,
	grandTotal: 5000, unavailable: [], coupon: null, couponCodes: [], coupons: [], pointsDiscount: 0, pricingIntent: 'preview',
	quoteHash: '', shippingMethodCode: null, email: null, customerId: null,
	lines: [{ sku: 'SKU1', name: 'Widget', quantity: 2, unitPrice: 2500, lineSubtotal: 5000, lineDiscount: 0, lineTotal: 5000, available: true, availableQuantity: 0 }],
	...over,
});
const newState = (): CartContextState => ({ cart: EMPTY_CART, isLoading: true, lastError: null, hasLoadedOnce: false, isRefreshingStock: false, notice: null, lastKnownQuantity: null } as CartContextState);
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	queue = [];
	document.cookie = 'sr_cart=tok_srv; Path=/';
	installLocks();
	CartService['resetMirror']();
	resetCheckoutBootForTest();
	fetchMock = vi.fn(async () => {
		const next = queue.shift();
		if (!next) throw new Error('unstubbed fetch');
		return next;
	});
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	removeLocks();
	document.cookie = 'sr_cart=; Path=/; Max-Age=0';
	document.cookie = 'countryCode=; Path=/; Max-Age=0';
	CartService.setQuoteContext({});
});

/** The URL of the n-th fetch (the client passes a Request or a URL string). */
const urlOf = (n: number): URL => {
	const arg = fetchMock.mock.calls[n]?.[0] as Request | string | URL;
	return new URL(typeof arg === 'string' ? arg : arg instanceof URL ? arg.href : arg.url, 'http://localhost');
};
/** Let queued promise reactions (lock grant, fetch call) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('checkout entry cart read (V27)', () => {
	it('only the checkout page itself defers the boot', () => {
		expect(isCheckoutEntryPath('/checkout/')).toBe(true);
		expect(isCheckoutEntryPath('/checkout')).toBe(true);
		for (const p of ['/', '/shop/', '/checkout/confirmation/DD1/', '/checkout/facebook/', '/checkout/payment/']) expect(isCheckoutEntryPath(p)).toBe(false);
		expect(deferBootToCheckoutEntry('/shop/')).toBe(false);
	});

	it('document loaded at checkout: boot deferred, the entry makes ONE live GET that is also the boot', async () => {
		expect(deferBootToCheckoutEntry('/checkout/')).toBe(true);
		const state = newState();
		queue.push(respond(200, serverCart()));
		expect(await readCartAtCheckoutEntry(state)).toBe('ok');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(state.hasLoadedOnce).toBe(true);
		expect(state.isLoading).toBe(false);
		// Stock comes from that live response, fail-closed (availableQuantity 0 stays 0).
		expect(state.cart.lines[0]?.availableQuantity).toBe(0);
	});

	it('the deferral is consumed once: a second checkout entry on the same document makes its own live GET', async () => {
		deferBootToCheckoutEntry('/checkout/');
		const state = newState();
		queue.push(respond(200, serverCart()));
		await readCartAtCheckoutEntry(state);
		queue.push(respond(200, serverCart({ revision: 5 })));
		expect(await readCartAtCheckoutEntry(state)).toBe('ok');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(state.cart.revision).toBe(5);
	});

	it('no deferral (SPA navigation into checkout): boot, then the entry\'s own live GET — unchanged behaviour', async () => {
		const state = newState();
		queue.push(respond(200, serverCart()));
		queue.push(respond(200, serverCart({ revision: 6 })));
		expect(await readCartAtCheckoutEntry(state)).toBe('ok');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(state.cart.revision).toBe(6);
	});

	it('a cart opened before entry booted first: the entry still makes its own live GET (never reuses that boot)', async () => {
		deferBootToCheckoutEntry('/checkout/');
		const state = newState();
		queue.push(respond(200, serverCart()));
		await loadCartIfNeeded(state); // e.g. the drawer toggle
		queue.push(respond(200, serverCart({ revision: 7 })));
		await readCartAtCheckoutEntry(state);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(state.cart.revision).toBe(7);
	});

	it('a failed (non-definitive) deferred read reports failed, so entry never picks the normal checkout from it', async () => {
		deferBootToCheckoutEntry('/checkout/');
		const state = newState();
		queue.push(respond(503, { error: { code: 'UNAVAILABLE', message: 'down' } }));
		expect(await readCartAtCheckoutEntry(state)).toBe('failed');
		expect(state.hasLoadedOnce).toBe(false);
		expect(state.isLoading).toBe(false);
	});

	it('a missing cart (definitive) reports ok with the retired mirror', async () => {
		deferBootToCheckoutEntry('/checkout/');
		const state = newState();
		queue.push(respond(404, { error: { code: 'CART_NOT_FOUND', message: 'cart not found' } }));
		expect(await readCartAtCheckoutEntry(state)).toBe('ok');
		expect(state.cart.lines).toHaveLength(0);
	});
});

describe('#412: the checkout entry read starts at document start', () => {
	it('started by the provider, taken over by the entry: ONE live GET, sent with the checkout quote for the country cookie', async () => {
		document.cookie = 'countryCode=CA; Path=/';
		queue.push(respond(200, serverCart({ pricingIntent: 'checkout' })));
		expect(startCheckoutEntryBoot('/checkout/')).toBe(true);
		await settle();
		// Sent before the checkout page's code runs at all.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const url = urlOf(0);
		expect(url.searchParams.get('pricingIntent')).toBe('checkout');
		expect(url.searchParams.get('shipCountry')).toBe('CA');
		const state = newState();
		expect(await readCartAtCheckoutEntry(state)).toBe('ok');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(state.hasLoadedOnce).toBe(true);
		expect(state.isLoading).toBe(false);
		expect(state.cart.lines[0]?.availableQuantity).toBe(0); // the live response's stock, fail-closed
		// The pricing read for the same inputs has nothing to add (routes/checkout/index.tsx skips it).
		CartService.setQuoteContext({ pricingIntent: 'checkout', shipCountry: 'CA', shippingMethodCode: undefined });
		expect(CartService.currentQuoteAlreadyRead()).toBe(true);
	});

	it('once per document: the checkout shell starting it again (whichever qinit runs first) sends nothing more', async () => {
		queue.push(respond(200, serverCart()));
		startCheckoutEntryBoot('/checkout/');
		startCheckoutEntryBoot('/checkout/');
		await settle();
		await readCartAtCheckoutEntry(newState());
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(startCheckoutEntryBoot('/shop/')).toBe(false);
	});

	it('the pricing inputs moved while it was in flight: the entry reads again, live, under the new inputs', async () => {
		document.cookie = 'countryCode=US; Path=/';
		let release: (r: Response) => void = () => undefined;
		queue.push(new Promise<Response>((resolve) => { release = resolve; }));
		startCheckoutEntryBoot('/checkout/');
		await settle();
		CartService.setQuoteContext({ pricingIntent: 'checkout', shipCountry: 'DE' });
		release(await respond(200, serverCart({ pricingIntent: 'checkout' })));
		queue.push(respond(200, serverCart({ pricingIntent: 'checkout', revision: 9 })));
		const state = newState();
		expect(await readCartAtCheckoutEntry(state)).toBe('ok');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(urlOf(1).searchParams.get('shipCountry')).toBe('DE');
		expect(state.cart.revision).toBe(9);
		expect(state.cart.lines).toHaveLength(1);
	});

	it('a failed early read reports failed at entry (never the normal checkout from it)', async () => {
		queue.push(respond(503, { error: { code: 'UNAVAILABLE', message: 'down' } }));
		startCheckoutEntryBoot('/checkout/');
		await settle();
		const state = newState();
		expect(await readCartAtCheckoutEntry(state)).toBe('failed');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(state.hasLoadedOnce).toBe(false);
	});

	it('a cart opened before entry drops the early read: the entry still makes its own live GET', async () => {
		queue.push(respond(200, serverCart()));
		startCheckoutEntryBoot('/checkout/');
		const state = newState();
		await loadCartIfNeeded(state); // joins the boot in flight
		queue.push(respond(200, serverCart({ revision: 8 })));
		await readCartAtCheckoutEntry(state);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(state.cart.revision).toBe(8);
	});
});
