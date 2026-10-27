import { describe, expect, it, vi } from 'vitest';
import type { ExpressQuote } from '~/sellright/types/checkout';
import {
	EXPRESS_PAYMENT_METHODS,
	expressMethods,
	buyNowItems,
	expressButtonHeight,
	expressCheckoutOptions,
	expressElementOptions,
	expressGateway,
	hasExpressMethod,
	isChargeableQuote,
	NO_SHIPPING_RATE_ID,
	runExpressConfirm,
	toWalletQuote,
	walletOrderForm,
	type ExpressConfirmDeps,
	type WalletConfirm,
} from './express-checkout';

const HASH = 'a'.repeat(64);
const quote = (over: Partial<ExpressQuote> = {}, cart: Partial<ExpressQuote['cart']> = {}): ExpressQuote => ({
	requiresShipping: true,
	shippingMethodCode: 'express',
	methods: [{ code: 'standard', name: 'Standard', rate: 500 }, { code: 'express', name: 'Express', rate: 1500 }],
	...over,
	cart: { grandTotal: 4400, quoteHash: HASH, currency: 'USD', ...cart } as ExpressQuote['cart'],
});
const base = { gatewayConfigured: true, publishableKey: 'pk_test_x', currency: 'USD', cartToken: 'tok', cartEmpty: false, noOrderYet: true };

describe('expressCheckoutOptions', () => {
	it('shows only with a configured gateway, a non-empty cart and no order in progress', () => {
		expect(expressCheckoutOptions(base)).toEqual({ publishableKey: 'pk_test_x', currency: 'usd', cartToken: 'tok' });
		for (const off of [{ gatewayConfigured: false }, { publishableKey: '' }, { cartToken: null }, { cartEmpty: true }, { noOrderYet: false }, { currency: 'US' }, { currency: null }]) {
			expect(expressCheckoutOptions({ ...base, ...off })).toBeNull();
		}
	});
});

describe('toWalletQuote', () => {
	it('uses only server amounts and puts the priced method first', () => {
		const wq = toWalletQuote('us', quote());
		expect(wq).toMatchObject({ country: 'US', grandTotal: 4400, quoteHash: HASH, currency: 'usd', shippingMethodCode: 'express' });
		expect(wq.rates).toEqual([{ id: 'express', displayName: 'Express', amount: 1500 }, { id: 'standard', displayName: 'Standard', amount: 500 }]);
	});

	it('offers a single zero rate for a cart with nothing to ship', () => {
		const wq = toWalletQuote('US', quote({ requiresShipping: false, shippingMethodCode: null, methods: [] }));
		expect(wq.rates).toEqual([{ id: NO_SHIPPING_RATE_ID, displayName: 'No shipping required', amount: 0 }]);
	});

	it('treats a zero or malformed total as not chargeable', () => {
		expect(isChargeableQuote(toWalletQuote('US', quote({}, { grandTotal: 0 })))).toBe(false);
		expect(isChargeableQuote(toWalletQuote('US', quote({}, { quoteHash: 'nope' })))).toBe(false);
		expect(isChargeableQuote(null)).toBe(false);
	});
});

const confirmEvent = (over: Partial<WalletConfirm> = {}): WalletConfirm => ({
	billingDetails: { name: 'Wallet Buyer', email: 'buyer@example.invalid', phone: '+15555550100', address: { line1: '9 Bill St', city: 'Billtown', state: 'NY', postal_code: '10001', country: 'US' } },
	shippingAddress: { name: 'Wallet Buyer', address: { line1: '1 Test St', line2: null, city: 'Testville', state: 'CA', postal_code: '94000', country: 'US' } },
	shippingRate: { id: 'express' },
	...over,
});

