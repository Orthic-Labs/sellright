// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkoutCtaLabel } from './cta-label';

describe('checkoutCtaLabel', () => {
	it('says CONTINUE TO PAYMENT while something is due or the total is not known yet', () => {
		expect(checkoutCtaLabel('$75.00')).toBe('CONTINUE TO PAYMENT');
		expect(checkoutCtaLabel('€0.50')).toBe('CONTINUE TO PAYMENT');
		expect(checkoutCtaLabel(null)).toBe('CONTINUE TO PAYMENT');
	});
	it('says PLACE ORDER when nothing is due', () => {
		expect(checkoutCtaLabel('$0.00')).toBe('PLACE ORDER');
		expect(checkoutCtaLabel('¥0')).toBe('PLACE ORDER');
	});
});
