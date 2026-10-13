// Plan v3.1 §3.5 (brand views PR2): the analytics bus subscriber. Every storefront event is tracked through `~/sellright/analytics`
// (consent-gated); this subscriber pushes it to the tag manager's dataLayer and beacons view_item / add_to_cart / begin_checkout to the
// event sink (platform/analytics-sink.ts), which sends a GA4 Measurement Protocol copy only when the tag manager did not. `purchase` is
// pushed to the dataLayer only, never beaconed (the API's conversion plugin owns server purchase). No ad pixels. The bus carries minor
// units; GA4 gets major units.
import { BRAND_HEAD, BRAND_ROUTES } from '~/platform/brand-data';
import { onAnalyticsEvent, setAnalyticsConsent, track, type AnalyticsEvent } from '~/sellright/analytics';

export const SINK_PATH = BRAND_ROUTES?.operational?.analyticsPath ?? '/api/analytics/events/';

const major = (cents: number) => Math.round(cents) / 100;

/** The dataLayer push and (unless purchase) the sink body for one event. Pure. */
export function conversionPayload(event: AnalyticsEvent, eventId: string, pageLocation: string, clientId: string | undefined, gtagSent: boolean) {
	const items =
		event.name === 'view_item' || event.name === 'add_to_cart'
			? [{ item_id: event.sku, item_name: event.productName, price: major(event.price), quantity: event.name === 'add_to_cart' ? event.quantity : 1 }]
			: event.name === 'purchase'
				? (event.items ?? []).slice(0, 20).map((i) => ({ item_id: i.sku, item_name: i.name, price: major(i.price), quantity: i.quantity }))
				: [];
	const value = event.name === 'add_to_cart' ? major(event.price) * event.quantity : event.name === 'view_item' ? major(event.price) : major(event.value);
	const dataLayer = {
		event: event.name,
		event_id: eventId,
		ecommerce: { currency: event.currency, value, ...(event.name === 'purchase' ? { transaction_id: event.orderCode } : {}), items },
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

/** `purchase` once per order code across reloads of the confirmation page (analytics state only, never stock). */
export function trackPurchaseOnce(order: { code: string; currency?: string | null; grandTotal?: number | null; lines?: readonly { sku?: string | null; name?: string | null; quantity?: number | null; lineTotal?: number | null }[] | null }): void {
	if (typeof window === 'undefined' || !order?.code) return;
	const key = `purchase-tracked-${order.code}`;
	try {
		if (sessionStorage.getItem(key)) return;
		sessionStorage.setItem(key, '1');
	} catch {
		// storage blocked: GA4's transaction_id dedupe still applies
	}
	const lines = order.lines ?? [];
	track({
		name: 'purchase',
		orderCode: order.code,
		currency: order.currency || 'USD',
		value: order.grandTotal ?? 0,
		itemCount: lines.reduce((n, l) => n + (l.quantity ?? 0), 0),
		items: lines.slice(0, 20).map((l) => ({ sku: String(l.sku ?? ''), name: String(l.name ?? ''), price: l.quantity ? Math.round((l.lineTotal ?? 0) / l.quantity) : 0, quantity: l.quantity ?? 0 })),
	});
}
