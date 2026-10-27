// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { paymentMessagingOptions } from './payment-messaging';

const BASE = { gatewayConfigured: true, publishableKey: 'pk_test_x', amountCents: 7500, currency: 'usd', countryCode: 'US' };

describe('paymentMessagingOptions', () => {
	it('feeds the charged amount and currency to the messaging element', () => {
		expect(paymentMessagingOptions(BASE)).toEqual({ publishableKey: 'pk_test_x', amount: 7500, currency: 'USD', countryCode: 'US' });
	});
	it('shows nothing for a store without the card gateway', () => {
		expect(paymentMessagingOptions({ ...BASE, gatewayConfigured: false })).toBeNull();
		expect(paymentMessagingOptions({ ...BASE, publishableKey: '' })).toBeNull();
		expect(paymentMessagingOptions({ ...BASE, gatewayConfigured: null })).toBeNull();
	});
	it('shows nothing for a zero, unknown or non-integer total', () => {
		expect(paymentMessagingOptions({ ...BASE, amountCents: 0 })).toBeNull();
		expect(paymentMessagingOptions({ ...BASE, amountCents: null })).toBeNull();
		expect(paymentMessagingOptions({ ...BASE, amountCents: 12.5 })).toBeNull();
	});
	it('shows nothing for a currency the element does not support', () => {
		expect(paymentMessagingOptions({ ...BASE, currency: 'JPY' })).toBeNull();
		expect(paymentMessagingOptions({ ...BASE, currency: '' })).toBeNull();
	});
	it('#400: only for a country the element serves, and always naming it (never left to the IP country)', () => {
		expect(paymentMessagingOptions({ ...BASE, countryCode: 'in' })).toBeNull();
		expect(paymentMessagingOptions({ ...BASE, countryCode: '' })).toBeNull();
		expect(paymentMessagingOptions({ ...BASE, countryCode: null })).toBeNull();
		expect(paymentMessagingOptions({ ...BASE, countryCode: 'gb' })?.countryCode).toBe('GB');
	});
});
