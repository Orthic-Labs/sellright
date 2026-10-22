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

// A fixture slot rule (neutral, no brand): the band reads only the server's free-shipping tier. The storefront and the brand
// hold no countries or thresholds; the API decides from the store's configured methods.
type Props = Omit<SlotProps<'cart.free-shipping-progress'>, never>;
const bandFor = (p: Props): { show: false } | { show: true; remaining: number; percent: number } => {
	if (!p.freeShipping || p.freeShipping.remaining <= 0) return { show: false };
	const { threshold, remaining } = p.freeShipping;
	return { show: true, remaining, percent: Math.min(100, Math.max(0, ((threshold - remaining) / threshold) * 100)) };
};
const props = (over: Partial<Props>): Props => ({ currencyCode: 'USD', subtotalCents: 0, lineCount: 1, isCheckoutView: false, countryCode: null, discountedSubtotalCents: 0, freeShipping: null, ...over });

describe('fixture rule over the slot props (server free-shipping tier)', () => {
	it('no tier from the server (already free, none reachable, or not yet quoted) hides the band', () => {
		expect(bandFor(props({ countryCode: 'US', discountedSubtotalCents: 500 }))).toEqual({ show: false });
		expect(bandFor(props({ countryCode: 'GB', discountedSubtotalCents: 25000, freeShipping: null }))).toEqual({ show: false });
	});

	it('a tier shows the server remaining and progress, whatever the client amounts say', () => {
		expect(bandFor(props({ countryCode: 'GB', discountedSubtotalCents: 0, freeShipping: { threshold: 10000, remaining: 2500 } }))).toEqual({ show: true, remaining: 2500, percent: 75 });
	});
});
