import { describe, expect, it } from 'vitest';
import { PAYMENT_METHOD_ORDER, paymentElementOptions, billingDefaultValues } from './payment-element-options';

describe('paymentElementOptions', () => {
	it('is an open accordion with radios, no wallets, card first and crypto last', () => {
		expect(paymentElementOptions()).toEqual({
			layout: { type: 'accordion', defaultCollapsed: false, radios: 'always', spacedAccordionItems: false },
			wallets: { applePay: 'never', googlePay: 'never' },
			paymentMethodOrder: ['card', 'affirm', 'klarna', 'afterpay_clearpay', 'cashapp', 'link', 'crypto'],
		});
	});

	it('hands each mount its own order array (the shared constant cannot be mutated through it)', () => {
		const a = paymentElementOptions();
		a.paymentMethodOrder!.reverse();
		expect(paymentElementOptions().paymentMethodOrder).toEqual([...PAYMENT_METHOD_ORDER]);
	});
});

describe('billingDefaultValues (#400)', () => {
	const us = { countryCode: 'us', postalCode: '94107', province: 'CA', city: 'San Francisco', streetLine1: '1 Market St', streetLine2: '' };
	it('fills billing country/ZIP from the shipping address when no separate billing address exists', () => {
		expect(billingDefaultValues({ countryCode: '' }, us)).toEqual({ billingDetails: { address: { country: 'US', postal_code: '94107', state: 'CA', city: 'San Francisco', line1: '1 Market St' } } });
	});
	it('prefers the separate billing address the shopper entered', () => {
		expect(billingDefaultValues({ countryCode: 'GB', postalCode: 'SW1A 1AA' }, us)?.billingDetails?.address).toEqual({ country: 'GB', postal_code: 'SW1A 1AA' });
	});
	it('no known country: no defaults (Stripe keeps its own)', () => {
		expect(billingDefaultValues(null, { countryCode: '' })).toBeUndefined();
		expect(billingDefaultValues(undefined, undefined)).toBeUndefined();
	});
	it('mounts with the defaults when given, and without them otherwise', () => {
		expect(paymentElementOptions(billingDefaultValues(null, us))).toHaveProperty('defaultValues.billingDetails.address.country', 'US');
		expect(paymentElementOptions()).not.toHaveProperty('defaultValues');
	});
});
