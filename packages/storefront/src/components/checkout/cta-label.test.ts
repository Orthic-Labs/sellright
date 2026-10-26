// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkoutCtaLabel } from './cta-label';

describe('checkoutCtaLabel', () => {
	it('says PAY while something is due or the total is not known yet (#372: no separate continue step)', () => {
		expect(checkoutCtaLabel('$75.00')).toBe('PAY');
		expect(checkoutCtaLabel('€0.50')).toBe('PAY');
		expect(checkoutCtaLabel(null)).toBe('PAY');
	});
	it('says PLACE ORDER when nothing is due', () => {
		expect(checkoutCtaLabel('$0.00')).toBe('PLACE ORDER');
		expect(checkoutCtaLabel('¥0')).toBe('PLACE ORDER');
	});
});
