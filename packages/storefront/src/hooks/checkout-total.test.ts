import { describe, expect, it } from 'vitest';
import { formatCents, totalChange } from './checkout-total';

describe('totalChange', () => {
	it('is unchanged when the server total equals what the shopper saw', () => {
		expect(totalChange(3000, 3000)).toEqual({ changed: false, shownCents: 3000, chargeCents: 3000 });
	});

	it('flags a higher or a lower server total (any difference needs consent)', () => {
		expect(totalChange(3000, 3300).changed).toBe(true);
		expect(totalChange(3000, 2750).changed).toBe(true);
	});

	it('has nothing to compare against when no total was shown', () => {
		expect(totalChange(0, 3300).changed).toBe(false);
	});
});

describe('formatCents', () => {
	it('formats like the order-summary estimate', () => {
		expect(formatCents(3300)).toBe('$33.00');
		expect(formatCents(123456)).toBe('$1,234.56');
	});
});
