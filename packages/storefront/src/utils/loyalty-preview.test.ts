import { describe, expect, it } from 'vitest';
import { estimatePointsEarned, previewRedemption, type SrLoyaltyProgram } from './sellright';

const program: SrLoyaltyProgram = { enabled: true, earnRatePerDollar: 2, pointsPerDollarOff: 100, minRedeemPoints: 0, maxRedeemPercentOfSubtotal: null, expiryDays: null };

describe('loyalty display helpers (mirror the server rules)', () => {
	it('estimates earned points on the discounted merchandise subtotal', () => {
		expect(estimatePointsEarned(1999, program)).toBe(39);
		expect(estimatePointsEarned(1999, { ...program, enabled: false })).toBe(0);
		expect(estimatePointsEarned(1999, null)).toBe(0);
	});
	it('previews a redemption with the cap, minimum and balance applied', () => {
		expect(previewRedemption(500, 500, 10000, program)).toEqual({ points: 500, discountCents: 500 });
		expect(previewRedemption(5000, 5000, 10000, { ...program, maxRedeemPercentOfSubtotal: 10 })).toEqual({ points: 1000, discountCents: 1000 });
		expect(previewRedemption(600, 500, 10000, program)).toBeNull();
		expect(previewRedemption(50, 500, 10000, { ...program, minRedeemPoints: 100 })).toBeNull();
	});
});
