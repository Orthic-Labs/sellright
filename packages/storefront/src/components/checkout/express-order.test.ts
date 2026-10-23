import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConvertedCartError, type CartLockScope } from '~/services/CartService';
import { PreSubmitStockError } from '~/hooks/pre-submit-stock';
import { SellRightError } from '~/sellright/client';
import { createBuyNowCart, detachedCartScope, placeExpressOrder, type ExpressPlacementDeps } from './express-order';
import type { ExpressOrderForm } from './express-checkout';

const HASH = 'b'.repeat(64);
const form: ExpressOrderForm = {
	items: [{ sku: 'TEE-M', quantity: 1 }],
	email: 'w@example.net',
	shippingAddress: { fullName: 'W', line1: '1 St', country: 'US' },
	shippingMethodCode: 'free',
	acceptedQuoteHash: HASH,
};
const scope: CartLockScope = { readFresh: vi.fn(), adoptConflict: vi.fn(), retire: vi.fn() };
const snapshot = { token: 'tok', revision: 3, status: 'active', quoteHash: HASH };

const deps = (over: Partial<ExpressPlacementDeps> = {}): ExpressPlacementDeps & { order: string[] } => {
	const order: string[] = [];
	return {
		order,
		withCart: vi.fn(async (fn) => { order.push('lock'); return fn(scope); }),
		validate: vi.fn(async () => { order.push('live-read'); return snapshot; }),
		placeOrder: vi.fn(async () => { order.push('order'); return { code: 'SR9', receiptToken: 'rt9', grandTotal: 7500 }; }),
		createPaymentIntent: vi.fn(async () => { order.push('intent'); return { clientSecret: 'pi_9_secret' }; }),
		onStockConflict: vi.fn(async () => undefined),
		...over,
	};
};

describe('placeExpressOrder', () => {
	it('live read, then the order from that read, then the intent for exactly the wallet total', async () => {
		const d = deps();
		expect(await placeExpressOrder(d, form, 7500)).toEqual({ ok: true, clientSecret: 'pi_9_secret', code: 'SR9', receiptToken: 'rt9' });
		expect(d.order).toEqual(['lock', 'live-read', 'order', 'intent']);
		expect(d.placeOrder).toHaveBeenCalledWith(form, snapshot, scope);
		expect(d.createPaymentIntent).toHaveBeenCalledWith('SR9', 'rt9', 7500);
	});

	it('refuses a server total different from the one the wallet showed, minting nothing', async () => {
		const d = deps({ placeOrder: vi.fn(async () => ({ code: 'SR9', receiptToken: 'rt9', grandTotal: 8000 })) });
		expect(await placeExpressOrder(d, form, 7500)).toEqual({ ok: false, message: 'Your total changed. Please review it and try again.' });
		expect(d.createPaymentIntent).not.toHaveBeenCalled();
	});

	it('stops at a failed live stock read and re-reads the shopper cart', async () => {
		const d = deps({ validate: vi.fn(async () => { throw new PreSubmitStockError('Tee: Out of stock. Please remove from cart.'); }) });
		expect(await placeExpressOrder(d, form, 7500)).toEqual({ ok: false, message: 'Tee: Out of stock. Please remove from cart.' });
		expect(d.placeOrder).not.toHaveBeenCalled();
		expect(d.onStockConflict).toHaveBeenCalledOnce();
	});

	it('treats a 409 OUT_OF_STOCK at order creation as a stock conflict', async () => {
		const cause = new SellRightError(409, { error: { code: 'OUT_OF_STOCK', message: 'gone' } });
		const d = deps({ placeOrder: vi.fn(async () => { throw Object.assign(new Error('Out of stock'), { cause }); }) });
		expect(await placeExpressOrder(d, form, 7500)).toMatchObject({ ok: false, message: 'Out of stock' });
		expect(d.onStockConflict).toHaveBeenCalledOnce();
	});

	it('sends a converted cart to checkout instead of creating a second order', async () => {
		const d = deps({ validate: vi.fn(async () => { throw new ConvertedCartError(); }) });
		expect(await placeExpressOrder(d, form, 7500)).toEqual({ ok: false, message: 'This cart already has an order waiting for payment. Please continue at checkout.' });
		expect(d.onStockConflict).not.toHaveBeenCalled();
	});

	it('reports a refused or empty payment intent', async () => {
		expect(await placeExpressOrder(deps({ createPaymentIntent: vi.fn(async () => { throw new Error('Amount mismatch'); }) }), form, 7500)).toEqual({ ok: false, message: 'Amount mismatch' });
		expect(await placeExpressOrder(deps({ createPaymentIntent: vi.fn(async () => ({ clientSecret: null })) }), form, 7500)).toEqual({ ok: false, message: "We couldn't start your payment. Please try again." });
	});
});

describe('buy-now cart transport', () => {
	const seen: Request[] = [];
	const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
	beforeEach(() => {
		seen.length = 0;
		vi.stubGlobal('fetch', vi.fn(async (r: Request) => { seen.push(r); return reply({ token: 'buy_tok', revision: 1, status: 'active', lines: [] }); }));
	});
	afterEach(() => vi.unstubAllGlobals());

	it('creates a seeded single-line cart without credentials (no customer, no cookie cart)', async () => {
		expect(await createBuyNowCart([{ sku: 'TEE-M', quantity: 1 }])).toBe('buy_tok');
		expect(seen).toHaveLength(1);
		expect(seen[0]!.method).toBe('POST');
		expect(new URL(seen[0]!.url).pathname).toBe('/v1/shop/cart');
		expect(seen[0]!.credentials).toBe('omit');
		expect(await seen[0]!.clone().json()).toEqual({ items: [{ sku: 'TEE-M', quantity: 1 }] });
	});

	it('reads the buy-now cart live, priced in the wallet quote context, and touches no mirror', async () => {
		const s = detachedCartScope('buy_tok', { shipCountry: 'US', shippingMethodCode: 'free' });
		expect((await s.readFresh()).token).toBe('buy_tok');
		const url = new URL(seen[0]!.url);
		expect(seen[0]!.method).toBe('GET');
		expect(url.pathname).toBe('/v1/shop/cart/buy_tok');
		expect(Object.fromEntries(url.searchParams)).toEqual({ pricingIntent: 'checkout', shipCountry: 'US', shippingMethodCode: 'free' });
		expect(() => s.adoptConflict({} as never, 'buy_tok')).not.toThrow();
		expect(() => s.retire('buy_tok')).not.toThrow();
	});
});
