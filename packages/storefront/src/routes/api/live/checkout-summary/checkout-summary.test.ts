// ADR-0001: GET /api/live/checkout-summary/ (the checkout shell's order summary read). Never cacheable anywhere; the same cart read
// and the same numbers as the server-rendered summary; empty, without an API call, when there is no cart cookie.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerCart } from '~/sellright/types/cart';
import { NO_STORE_CACHE_CONTROL, requestRouteClass, routeClass, shellResponseVerdict } from '~/config/route-cache-policy';
import { readCheckoutServerCart, serverCartShipCountry } from '~/routes/checkout/summary-cart';

const get = vi.hoisted(() => vi.fn());
vi.mock('~/sellright/client', () => ({ sellright: () => ({ GET: get }) }));

import { onGet } from './index';

const serverCart = (over: Partial<ServerCart> = {}): ServerCart => ({
	token: 'tok_srv', revision: 4, status: 'active', currency: 'USD', subtotal: 5000, discountTotal: 0, shippingTotal: 800, taxTotal: 0,
	grandTotal: 5800, unavailable: [], coupon: null, couponCodes: [], coupons: [], pointsDiscount: 0, pricingIntent: 'checkout',
	quoteHash: 'qh1', shippingMethodCode: 'std', email: 'a@b.c', customerId: 'cus_1',
	lines: [{ sku: 'SKU1', name: 'Widget', quantity: 2, unitPrice: 2500, lineSubtotal: 5000, lineDiscount: 0, lineTotal: 5000, available: true, availableQuantity: 3, image: 'p/w.jpg' } as ServerCart['lines'][number]],
	...over,
} as ServerCart);

async function call(cookies: Record<string, string>, ipCountry?: string) {
	const headers = new Map<string, string>();
	let out: { status: number; body: { cart: Record<string, unknown> | null } } | undefined;
	await (onGet as unknown as (ev: unknown) => Promise<void>)({
		cookie: { get: (n: string) => (cookies[n] !== undefined ? { value: cookies[n] } : null) },
		headers: { set: (k: string, v: string) => headers.set(k.toLowerCase(), v) },
		json: (status: number, body: never) => { out = { status, body }; },
		request: new Request('https://shop.test/api/live/checkout-summary/', { headers: ipCountry ? { 'cf-ipcountry': ipCountry } : {} }),
	});
	return { headers, out: out! };
}

beforeEach(() => { get.mockReset(); });

describe('/api/live/checkout-summary/', () => {
	it('is never cacheable: private no-store for browser and edge, Vary: Cookie, a dynamic route class that can never be a shell', async () => {
		get.mockResolvedValue({ data: serverCart() });
		for (const cookies of [{}, { sr_cart: 'tok_srv' }] as Record<string, string>[]) {
			const { headers } = await call(cookies);
			expect(headers.get('cache-control')).toBe(NO_STORE_CACHE_CONTROL);
			expect(headers.get('cache-control')).not.toMatch(/public|s-maxage|max-age=[1-9]/);
			expect(headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
			expect(headers.get('vary')).toBe('Cookie');
		}
		expect(routeClass('/api/live/checkout-summary/', new URLSearchParams())).toBe('dynamic');
		expect(requestRouteClass({ method: 'GET', pathname: '/api/live/checkout-summary/', search: '', cookie: undefined })).toBe('dynamic');
		const facts = { routeClass: 'dynamic' as const, anonymous: true, enabled: true, status: 200, contentType: 'application/json', setCookie: undefined, veto: undefined };
		expect(shellResponseVerdict(facts).ok).toBe(false);
	});

	it('no sr_cart cookie: an empty-cart answer, no API call', async () => {
		for (const cookies of [{}, { sr_cart: '' }, { countryCode: 'DE' }] as Record<string, string>[]) {
			const { out } = await call(cookies);
			expect(out).toEqual({ status: 200, body: { cart: null } });
		}
		expect(get).not.toHaveBeenCalled();
	});

	it('returns the same cart, with the same totals, as the server-rendered summary reads for the fixture cart', async () => {
		get.mockResolvedValue({ data: serverCart() });
		const { out } = await call({ sr_cart: 'tok_srv', countryCode: 'de' });
		const server = await readCheckoutServerCart((path, init) => get(path, init), 'tok_srv', serverCartShipCountry('de'));
		expect(out.status).toBe(200);
		expect(out.body.cart).toEqual(server);
		expect(out.body.cart).toMatchObject({ subtotal: 5000, discountTotal: 0, shippingTotal: 800, grandTotal: 5800, quoteHash: 'qh1', pricingIntent: 'checkout', status: 'active' });
		// The same call the server summary makes: the cart cookie, the checkout quote, the cookie's country (or the default US).
		expect(get).toHaveBeenCalledWith('/v1/shop/cart/{token}', expect.objectContaining({ params: { path: { token: 'tok_srv' }, query: { pricingIntent: 'checkout', shipCountry: 'DE', includeShippingMethods: '1' } } }));
		// Identity stays out of the answer (toDisplayCart).
		expect(out.body.cart).toMatchObject({ token: '', email: null, customerId: null });
		await call({ sr_cart: 'tok_srv' });
		expect(get).toHaveBeenLastCalledWith('/v1/shop/cart/{token}', expect.objectContaining({ params: { path: { token: 'tok_srv' }, query: { pricingIntent: 'checkout', shipCountry: 'US', includeShippingMethods: '1' } } }));
	});

	it('every doubt is an empty answer, never an error body: failed read, another cart, converted, non-checkout quote, no lines', async () => {
		const cases: Array<() => void> = [
			() => get.mockRejectedValue(new Error('500')),
			() => get.mockResolvedValue({}),
			() => get.mockResolvedValue({ data: serverCart({ token: 'someone-else' }) }),
			() => get.mockResolvedValue({ data: serverCart({ status: 'converted' } as Partial<ServerCart>) }),
			() => get.mockResolvedValue({ data: serverCart({ pricingIntent: 'preview' }) }),
			() => get.mockResolvedValue({ data: serverCart({ lines: [] }) }),
		];
		for (const setup of cases) {
			get.mockReset();
			setup();
			expect((await call({ sr_cart: 'tok_srv' })).out).toEqual({ status: 200, body: { cart: null } });
		}
	});

	it('reads live on every call: nothing is kept between requests', async () => {
		get.mockResolvedValue({ data: serverCart() });
		await call({ sr_cart: 'tok_srv' });
		get.mockResolvedValue({ data: serverCart({ grandTotal: 6100 }) });
		expect((await call({ sr_cart: 'tok_srv' })).out.body.cart).toMatchObject({ grandTotal: 6100 });
		expect(get).toHaveBeenCalledTimes(2);
	});
});

describe("#425: the summary quotes shipping for the visitor country", () => {
	it("no country cookie: quotes the edge country (cf-ipcountry) with shipping; the cookie still wins", async () => {
		get.mockReset();
		get.mockResolvedValue({ data: serverCart() });
		await call({ sr_cart: "tok_srv" }, "IN");
		expect(get).toHaveBeenLastCalledWith("/v1/shop/cart/{token}", expect.objectContaining({ params: { path: { token: "tok_srv" }, query: { pricingIntent: "checkout", shipCountry: "IN", includeShippingMethods: "1" } } }));
		await call({ sr_cart: "tok_srv", countryCode: "DE" }, "IN");
		expect(get).toHaveBeenLastCalledWith("/v1/shop/cart/{token}", expect.objectContaining({ params: { path: { token: "tok_srv" }, query: { pricingIntent: "checkout", shipCountry: "DE", includeShippingMethods: "1" } } }));
	});
});