describe('walletOrderForm', () => {
	it('builds the checkout request with the quote hash as consent and the wallet addresses', () => {
		const form = walletOrderForm(toWalletQuote('US', quote()), confirmEvent(), { couponCodes: ['SAVE'], items: [{ sku: 'A', quantity: 1 }], redeemPoints: 0 });
		expect(form).toEqual({
			items: [{ sku: 'A', quantity: 1 }],
			email: 'buyer@example.invalid',
			shippingAddress: { fullName: 'Wallet Buyer', line1: '1 Test St', line2: '', city: 'Testville', province: 'CA', postalCode: '94000', country: 'US', phone: '+15555550100' },
			billingAddress: { fullName: 'Wallet Buyer', line1: '9 Bill St', line2: '', city: 'Billtown', province: 'NY', postalCode: '10001', country: 'US' },
			shippingMethodCode: 'express',
			couponCodes: ['SAVE'],
			acceptedQuoteHash: HASH,
		});
	});

	it('refuses a country, rate or missing email that differs from the quote the wallet showed', () => {
		const q = toWalletQuote('US', quote());
		expect(walletOrderForm(q, confirmEvent({ shippingAddress: { name: 'X', address: { line1: '1', country: 'CA' } } }), {})).toMatchObject({ ok: false, reason: 'invalid_shipping_address' });
		expect(walletOrderForm(q, confirmEvent({ shippingRate: { id: 'standard' } }), {})).toMatchObject({ ok: false, reason: 'fail' });
		expect(walletOrderForm(q, confirmEvent({ billingDetails: { name: 'X', email: '' } }), {})).toMatchObject({ ok: false, message: 'An email address is required to place your order.' });
		expect(walletOrderForm(null, confirmEvent(), {})).toMatchObject({ ok: false });
	});
});

describe('runExpressConfirm', () => {
	const deps = (over: Partial<ExpressConfirmDeps> = {}): ExpressConfirmDeps => ({
		quote: () => toWalletQuote('US', quote()),
		extra: () => ({ couponCodes: [] }),
		submit: vi.fn(async () => null),
		placeOrder: vi.fn(async () => ({ ok: true as const, clientSecret: 'pi_1_secret', code: 'SR1', receiptToken: 'rt' })),
		confirm: vi.fn(async () => null),
		returnUrl: (code, rt) => `https://shop.example/checkout/confirmation/${code}?rt=${rt}`,
		...over,
	});

	it('creates the order at the wallet total, then confirms that order\'s intent', async () => {
		const d = deps();
		expect(await runExpressConfirm(d, confirmEvent())).toEqual({ ok: true });
		expect(d.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ acceptedQuoteHash: HASH, shippingMethodCode: 'express' }), 4400);
		expect(d.confirm).toHaveBeenCalledWith('pi_1_secret', 'https://shop.example/checkout/confirmation/SR1?rt=rt');
	});

	it('fails closed without confirming when the order step refuses (stock, changed total, mint mismatch)', async () => {
		const d = deps({ placeOrder: vi.fn(async () => ({ ok: false as const, message: 'Item: Out of stock. Please remove from cart.' })) });
		expect(await runExpressConfirm(d, confirmEvent())).toEqual({ ok: false, reason: 'fail', message: 'Item: Out of stock. Please remove from cart.' });
		expect(d.confirm).not.toHaveBeenCalled();
	});

	it('never places an order when the wallet details are invalid or the gateway rejects them', async () => {
		const mismatch = deps();
		await runExpressConfirm(mismatch, confirmEvent({ shippingRate: { id: 'standard' } }));
		expect(mismatch.submit).not.toHaveBeenCalled();
		expect(mismatch.placeOrder).not.toHaveBeenCalled();
		const rejected = deps({ submit: vi.fn(async () => 'Card declined') });
		expect(await runExpressConfirm(rejected, confirmEvent())).toEqual({ ok: false, reason: 'fail', message: 'Card declined' });
		expect(rejected.placeOrder).not.toHaveBeenCalled();
	});

	it('reports a failed wallet confirmation (the order stays payable through the payment form)', async () => {
		const d = deps({ confirm: vi.fn(async () => 'Payment could not be completed.') });
		expect(await runExpressConfirm(d, confirmEvent())).toEqual({ ok: false, reason: 'fail', message: 'Payment could not be completed.' });
	});
});

describe('expressGateway', () => {
	it('mounts for a configured gateway and a valid currency, with or without a cart', () => {
		expect(expressGateway({ gatewayConfigured: true, publishableKey: ' pk_test_x ', currency: 'USD' })).toEqual({ publishableKey: 'pk_test_x', currency: 'usd' });
		for (const off of [{ gatewayConfigured: false }, { publishableKey: '' }, { publishableKey: null }, { currency: 'US' }, { currency: undefined }]) {
			expect(expressGateway({ gatewayConfigured: true, publishableKey: 'pk_test_x', currency: 'USD', ...off })).toBeNull();
		}
	});
});

