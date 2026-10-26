// Plan v3.1 §3.5 (brand views PR2): the analytics bus subscriber. Every storefront event is tracked through `~/sellright/analytics`
// (consent-gated); this subscriber pushes it to the tag manager's dataLayer and beacons view_item / add_to_cart / begin_checkout to the
// event sink (platform/analytics-sink.ts), which sends a GA4 Measurement Protocol copy only when the tag manager did not. `purchase` is
// pushed to the dataLayer only, never beaconed: it is sent once, from the confirmation page, and only for an order paid with a live
// (not test-mode) payment; it carries SHA-256 hashed email/phone (`user_data`) for enhanced matching, never the raw values. There is
// no server-side purchase conversion. Ad pixels exist only as GTM tags a brand opts into (head.json analytics.adPlatforms; e.g. the
// OpenAI pixel's order_created tag fires on this dataLayer `purchase`). The bus carries minor units; GA4 gets major units by the currency's own exponent, and
// every event (view_item, add_to_cart, begin_checkout, purchase) also carries integer minor units (`ecommerce.value_minor`, items[]
// `price_minor`, `sku`) and a unique top-level `event_id` for pixels that want them, since GTM may not compute.
import { BRAND_HEAD, BRAND_ROUTES } from '~/platform/brand-data';
import { minorUnitDigits } from '~/utils/currency';
import { hasAnalyticsConsent, onAnalyticsEvent, setAnalyticsConsent, track, type AnalyticsEvent, type AnalyticsLine } from '~/sellright/analytics';
import { purchaseUserData } from './purchase-identity';
import { publishUserData, userDataEnabled } from './user-data';

export const SINK_PATH = BRAND_ROUTES?.operational?.analyticsPath ?? '/api/analytics/events/';

/** Minor units to major units for the currency's own exponent (JPY 0, USD 2, KWD 3). */
const major = (minor: number, currency: string) => Math.round(minor) / 10 ** minorUnitDigits(currency);

/** One dataLayer/GA4 item: GA4's fields (major-unit price) plus the SKU and the integer minor-unit unit price. */
const item = (sku: string, name: string, priceMinor: number, quantity: number, currency: string) => ({
	item_id: sku,
	sku,
	item_name: name,
	price: major(priceMinor, currency),
	price_minor: Math.round(priceMinor),
	quantity,
});

/** The dataLayer push and (unless purchase) the sink body for one event. Pure. */
export function conversionPayload(event: AnalyticsEvent, eventId: string, pageLocation: string, clientId: string | undefined, gtagSent: boolean) {
	const lines = (all: readonly AnalyticsLine[] | undefined) => (all ?? []).slice(0, 20).map((i) => item(i.sku, i.name, i.price, i.quantity, event.currency));
	const items =
		event.name === 'view_item' || event.name === 'add_to_cart'
			? [item(event.sku, event.productName, event.price, event.name === 'add_to_cart' ? event.quantity : 1, event.currency)]
			: lines(event.items);
	const valueMinor = Math.round(event.name === 'add_to_cart' ? event.price * event.quantity : event.name === 'view_item' ? event.price : event.value);
	const value = major(valueMinor, event.currency);
	const dataLayer = {
		event: event.name,
		event_id: eventId,
		ecommerce: { currency: event.currency, value, value_minor: valueMinor, ...(event.name === 'purchase' ? { transaction_id: event.orderCode } : {}), items },
		// GA4 user-provided data field names; hashes only, and only on purchase.
		...(event.name === 'purchase' && event.userData && (event.userData.sha256EmailAddress || event.userData.sha256PhoneNumber)
			? { user_data: {
				...(event.userData.sha256EmailAddress ? { sha256_email_address: event.userData.sha256EmailAddress } : {}),
				...(event.userData.sha256PhoneNumber ? { sha256_phone_number: event.userData.sha256PhoneNumber } : {}),
			} }
			: {}),
	};
	const beacon =
		event.name === 'purchase'
			? null
			: { type: 'ecommerce', event: { name: event.name, eventId, currency: event.currency, value, items, pageLocation, clientId, gtagSent } };
	return { dataLayer, beacon };
}

