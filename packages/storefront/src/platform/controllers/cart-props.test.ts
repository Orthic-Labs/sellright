// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { discountedSubtotalCents, shippingCountry } from './cart-props';
import type { SlotProps } from '~/components/slots/registry';

describe('discountedSubtotalCents', () => {
	it('is subtotal minus discount, floored at 0', () => {
		expect(discountedSubtotalCents(10000, 2500)).toBe(7500);
		expect(discountedSubtotalCents(10000, 0)).toBe(10000);
		expect(discountedSubtotalCents(10000, undefined)).toBe(10000);
		expect(discountedSubtotalCents(10000, null)).toBe(10000);
		expect(discountedSubtotalCents(1000, 5000)).toBe(0);
		expect(discountedSubtotalCents(0, 0)).toBe(0);
	});
});

describe('shippingCountry', () => {
	it('is null until the country is known, then the code', () => {
		expect(shippingCountry(undefined)).toBeNull();
		expect(shippingCountry(null)).toBeNull();
		expect(shippingCountry('')).toBeNull();
		expect(shippingCountry('US')).toBe('US');
	});
});

// A fixture slot rule (neutral, no brand): the props now carry what a country-conditional free-shipping band needs. Domestic
// destinations are exempt; international orders see progress to a $100 threshold on the DISCOUNTED amount.
type Props = Omit<SlotProps<'cart.free-shipping-progress'>, never>;
const DOMESTIC = new Set(['US', 'PR']);
const THRESHOLD = 10000;
const bandFor = (p: Props): 'hidden' | 'progress' | 'reached' => {
	if (p.countryCode !== null && DOMESTIC.has(p.countryCode)) return 'hidden';
	return p.discountedSubtotalCents >= THRESHOLD ? 'reached' : 'progress';
};
const props = (over: Partial<Props>): Props => ({ currencyCode: 'USD', subtotalCents: 0, lineCount: 1, isCheckoutView: false, countryCode: null, discountedSubtotalCents: 0, ...over });

describe('fixture rule over the slot props (country and discount)', () => {
	it('domestic destinations hide the band, whatever the amount', () => {
		expect(bandFor(props({ countryCode: 'US', discountedSubtotalCents: 500 }))).toBe('hidden');
		expect(bandFor(props({ countryCode: 'PR', discountedSubtotalCents: 50000 }))).toBe('hidden');
	});

	it('international below the threshold shows progress; at or above it the band is reached', () => {
		expect(bandFor(props({ countryCode: 'GB', discountedSubtotalCents: 9999 }))).toBe('progress');
		expect(bandFor(props({ countryCode: 'GB', discountedSubtotalCents: 10000 }))).toBe('reached');
		expect(bandFor(props({ countryCode: 'GB', discountedSubtotalCents: 25000 }))).toBe('reached');
	});

	it('the threshold uses the discounted amount: a coupon can drop an order below it', () => {
		const subtotal = 12000;
		const discount = 3000;
		expect(bandFor(props({ countryCode: 'DE', subtotalCents: subtotal, discountedSubtotalCents: discountedSubtotalCents(subtotal, discount) }))).toBe('progress');
		expect(bandFor(props({ countryCode: 'DE', subtotalCents: subtotal, discountedSubtotalCents: discountedSubtotalCents(subtotal, 0) }))).toBe('reached');
	});

	it('country null (not yet known) then set: the band follows without a reload', () => {
		expect(bandFor(props({ countryCode: shippingCountry(undefined), discountedSubtotalCents: 500 }))).toBe('progress');
		expect(bandFor(props({ countryCode: shippingCountry('US'), discountedSubtotalCents: 500 }))).toBe('hidden');
	});
});
