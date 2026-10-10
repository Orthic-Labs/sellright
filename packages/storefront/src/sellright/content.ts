/**
 * Native content/misc endpoints, typed through the generated OpenAPI client
 * (`./client`). This is the ONLY place storefront code should reach for
 * guest order tracking, newsletter/subscriber lifecycle, and the affiliate
 * dashboard feed — callers get `TrackedOrder` etc. (`./types/content`), never
 * a legacy shape.
 */
import { sellright } from './client';
import { srErrorStatus } from '~/utils/sellright';
import type {
	AffiliateStatsResult,
	NewsletterSignupResult,
	SubscriberActionResult,
	TrackedAddress,
	TrackedFulfillment,
	TrackedFulfillmentState,
	TrackedOrder,
	TrackedOrderDisplayStatus,
	TrackedOrderLine,
	TrackedOrderState,
	TrackedPayment,
	TrackOrderResult,
} from './types/content';

// ── Guest order tracking ──────────────────────────────────────────────────────

/** The API returns the canonical address shape (line1/line2/country/phone —
 *  see packages/api `normalizeAddress()`); this only guards against a
 *  genuinely missing address (address-less digital-only orders) or a field
 *  that predates this build. Never invents a made-up key. */
function normalizeTrackedAddress(raw: unknown): TrackedAddress | null {
	if (!raw || typeof raw !== 'object') return null;
	const a = raw as Record<string, unknown>;
	const str = (k: string): string | null => (typeof a[k] === 'string' && a[k] ? (a[k] as string) : null);
	return {
		fullName: str('fullName'),
		line1: str('line1'),
		line2: str('line2'),
		city: str('city'),
		province: str('province'),
		postalCode: str('postalCode'),
		country: str('country'),
		phone: str('phone'),
	};
}

/** Folds the real order.state + fulfillment states into one UI status — never
 *  a fabricated order state, always derived from the two real enums. */
function deriveDisplayStatus(state: TrackedOrderState, fulfillments: TrackedFulfillment[]): TrackedOrderDisplayStatus {
	if (state === 'Cancelled') return 'Cancelled';
	if (state === 'Refunded' || state === 'PartiallyRefunded') return 'Refunded';
	if (state === 'PendingPayment') return 'AwaitingPayment';
	const delivered = fulfillments.some((f) => f.state === 'Delivered');
	if (delivered) return 'Delivered';
	const shippedCount = fulfillments.filter((f) => f.state === 'Shipped' || f.state === 'Delivered').length;
	if (shippedCount > 0 && shippedCount < fulfillments.length) return 'PartiallyShipped';
	if (shippedCount > 0) return 'Shipped';
	return 'Processing';
}

function normalizeTrackedOrder(raw: Record<string, unknown>): TrackedOrder {
	const fulfillments = (Array.isArray(raw.fulfillments) ? raw.fulfillments : []) as TrackedFulfillment[];
	const state = raw.state as TrackedOrderState;
	return {
		code: String(raw.code ?? ''),
		state,
		displayStatus: deriveDisplayStatus(state, fulfillments),
		placedAt: (raw.placedAt as string | null) ?? null,
		currency: String(raw.currency ?? 'USD'),
		subtotal: Number(raw.subtotal ?? 0),
		shippingTotal: Number(raw.shippingTotal ?? 0),
		taxTotal: Number(raw.taxTotal ?? 0),
		discountTotal: Number(raw.discountTotal ?? 0),
		grandTotal: Number(raw.grandTotal ?? 0),
		shippingAddress: normalizeTrackedAddress(raw.shippingAddress),
		fulfillments: fulfillments.map((f) => ({
			state: f.state as TrackedFulfillmentState,
			trackingCode: f.trackingCode ?? null,
			carrier: f.carrier ?? null,
			updatedAt: f.updatedAt ?? null,
		})),
		payments: (Array.isArray(raw.payments) ? raw.payments : []) as TrackedPayment[],
		lines: (Array.isArray(raw.lines) ? raw.lines : []).map((l) => {
			const line = l as Record<string, unknown>;
			return {
				sku: String(line.sku ?? ''),
				name: String(line.name ?? ''),
				quantity: Number(line.quantity ?? 0),
				unitPrice: Number(line.unitPrice ?? 0),
				lineTotal: Number(line.lineTotal ?? 0),
				isPreOrder: Boolean(line.isPreOrder),
				shipDate: (line.shipDate as string | null) ?? null,
			};
		}) as TrackedOrderLine[],
	};
}

/** GET /v1/shop/track (code + email). The endpoint's response body is
 *  untyped in the OpenAPI doc (`content: { "application/json": unknown }`)
 *  — the API doesn't publish a schema for it — so this is the one place that
 *  normalizes the raw payload into `TrackedOrder`. */
