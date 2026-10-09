/**
 * Native loyalty-points + product-review types — derived from the generated
 * OpenAPI `paths` (never hand-invented), same convention as
 * `./account.ts` / `./checkout.ts`. Regenerate the storefront-client schema
 * and these follow.
 */
import type { paths } from '../client';

type LoyaltyOp = paths['/v1/shop/account/loyalty']['get'];
/** GET /v1/shop/account/loyalty — the signed-in customer's points. */
export type LoyaltyAccount = LoyaltyOp['responses'][200]['content']['application/json'];
/** The shopper-visible slice of the store's points program. */
export type LoyaltyProgram = LoyaltyAccount['program'];
export type LoyaltyActivity = LoyaltyAccount['activity'][number];

type ReviewsOp = paths['/v1/shop/catalog/products/{slug}/reviews']['get'];
/** GET /v1/shop/catalog/products/{slug}/reviews — approved reviews + aggregate. */
export type ReviewList = ReviewsOp['responses'][200]['content']['application/json'];
export type Review = ReviewList['reviews'][number];
export type ReviewSort = NonNullable<NonNullable<ReviewsOp['parameters']['query']>['sort']>;

type SubmitOp = paths['/v1/shop/catalog/products/{slug}/reviews']['post'];
export type ReviewSubmitInput = NonNullable<SubmitOp['requestBody']>['content']['application/json'];
export type ReviewSubmitResult = SubmitOp['responses'][201]['content']['application/json'];
