import { describe, expect, it } from 'vitest';
import {
	aggregateRatingSchema, daysInMonth, describeActivity, earnPoints, pdpEarnPoints, pointsLabel, pointsValueCents,
	productMultiplier, reviewErrorMessage, starString, validateReviewDraft, waysToEarn, withAggregateRating,
} from './rewards';
import type { LoyaltyProgram } from '~/sellright/types/rewards';

const P = '11111111-1111-1111-1111-111111111111';
// Deliberately NOT a 1-point-per-dollar / 10-per-$1 program: nothing in the
// helpers may assume a default rate.
const program: LoyaltyProgram = {
	enabled: true, earnRatePerDollar: 2, pointsPerDollarOff: 50, minRedeemPoints: 0, maxRedeemPercentOfSubtotal: null, expiryDays: null,
	reviewBonusPoints: 25, reviewBonusVerifiedOnly: true, signupBonusPoints: 0, firstOrderBonusPoints: 0, birthdayBonusPoints: 0, productMultipliers: [],
};

describe('earn + value math follows the store settings', () => {
	it('earns the configured rate per $1 and floors', () => {
		expect(earnPoints(14900, program)).toBe(298);
		expect(earnPoints(1999, program)).toBe(39);
		expect(earnPoints(1999, { earnRatePerDollar: 1 })).toBe(19);
		expect(earnPoints(0, program)).toBe(0);
		expect(earnPoints(5000, { earnRatePerDollar: 0 })).toBe(0);
	});
	it('converts points to cents at the configured rate', () => {
		expect(pointsValueCents(50, program)).toBe(100);
		expect(pointsValueCents(149, program)).toBe(298);
		expect(pointsValueCents(10, { pointsPerDollarOff: 10 })).toBe(100);
		expect(pointsValueCents(0, program)).toBe(0);
		expect(pointsValueCents(10, { pointsPerDollarOff: 0 })).toBe(0);
	});
	it('applies a product multiplier on the PDP preview', () => {
		const withMult = { ...program, productMultipliers: [{ productId: P, multiplier: 3 }] };
		expect(pdpEarnPoints({ priceCents: 10000, productId: P, program: withMult })).toBe(600);
		expect(pdpEarnPoints({ priceCents: 10000, productId: P.toUpperCase(), program: withMult })).toBe(600);
		expect(pdpEarnPoints({ priceCents: 10000, productId: 'other', program: withMult })).toBe(200);
		expect(pdpEarnPoints({ priceCents: 10000, productId: null, program: withMult })).toBe(200);
		expect(productMultiplier(withMult, P)).toBe(3);
		expect(productMultiplier(program, P)).toBeNull();
		expect(productMultiplier({ ...withMult, productMultipliers: [{ productId: P, multiplier: 1 }] }, P)).toBeNull();
	});
	it('is zero while the program is off or unknown', () => {
		expect(pdpEarnPoints({ priceCents: 10000, program: { ...program, enabled: false } })).toBe(0);
		expect(pdpEarnPoints({ priceCents: 10000, program: null })).toBe(0);
		expect(pdpEarnPoints({ priceCents: 10000, program: undefined })).toBe(0);
	});
});