export async function trackOrder(code: string, email: string, turnstileToken?: string): Promise<TrackOrderResult> {
	try {
		const { data, error } = await sellright().GET('/v1/shop/track', {
			params: { query: { code, email, turnstileToken: turnstileToken || undefined } },
		});
		if (error) return { success: false, error: 'Order not found for that code + email.' };
		return { success: true, order: normalizeTrackedOrder(data as Record<string, unknown>) };
	} catch (err) {
		if (srErrorStatus(err) === 404) {
			return { success: false, error: 'Order not found for that code + email.' };
		}
		console.error('Order tracking error:', err);
		return { success: false, error: 'Unable to track order at this time. Please try again later.' };
	}
}

// ── Newsletter signup ─────────────────────────────────────────────────────────

/** POST /v1/shop/newsletter-signup. `honeypot` is a client-side-only bot trap
 *  (the field storefront forms already render hidden) — the API has no such
 *  field, so a filled honeypot short-circuits here and never calls out. */
export async function newsletterSignup(email: string, honeypot?: string, turnstileToken?: string): Promise<NewsletterSignupResult> {
	if (honeypot) return { ok: true };
	try {
		const { error } = await sellright().POST('/v1/shop/newsletter-signup', {
			body: { email, source: 'storefront', turnstileToken: turnstileToken || undefined },
		});
		if (error) return { ok: false, message: 'Subscription failed. Please try again.' };
		return { ok: true };
	} catch (err) {
		if (srErrorStatus(err) === 429) {
			return { ok: false, message: 'Too many signups from this IP. Try again in an hour.' };
		}
		if (srErrorStatus(err) === 403) {
			return { ok: false, message: 'Security check failed. Please try again.' };
		}
		return { ok: false, message: 'Subscription failed. Please try again.' };
	}
}

// ── Subscriber lifecycle (double opt-in confirm / unsubscribe) ───────────────

/** GET /v1/shop/subscriber/confirm/{token} — the API renders its own
 *  branded HTML page for this (double opt-in confirmation), so the
 *  storefront route just proxies it verbatim rather than re-implementing a
 *  confirmation UI. Returns the raw HTML + status for the route handler to
 *  forward; `null` on a network failure. */
export async function fetchSubscriberConfirmPage(token: string): Promise<{ status: number; html: string } | null> {
	const client = sellright();
	try {
		const { data, response } = await client.GET('/v1/shop/subscriber/confirm/{token}', {
			params: { path: { token } },
			parseAs: 'text',
		});
		return { status: response.status, html: (data as unknown as string) ?? '' };
	} catch {
		return null;
	}
}

/** GET /v1/shop/subscriber/unsubscribe/{token} — same proxy pattern as
 *  confirm above (the landing page is a backend-rendered HTML form). */
export async function fetchSubscriberUnsubscribePage(token: string): Promise<{ status: number; html: string } | null> {
	const client = sellright();
	try {
		const { data, response } = await client.GET('/v1/shop/subscriber/unsubscribe/{token}', {
			params: { path: { token } },
			parseAs: 'text',
		});
		return { status: response.status, html: (data as unknown as string) ?? '' };
	} catch {
		return null;
	}
}

/** POST /v1/shop/subscriber/unsubscribe/{token} — the one-click unsubscribe
 *  a mail client's `List-Unsubscribe` header hits directly (no page render). */
export async function unsubscribeSubscriber(token: string): Promise<SubscriberActionResult> {
	try {
		const { error } = await sellright().POST('/v1/shop/subscriber/unsubscribe/{token}', {
			params: { path: { token } },
		});
		if (error) return { ok: false, message: 'Unable to unsubscribe right now.' };
		return { ok: true };
	} catch {
		return { ok: false, message: 'Unable to unsubscribe right now.' };
	}
}

// ── Affiliate self-serve dashboard ───────────────────────────────────────────

/** GET /v1/shop/affiliate?t=<token>. Token-gated, no admin auth. Previously
 *  this lived as a hand-rolled `fetch` in the provider with its own copy of
 *  the API-base/store-slug logic (defaulting to the 'demo' store on any real
 *  deployment that never overrode `VITE_SELLRIGHT_STORE_SLUG` — the same bug
 *  class `sellright-seo.ts`'s history warns about); routing it through the
 *  shared client fixes that for free. */
export async function fetchAffiliateStats(token: string): Promise<AffiliateStatsResult> {
	if (!token || token.length < 16) {
		return { success: false, error: 'Invalid or expired link.' };
	}
	try {
		const { data } = await sellright().GET('/v1/shop/affiliate', {
			params: { query: { t: token } },
		});
		return { ...(data as Omit<AffiliateStatsResult, 'success'>), success: true };
	} catch (err) {
		if (srErrorStatus(err) === 404) return { success: false, error: 'Invalid affiliate link.' };
		console.error('Affiliate stats fetch failed:', err);
		return { success: false, error: 'Could not reach the dashboard service.' };
	}
}
