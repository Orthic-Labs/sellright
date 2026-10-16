/**
 * Points + reviews display helpers. PURE (no I/O, no Qwik) so they unit-test
 * cleanly. The API is authoritative for every number that is actually
 * granted or charged; these only format values and preview earn amounts the
 * same way the server computes them (packages/api/src/money/loyalty.ts).
 * Nothing here hard-codes a rate: every rate comes from the store's program
 * settings (GET /v1/shop/config `loyalty`).
 */
import type { LoyaltyProgram } from '~/sellright/types/rewards';

export type RewardsProgram = Pick<
	LoyaltyProgram,
	'enabled' | 'earnRatePerDollar' | 'pointsPerDollarOff' | 'productMultipliers'
>;

/** "1 point" / "1,250 points". */
export const pointsLabel = (n: number): string => {
	const rounded = Math.round(n);
	return `${rounded.toLocaleString('en-US')} ${rounded === 1 ? 'point' : 'points'}`;
};

/** Points a merchandise amount earns (floors — never a partial point). */
export function earnPoints(cents: number, program: Pick<RewardsProgram, 'earnRatePerDollar'>): number {
	if (!(cents > 0) || !(program.earnRatePerDollar > 0)) return 0;
	return Math.floor((Math.floor(cents) * program.earnRatePerDollar) / 100);
}

/** Multiplier applying to a product (> 1), else null. */
export function productMultiplier(
	program: Pick<RewardsProgram, 'enabled' | 'productMultipliers'> | null | undefined,
	productId: string | null | undefined,
): number | null {
	if (!program?.enabled || !productId) return null;
	const wanted = productId.toLowerCase();
	const m = program.productMultipliers.find((x) => x.productId.toLowerCase() === wanted)?.multiplier;
	return m && m > 1 ? m : null;
}

/** PDP preview: base earn plus the product multiplier's extra, mirroring the server. */
export function pdpEarnPoints(input: {
	priceCents: number;
	productId?: string | null;
	program: RewardsProgram | null | undefined;
}): number {
	const { program, priceCents } = input;
	if (!program?.enabled) return 0;
	const base = earnPoints(priceCents, program);
	const m = productMultiplier(program, input.productId);
	if (!m) return base;
	return base + Math.floor((Math.floor(priceCents) * program.earnRatePerDollar * (m - 1)) / 100);
}

/** Cents of discount `points` buy at the program's current rate. */
export function pointsValueCents(points: number, program: Pick<RewardsProgram, 'pointsPerDollarOff'>): number {
	if (!(points > 0) || !(program.pointsPerDollarOff > 0)) return 0;
	return Math.floor((points * 100) / program.pointsPerDollarOff);
}

const KIND_LABEL: Record<string, string> = {
	earn: 'Earned on an order',
	redeem: 'Redeemed at checkout',
	adjust: 'Adjustment',
	expire: 'Expired',
	import: 'Points transferred in',
	reverse: 'Reversal',
	bonus: 'Bonus',
};

/** Shopper-facing description of one ledger entry (never internal reasons). */
export function describeActivity(a: { kind: string; label?: string | null; orderCode?: string | null }): string {
	const base = a.kind === 'bonus' && a.label ? a.label : (KIND_LABEL[a.kind] ?? 'Points activity');
	return a.orderCode ? `${base} · order ${a.orderCode}` : base;
}

/** The shopper-visible earning rules that are switched on, for the "ways to earn" list. */
export function waysToEarn(
	program: Pick<
		LoyaltyProgram,
		| 'earnRatePerDollar'
		| 'reviewBonusPoints'
		| 'reviewBonusVerifiedOnly'
		| 'signupBonusPoints'
		| 'firstOrderBonusPoints'
		| 'birthdayBonusPoints'
	>,
): Array<{ label: string; detail: string }> {
	const out: Array<{ label: string; detail: string }> = [];
	if (program.earnRatePerDollar > 0) out.push({ label: 'Shop', detail: `${pointsLabel(program.earnRatePerDollar)} for every $1 you spend` });
	if (program.reviewBonusPoints > 0) {
		out.push({
			label: 'Review a product',
			detail: `${pointsLabel(program.reviewBonusPoints)} when your review is approved${program.reviewBonusVerifiedOnly ? ' (for products you bought)' : ''}`,
		});
	}
	if (program.signupBonusPoints > 0) out.push({ label: 'Verify your email', detail: `${pointsLabel(program.signupBonusPoints)} for new accounts` });
	if (program.firstOrderBonusPoints > 0) out.push({ label: 'Your first order', detail: `${pointsLabel(program.firstOrderBonusPoints)} bonus` });
	if (program.birthdayBonusPoints > 0) out.push({ label: 'Your birthday', detail: `${pointsLabel(program.birthdayBonusPoints)} every year` });
	return out;
}

export const MONTHS = [
	'January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December',
];
/** Days in a month (1-12); February allows the 29th (birthdays are year-less). */
export const daysInMonth = (month: number): number => [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;

// ── reviews ────────────────────────────────────────────────────────────────

/** schema.org AggregateRating, or null when there are no reviews (never emit an empty rating). */
export function aggregateRatingSchema(rating: { average: number; count: number } | null | undefined) {
	if (!rating || !(rating.count > 0) || !(rating.average > 0)) return null;
	return {
		'@type': 'AggregateRating' as const,
		ratingValue: Number(rating.average.toFixed(1)),
		reviewCount: Math.floor(rating.count),
		bestRating: 5,
		worstRating: 1,
	};
}

/** Product JSON-LD with an AggregateRating merged in. Returns the schema
 *  unchanged when there are no reviews or it already carries a rating. */
export function withAggregateRating<T extends Record<string, unknown>>(
	schema: T,
	rating: { average: number; count: number } | null | undefined,
): T {
	const agg = aggregateRatingSchema(rating);
	if (!agg || schema.aggregateRating) return schema;
	return { ...schema, aggregateRating: agg };
}

/** "★★★★☆" for a 0-5 rating (rounded to the nearest whole star). */
export const starString = (n: number): string => {
	const full = Math.max(0, Math.min(5, Math.round(n)));
	return '★'.repeat(full) + '☆'.repeat(5 - full);
};

export const reviewDate = (iso: string): string => {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? ''
		: d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/** Client-side validation of a review draft; returns a message or null when it is fine. */
export function validateReviewDraft(draft: { rating: number; body: string }): string | null {
	if (!(draft.rating >= 1 && draft.rating <= 5)) return 'Choose a star rating.';
	if (draft.body.trim().length < 10) return 'Please write at least 10 characters.';
	return null;
}

/** Shopper-facing text for a failed review submit, keyed off the API's stable error code/status. */
export function reviewErrorMessage(err: { status?: number; code?: string } | null | undefined): string {
	switch (err?.code) {
		case 'ALREADY_REVIEWED': return 'You have already reviewed this product.';
		case 'SIGN_IN_REQUIRED': return 'Please sign in to write a review.';
		case 'EMAIL_NOT_VERIFIED': return 'Verify your email address before writing a review.';
		case 'PURCHASE_REQUIRED': return 'Only customers who bought this product can review it.';
		case 'REVIEWS_DISABLED': return 'Reviews are not open for this store right now.';
		case 'RATE_LIMITED': return 'Too many attempts. Please try again later.';
	}
	switch (err?.status) {
		case 409: return 'You have already reviewed this product.';
		case 401: return 'Please sign in to write a review.';
		case 403: return 'You are not able to review this product.';
		case 429: return 'Too many attempts. Please try again later.';
	}
	return 'We could not submit your review. Please try again.';
}