function newEventId(name: string): string {
	try {
		return `${name}_${crypto.randomUUID()}`;
	} catch {
		return `${name}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
	}
}

let started = false;

/** Browser only, once per document: consent per head.json (`implied` grants it at mount) and the subscriber. */
export function startConversion(): void {
	if (started || typeof window === 'undefined') return;
	const spec = BRAND_HEAD.analytics;
	if (!spec || spec.provider !== 'gtm') return;
	started = true;
	if (spec.consent === 'implied') setAnalyticsConsent(true);
	onAnalyticsEvent((event) => {
		const w = window as unknown as { dataLayer?: unknown[]; google_tag_manager?: unknown };
		const eventId = event.name === 'purchase' ? `purchase_${event.orderCode}` : newEventId(event.name);
		const ga = document.cookie.match(/(?:^|; )_ga=([^;]*)/)?.[1]?.split('.').slice(-2).join('.');
		const { dataLayer, beacon } = conversionPayload(event, eventId, location.origin + location.pathname, ga && /^\d+\.\d+$/.test(ga) ? ga : undefined, !!w.google_tag_manager);
		w.dataLayer = w.dataLayer || [];
		w.dataLayer.push({ ecommerce: null });
		w.dataLayer.push(dataLayer);
		if (!beacon) return;
		const body = JSON.stringify(beacon);
		const queued = typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(SINK_PATH, new Blob([body], { type: 'application/json' }));
		if (!queued) fetch(SINK_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => undefined);
	});
}

/** The order facts the purchase conversion needs (the confirmation page's live order read). */
export interface PurchaseOrder {
	code: string;
	state?: string | null;
	currency?: string | null;
	grandTotal?: number | null;
	lines?: readonly { sku?: string | null; name?: string | null; quantity?: number | null; lineTotal?: number | null }[] | null;
	/** True when the order was paid only through test-mode payments: no conversion is reported. */
	testMode?: boolean | null;
	contactEmail?: string | null;
	customerEmail?: string | null;
	/** The order's stored shipping address (untyped JSON on the wire): only `phone` and `country` are read. */
	shippingAddress?: unknown;
}

const PAID_STATES = new Set(['Paid', 'Shipped', 'PartiallyShipped', 'Delivered']);

/** Whether a purchase conversion may be reported for this order: paid (settled) with a live payment. */
export const purchaseReportable = (order: PurchaseOrder): boolean => PAID_STATES.has(order.state ?? '') && order.testMode !== true;

/**
 * `purchase` once per order code across reloads of the confirmation page (analytics state only, never stock). Only for a
 * paid order whose payment ran live (test-mode purchases are never reported); unpaid, declined, cancelled and test orders
 * send nothing. Carries hashed email/phone (purchase-identity.ts). Resolves once the event is handed to the subscriber.
 */
export async function trackPurchaseOnce(order: PurchaseOrder): Promise<void> {
	if (typeof window === 'undefined' || !order?.code) return;
	if (!purchaseReportable(order)) return;
	// Only mark an order once its event can actually reach the subscriber (started and consented); otherwise a later load may send it.
	if (!started || !hasAnalyticsConsent()) return;
	const key = `purchase-tracked-${order.code}`;
	try {
		if (sessionStorage.getItem(key)) return;
		sessionStorage.setItem(key, '1');
	} catch {
		// storage blocked: the event_id (purchase_<code>) and GA4's transaction_id still dedupe downstream
	}
	const address = (order.shippingAddress && typeof order.shippingAddress === 'object' ? order.shippingAddress : {}) as { phone?: unknown; country?: unknown };
	// #375: the order's own contact/address joins the stored user data (pushed as `user_data` before the purchase event).
	if (userDataEnabled()) {
		const s = (k: string) => { const v = (address as Record<string, unknown>)[k]; return typeof v === 'string' ? v : null; };
		await publishUserData({ email: order.contactEmail || order.customerEmail, phone: s('phone'), fullName: s('fullName'), country: s('country'),
			city: s('city'), region: s('province'), postalCode: s('postalCode') });
	}
	const userData = await purchaseUserData({
		email: order.contactEmail || order.customerEmail,
		phone: typeof address.phone === 'string' ? address.phone : null,
		country: typeof address.country === 'string' ? address.country : null,
	}).catch(() => ({}));
	const lines = order.lines ?? [];
	track({
		name: 'purchase',
		orderCode: order.code,
		currency: order.currency || 'USD',
		value: order.grandTotal ?? 0,
		itemCount: lines.reduce((n, l) => n + (l.quantity ?? 0), 0),
		items: lines.slice(0, 20).map((l) => ({ sku: String(l.sku ?? ''), name: String(l.name ?? ''), price: l.quantity ? Math.round((l.lineTotal ?? 0) / l.quantity) : 0, quantity: l.quantity ?? 0 })),
		...(Object.keys(userData).length ? { userData } : {}),
	});
}
