/**
 * Native content/SEO/misc types for the storefront.
 *
 * `components['schemas']` in `../schema.gen.ts` is `never` — none of the
 * content-area endpoints (blog, track, contact, newsletter, affiliate, SEO)
 * publish a named OpenAPI component schema, only inline per-path shapes (see
 * `paths` in schema.gen.ts). So these types are hand-authored against the
 * deployed API contract (packages/api `src/routes/shop-extra.ts`,
 * `order-facts.ts`, `checkout.ts` `normalizeAddress`) rather than generated —
 * but they are the SAME native vocabulary the API actually returns, not a
 * carried-over Vendure/GraphQL shape. Kept in one file so every consumer in
 * this area (routes, services, components) imports from here instead of
 * reaching for `~/generated/graphql-shop` or `~/types.ts`.
 */

// ── Guest order tracking (GET /v1/shop/track) ────────────────────────────────

/** The API's real order.state (packages/api `src/money/fsm.ts`). Shipment
 *  progress is a SEPARATE concept that lives on fulfillments, not on this
 *  enum — there is no 'PaymentSettled'/'Shipped'/'Delivered' order state. */
export type TrackedOrderState = 'PendingPayment' | 'Paid' | 'PartiallyRefunded' | 'Refunded' | 'Cancelled';

/** packages/api `src/db/schema-core.ts` `fulfillmentState` enum. */
export type TrackedFulfillmentState = 'Pending' | 'Shipped' | 'Delivered' | 'Cancelled';

/** UI-only derived status — never persisted, never sent by the API. Folds
 *  order.state + fulfillment state into one label the tracking page can
 *  switch on, without inventing fake order states. */
export type TrackedOrderDisplayStatus =
	| 'AwaitingPayment'
	| 'Processing'
	| 'PartiallyShipped'
	| 'Shipped'
	| 'Delivered'
	| 'Refunded'
	| 'Cancelled';

/** Canonical address shape (matches the `address` table and
 *  `normalizeAddress()` in packages/api `src/routes/checkout.ts`: line1/line2/
 *  country/phone — not the storefront's old Vendure-ish streetLine1/
 *  countryCode/phoneNumber aliases that function accepts as INPUT only). */
export interface TrackedAddress {
	fullName: string | null;
	line1: string | null;
	line2: string | null;
	city: string | null;
	province: string | null;
	postalCode: string | null;
	country: string | null;
	phone: string | null;
}

export interface TrackedFulfillment {
	state: TrackedFulfillmentState;
	trackingCode: string | null;
	carrier: string | null;
	updatedAt: string | null;
}

export interface TrackedOrderLine {
	sku: string;
	name: string;
	quantity: number;
	unitPrice: number;
	lineTotal: number;
	isPreOrder: boolean;
	shipDate: string | null;
}

/** packages/api `src/routes/order-facts.ts` `OrderPaymentFact` — the guest
 *  tracking endpoint returns real payment facts (`loadOrderPayments`), the
 *  storefront just never typed or rendered them before this change. */
export interface TrackedPayment {
	method: string;
	state: string;
	amount: number;
	providerRef: string | null;
	errorMessage: string | null;
	createdAt: string;
}

export interface TrackedOrder {
	code: string;
	state: TrackedOrderState;
	displayStatus: TrackedOrderDisplayStatus;
	placedAt: string | null;
	currency: string;
	subtotal: number;
	shippingTotal: number;
	taxTotal: number;
	discountTotal: number;
	grandTotal: number;
	shippingAddress: TrackedAddress | null;
	fulfillments: TrackedFulfillment[];
	payments: TrackedPayment[];
	lines: TrackedOrderLine[];
}

export type TrackOrderResult =
	| { success: true; order: TrackedOrder }
	| { success: false; error: string };

// ── Newsletter + subscriber lifecycle ────────────────────────────────────────

export interface NewsletterSignupResult {
	ok: boolean;
	message?: string;
}

export interface SubscriberActionResult {
	ok: boolean;
	message?: string;
}

// ── Affiliate self-serve dashboard (GET /v1/shop/affiliate) ─────────────────

export interface AffiliateStatsResult {
	success: boolean;
	error?: string | null;
	email?: string | null;
	couponCode?: string | null;
	rate?: number | null;
	totals?: {
		earnedUsd: number;
		paidUsd: number;
		owedUsd: number;
		orderCount: number;
		rangeStart: string | null;
		rangeEnd: string | null;
	} | null;
	orders?: Array<{
		redactedCode: string;
		placedAt: string;
		itemCount: number;
		subtotalUsd: number;
		commissionUsd: number;
		state: string;
	}> | null;
	topProducts?: Array<{
		name: string;
		sku: string;
		qtySold: number;
		revenueUsd: number;
	}> | null;
	settles?: Array<{
		amountUsd: number;
		periodStartAt: string | null;
		periodEndAt: string;
		settledAt: string;
		txRef?: string | null;
	}> | null;
}

// ── SEO: JSON-LD (typed loosely — schema.org shapes are arbitrary key bags) ──

export type JsonLdItem = Record<string, unknown>;

export type SitemapKind = 'index' | 'main' | 'products' | 'blog' | 'collections';
