/**
 * Native checkout + payment types — derived from the generated OpenAPI
 * `paths` map (`~/sellright/schema.gen`), never hand-invented. This API's
 * OpenAPI document has no named `components.schemas` (see schema.gen.ts:
 * `components.schemas` is literally `never`); every operation inlines its
 * request/response shape, so these types index the specific path + method +
 * status code instead of a shared schema name.
 *
 * Anything indexed from `paths` below is generated-schema-derived. The two
 * types marked NOT SCHEMA-DERIVED are hand-written because the upstream
 * OpenAPI doc types that field as `unknown[]` — the route exists and returns
 * a real shape at runtime (confirmed against
 * packages/api/src/shipping/calculator.ts), but zod-openapi never had a
 * response schema attached to it. Regenerate `schema.gen.ts` and replace
 * these two if the API ever adds one.
 */
import type { paths } from '../client';

// ── POST /v1/shop/checkout — create an order from a cart ───────────────────
type CheckoutOp = paths['/v1/shop/checkout']['post'];
export type CheckoutRequest = NonNullable<CheckoutOp['requestBody']>['content']['application/json'];
export type CheckoutResponse = CheckoutOp['responses'][200]['content']['application/json'];
export type CheckoutConflictBody = CheckoutOp['responses'][409]['content']['application/json'];
/** The re-priced cart snapshot a 409 conflict carries, when it has one. */
export type CheckoutCartSnapshot = NonNullable<CheckoutConflictBody['cart']>;

// ── POST /v1/shop/orders/{code}/pay — settle a PendingPayment order ────────
type PayOp = paths['/v1/shop/orders/{code}/pay']['post'];
export type PayRequest = NonNullable<PayOp['requestBody']>['content']['application/json'];
export type PayResponse = PayOp['responses'][200]['content']['application/json'];

// ── POST /v1/shop/orders/{code}/payment-intent — mint a Stripe PaymentIntent ─
type PaymentIntentOp = paths['/v1/shop/orders/{code}/payment-intent']['post'];
export type PaymentIntentResponse = PaymentIntentOp['responses'][200]['content']['application/json'];

// ── GET /v1/shop/orders/{code} — receipt-token-scoped order read ───────────
type OrderOp = paths['/v1/shop/orders/{code}']['get'];
export type OrderSummary = OrderOp['responses'][200]['content']['application/json'];
export type OrderPayment = OrderSummary['payments'][number];
export type OrderFulfillment = OrderSummary['fulfillments'][number];
export type OrderLine = OrderSummary['lines'][number];
/** NOT SCHEMA-DERIVED (see file header): `OrderSummary['shippingAddress']` is
 *  typed `unknown` upstream. This is the actual normalized shape the API
 *  persists and returns — confirmed against `normalizeAddress()` in
 *  packages/api/src/routes/checkout.ts, which accepts either this shape or
 *  the storefront's own `streetLine1`/`countryCode` input aliases on write,
 *  but always returns THIS shape on read. Field names deliberately differ
 *  from `CheckoutRequest['shippingAddress']` — do not assume they match. */
export interface OrderAddressSnapshot {
	fullName: string | null;
	line1: string | null;
	line2: string | null;
	city: string | null;
	province: string | null;
	postalCode: string | null;
	country: string | null;
	phone: string | null;
}
/** The order states this storefront ever needs to branch on. The API's
 *  `state` field is `string` (no shared enum schema); this is the closed set
 *  the checkout + confirmation flow actually reads. */
export type OrderState =
	| 'AddingItems'
	| 'PendingPayment'
	| 'Paid'
	| 'PartiallyShipped'
	| 'Shipped'
	| 'Delivered'
	| 'Cancelled'
	| 'Declined';

// ── GET /v1/shop/config — public runtime config (Stripe mode + key) ────────
type ConfigOp = paths['/v1/shop/config']['get'];
export type ShopConfig = ConfigOp['responses'][200]['content']['application/json'];

// ── GET /v1/shop/shipping-methods — eligible methods for a cart ────────────
// NOT SCHEMA-DERIVED (see file header): the OpenAPI doc types `methods` as
// `unknown[]`; this is the actual per-method shape returned by
// packages/api/src/shipping/calculator.ts.
export interface ShopShippingMethod {
	code: string;
	name: string;
	/** Cents. */
	rate: number;
}