describe('expressButtonHeight', () => {
	it('clamps to the gateway range and rounds; nothing given keeps the default', () => {
		expect(expressButtonHeight(48)).toBe(48);
		expect(expressButtonHeight(47.6)).toBe(48);
		expect(expressButtonHeight(30)).toBe(40);
		expect(expressButtonHeight(64)).toBe(55);
		for (const none of [undefined, null, 0, -4, Number.NaN, Number.POSITIVE_INFINITY]) expect(expressButtonHeight(none)).toBeUndefined();
	});
});

describe('expressElementOptions', () => {
	it('always collects email, phone and a shipping address and uses the Buy call to action', () => {
		const o = expressElementOptions();
		expect(o).toMatchObject({ emailRequired: true, phoneNumberRequired: true, shippingAddressRequired: true, buttonType: { applePay: 'buy', googlePay: 'buy' } });
		expect(o).not.toHaveProperty('buttonHeight');
		expect(o.paymentMethods).toEqual({ applePay: 'auto', googlePay: 'auto', link: 'auto', klarna: 'auto', paypal: 'never', amazonPay: 'never' });
		expect(expressElementOptions({ buttonHeight: 52 })).toMatchObject({ buttonHeight: 52 });
		expect(expressElementOptions({ buttonHeight: 80 })).toMatchObject({ buttonHeight: 55 });
		expect(o).not.toHaveProperty('layout');
	});
	it('walletsOnly offers just Apple Pay / Google Pay as one button with no overflow', () => {
		const o = expressElementOptions({ walletsOnly: true, buttonHeight: 48 });
		expect(o.paymentMethods).toEqual({ applePay: 'auto', googlePay: 'auto', link: 'never', klarna: 'never', paypal: 'never', amazonPay: 'never' });
		expect(o).toMatchObject({ layout: { maxColumns: 1, maxRows: 0, overflow: 'never' }, buttonHeight: 48, shippingAddressRequired: true });
	});
	it('singleRow keeps every method in one row (PDP buy-now, #347); walletsOnly wins over it', () => {
		const o = expressElementOptions({ singleRow: true, buttonHeight: 53 });
		expect(o.paymentMethods).toEqual(EXPRESS_PAYMENT_METHODS);
		// Stripe refuses overflow 'never' together with maxRows > 0, so overflow stays at its default.
		expect(o).toMatchObject({ layout: { maxColumns: 0, maxRows: 1 }, buttonHeight: 53 });
		expect((o as { layout?: object }).layout).not.toHaveProperty('overflow');
		expect(expressElementOptions({ singleRow: true, walletsOnly: true })).toMatchObject({ layout: { maxColumns: 1, maxRows: 0, overflow: 'never' } });
		// #400: Stripe rejects overflow 'never' unless maxRows is 0 (IntegrationError on phones before).
		for (const opts of [{ walletsOnly: true }, { singleRow: true }, { singleRow: true, walletsOnly: true }, {}]) {
			const layout = (expressElementOptions(opts) as { layout?: { maxRows?: number; overflow?: string } }).layout;
			if (layout?.overflow === 'never') expect(layout.maxRows).toBe(0);
		}
	});
});

describe('expressMethods (#347)', () => {
	it('lists the offered methods in display order', () => {
		expect(expressMethods(undefined)).toEqual([]);
		expect(expressMethods({ link: true })).toEqual(['link']);
		expect(expressMethods({ link: true, applePay: true, paypal: true, klarna: false })).toEqual(['applePay', 'link']);
	});
});

describe('hasExpressMethod', () => {
	it('is true only when the gateway reports a method the express row offers', () => {
		expect(hasExpressMethod(undefined)).toBe(false);
		expect(hasExpressMethod({ applePay: false, googlePay: false, paypal: true, amazonPay: true })).toBe(false);
		expect(hasExpressMethod({ applePay: true })).toBe(true);
		expect(hasExpressMethod({ googlePay: true })).toBe(true);
		expect(hasExpressMethod({ link: true })).toBe(true);
		expect(hasExpressMethod({ klarna: true })).toBe(true);
	});
});

describe('buyNowItems', () => {
	it('is exactly one unit of a selected variant, nothing without one', () => {
		expect(buyNowItems('TEE-M-BLK')).toEqual([{ sku: 'TEE-M-BLK', quantity: 1 }]);
		for (const none of [null, undefined, '', '  ']) expect(buyNowItems(none)).toBeNull();
	});
});
