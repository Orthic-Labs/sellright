/**
 * Loyalty-points + product-review provider — the native SellRight client.
 * Every call goes through `~/sellright/client` (typed against the API's own
 * OpenAPI document). Mutations MUST use this client rather than the legacy
 * `sr()` helper: a signed-in customer's writes need the `sr_cust_csrf`
 * double-submit header, which this client reads.
 */
import { sellright } from '~/sellright/client';
import type {
	LoyaltyAccount,
	ReviewList,
	ReviewSort,
	ReviewSubmitInput,
	ReviewSubmitResult,
} from '~/sellright/types/rewards';

/** Points balance, redeem value and recent activity for the signed-in
 *  customer. Throws `SellRightError` (401 signed out, 403 unverified email). */
export async function getLoyaltyAccount(): Promise<LoyaltyAccount> {
	const { data } = await sellright().GET('/v1/shop/account/loyalty');
	return data as LoyaltyAccount;
}

/** Save the birthday (month + day) once; the API 409s when already set. */
export async function saveBirthday(month: number, day: number): Promise<{ month: number; day: number }> {
	const { data } = await sellright().PUT('/v1/shop/account/birthday', { body: { month, day } });
	return data as { month: number; day: number };
}

/** Approved reviews + rating aggregate for a product (public). */
export async function getProductReviews(
	slug: string,
	opts: { limit?: number; offset?: number; sort?: ReviewSort } = {},
): Promise<ReviewList> {
	const { data } = await sellright().GET('/v1/shop/catalog/products/{slug}/reviews', {
		params: { path: { slug }, query: { limit: opts.limit ?? 10, offset: opts.offset ?? 0, sort: opts.sort ?? 'newest' } },
	});
	return data as ReviewList;
}

/** Submit a review as the signed-in customer. The API decides whether it is
 *  `approved` or held `pending` for moderation. */
export async function submitProductReview(slug: string, body: ReviewSubmitInput): Promise<ReviewSubmitResult> {
	const { data } = await sellright().POST('/v1/shop/catalog/products/{slug}/reviews', {
		params: { path: { slug } },
		body,
	});
	return data as ReviewSubmitResult;
}