describe('labels', () => {
	it('formats points with plural handling', () => {
		expect(pointsLabel(1)).toBe('1 point');
		expect(pointsLabel(0)).toBe('0 points');
		expect(pointsLabel(1250)).toBe('1,250 points');
	});
	it('describes ledger entries without internal reasons', () => {
		expect(describeActivity({ kind: 'earn', orderCode: 'AB12' })).toBe('Earned on an order · order AB12');
		expect(describeActivity({ kind: 'bonus', label: 'Review bonus' })).toBe('Review bonus');
		expect(describeActivity({ kind: 'bonus' })).toBe('Bonus');
		expect(describeActivity({ kind: 'weird' })).toBe('Points activity');
	});
	it('lists only the rules that are switched on', () => {
		expect(waysToEarn(program).map((w) => w.label)).toEqual(['Shop', 'Review a product']);
		expect(waysToEarn({ ...program, earnRatePerDollar: 0, reviewBonusPoints: 0 })).toEqual([]);
		expect(
			waysToEarn({ ...program, reviewBonusPoints: 0, birthdayBonusPoints: 100, signupBonusPoints: 50, firstOrderBonusPoints: 200 }).map((w) => w.label),
		).toEqual(['Shop', 'Verify your email', 'Your first order', 'Your birthday']);
		expect(waysToEarn(program)[0]?.detail).toBe('2 points for every $1 you spend');
	});
	it('knows month lengths (Feb allows the 29th)', () => {
		expect(daysInMonth(2)).toBe(29);
		expect(daysInMonth(4)).toBe(30);
		expect(daysInMonth(12)).toBe(31);
	});
	it('renders stars', () => {
		expect(starString(4)).toBe('★★★★☆');
		expect(starString(0)).toBe('☆☆☆☆☆');
		expect(starString(9)).toBe('★★★★★');
	});
});

describe('AggregateRating schema', () => {
	it('emits only when there are reviews', () => {
		expect(aggregateRatingSchema(null)).toBeNull();
		expect(aggregateRatingSchema(undefined)).toBeNull();
		expect(aggregateRatingSchema({ average: 0, count: 0 })).toBeNull();
		expect(aggregateRatingSchema({ average: 4.5, count: 0 })).toBeNull();
		expect(aggregateRatingSchema({ average: 4.66, count: 12 })).toEqual({
			'@type': 'AggregateRating', ratingValue: 4.7, reviewCount: 12, bestRating: 5, worstRating: 1,
		});
	});
});

describe('withAggregateRating', () => {
	const product = { '@context': 'https://schema.org', '@type': 'Product', name: 'Widget' };
	it('adds the aggregate only when there are reviews', () => {
		expect(withAggregateRating(product, { average: 4, count: 2 })).toEqual({
			...product,
			aggregateRating: { '@type': 'AggregateRating', ratingValue: 4, reviewCount: 2, bestRating: 5, worstRating: 1 },
		});
		expect(withAggregateRating(product, null)).toBe(product);
		expect(withAggregateRating(product, { average: 5, count: 0 })).toBe(product);
	});
	it('keeps a rating the API already supplied', () => {
		const withOwn = { ...product, aggregateRating: { ratingValue: 3 } };
		expect(withAggregateRating(withOwn, { average: 5, count: 9 })).toBe(withOwn);
	});
});

describe('review draft + errors', () => {
	it('requires a rating and a real body', () => {
		expect(validateReviewDraft({ rating: 0, body: 'long enough text' })).toMatch(/star rating/);
		expect(validateReviewDraft({ rating: 5, body: 'short' })).toMatch(/10 characters/);
		expect(validateReviewDraft({ rating: 5, body: '   padded   ' })).toMatch(/10 characters/);
		expect(validateReviewDraft({ rating: 4, body: 'long enough text' })).toBeNull();
	});
	it('maps API error codes to shopper copy, falling back to status', () => {
		expect(reviewErrorMessage({ status: 409, code: 'ALREADY_REVIEWED' })).toMatch(/already reviewed/);
		expect(reviewErrorMessage({ status: 403, code: 'EMAIL_NOT_VERIFIED' })).toMatch(/Verify your email/);
		expect(reviewErrorMessage({ status: 403, code: 'PURCHASE_REQUIRED' })).toMatch(/bought this product/);
		expect(reviewErrorMessage({ status: 429 })).toMatch(/Too many/);
		expect(reviewErrorMessage({ status: 401 })).toMatch(/sign in/i);
		expect(reviewErrorMessage({ status: 500 })).toMatch(/could not submit/);
		expect(reviewErrorMessage(null)).toMatch(/could not submit/);
	});
});
