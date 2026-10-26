// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkoutCtaLabel } from './cta-label';

describe('checkoutCtaLabel', () => {
	it('says PLACE ORDER while something is due or the total is not known yet (#372: one PLACE ORDER)', () => {
		expect(checkoutCtaLabel('$75.00')).toBe('PLACE ORDER');
		expect(checkoutCtaLabel('€0.50')).toBe('PLACE ORDER');
		expect(checkoutCtaLabel(null)).toBe('PLACE ORDER');
	});
	it('says PLACE ORDER when nothing is due', () => {
		expect(checkoutCtaLabel('$0.00')).toBe('PLACE ORDER');
		expect(checkoutCtaLabel('¥0')).toBe('PLACE ORDER');
	});
});
