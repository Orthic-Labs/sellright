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
import { deferBootToCheckoutEntry, isBootDeferredToCheckoutEntry, isCheckoutEntryPath, loadCartIfNeeded, refreshCartLive, resetCheckoutBootForTest, type CartContextState } from './CartContext';

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
});

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
