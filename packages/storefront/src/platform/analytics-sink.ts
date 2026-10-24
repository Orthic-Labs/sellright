// Plan v3.1 §3.5 (brand views PR2): the server end of the storefront's ecommerce events (`/api/analytics/events/`, and a brand's
// alias routes.json operational.analyticsPath, e.g. Rotten's /api/analytics/performance/). Ported from Rotten's endpoint without
// its ad-pixel forwarding (no Meta CAPI: no ad pixels). It accepts view_item, add_to_cart and begin_checkout; `purchase` is refused
// (the API's own conversion plugin owns server purchase, and a browser copy would double count or be forgeable). A GA4 Measurement
// Protocol copy is sent only when the browser's tag manager did not deliver the event and the store configured GA4_MEASUREMENT_ID
// and GA4_API_SECRET. Every response is private, no-store.
import type { RequestHandler } from '@qwik.dev/router';
import { NO_STORE_CACHE_CONTROL } from '~/config/route-cache-policy';

export const MAX_BODY_CHARS = 16_384;
export const MAX_ITEMS = 20;
export const RATE_LIMIT_PER_MINUTE = 60;
const MAX_MONEY = 100_000;
const OUTBOUND_TIMEOUT_MS = 3000;

export interface SinkEvent {
	name: 'view_item' | 'add_to_cart' | 'begin_checkout';
	eventId: string;
	clientId?: string;
	currency?: string;
	value?: number;
	items: { item_id: string; item_name?: string; price?: number; quantity: number }[];
	pageLocation?: string;
	gtagSent: boolean;
}

const str = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : undefined);
const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MONEY ? v : undefined);

/** A sanitized event, 'purchase' (refused), or null (invalid). `host` = this request's host (pageLocation must be on it). */
export function parseSinkEvent(raw: unknown, host: string): SinkEvent | 'purchase' | null {
	const e = raw as Record<string, unknown> | null;
	if (!e || typeof e !== 'object') return null;
	if (e.name === 'purchase') return 'purchase';
	if (e.name !== 'view_item' && e.name !== 'add_to_cart' && e.name !== 'begin_checkout') return null;
	const eventId = str(e.eventId, /^[\w.:-]{1,100}$/);
	if (!eventId || (e.items !== undefined && (!Array.isArray(e.items) || e.items.length > MAX_ITEMS))) return null;
	const items: SinkEvent['items'] = [];
	for (const i of (e.items as Record<string, unknown>[] | undefined) ?? []) {
		const id = typeof i?.item_id === 'string' ? i.item_id.slice(0, 100) : typeof i?.id === 'string' ? i.id.slice(0, 100) : '';
		const quantity = Number.isInteger(i?.quantity) && (i.quantity as number) > 0 && (i.quantity as number) <= 100 ? (i.quantity as number) : 0;
		if (!id || !quantity) return null;
		items.push({ item_id: id, ...(typeof i.item_name === 'string' ? { item_name: i.item_name.slice(0, 200) } : {}), ...(money(i.price) !== undefined ? { price: money(i.price) } : {}), quantity });
	}
	let pageLocation: string | undefined;
	try {
		const url = new URL(String(e.pageLocation));
		if (url.host === host) pageLocation = url.origin + url.pathname;
	} catch {
		pageLocation = undefined;
	}
	return {
		name: e.name,
		eventId,
		clientId: str(e.clientId, /^\d{1,20}\.\d{1,20}$/),
		currency: str(e.currency, /^[A-Z]{3}$/),
		value: money(e.value),
		items,
		pageLocation,
		gtagSent: e.gtagSent === true,
	};
}

/** Fixed-window per-IP limiter (one storefront process). */
export function createRateLimiter(limit = RATE_LIMIT_PER_MINUTE, now = () => Date.now()) {
	let windowStart = -1;
	const counts = new Map<string, number>();
	return (ip: string): boolean => {
		const bucket = Math.floor(now() / 60_000);
		if (bucket !== windowStart) {
			windowStart = bucket;
			counts.clear();
		}
		const n = (counts.get(ip) ?? 0) + 1;
		counts.set(ip, n);
		return n > limit;
	};
}

/** The GA4 Measurement Protocol copy, only when the browser tag did not send it and GA4 is configured. Never throws. */
export async function forwardToGa4(event: SinkEvent, env: { id?: string; secret?: string }, fetcher: typeof fetch = fetch): Promise<boolean> {
	if (event.gtagSent || !env.id || !env.secret || !event.clientId) return false;
	try {
		const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(env.id)}&api_secret=${encodeURIComponent(env.secret)}`;
		const res = await fetcher(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_id: event.clientId,
				events: [{ name: event.name, params: { currency: event.currency, value: event.value, items: event.items, page_location: event.pageLocation, event_id: event.eventId } }],
			}),
			signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
		});
		return res.ok;
	} catch {
		return false;
	}
}

const limited = createRateLimiter();

const clientIp = (request: Request): string => (request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown').trim();

/** The sink's POST handler. */
export const sinkPost: RequestHandler = async ({ request, headers, json, send, url }) => {
	headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
	const text = await request.text().catch(() => '');
	if (text.length > MAX_BODY_CHARS) throw json(413, { error: 'Event too large' });
	let body: { type?: unknown; event?: unknown } | null;
	try {
		body = JSON.parse(text);
	} catch {
		body = null;
	}
	if (!body || typeof body !== 'object') throw json(400, { error: 'Invalid body' });
	if (body.type !== 'ecommerce') throw send(204, '');
	if (limited(clientIp(request))) throw json(429, { error: 'Too many events' });
	const event = parseSinkEvent(body.event, url.host);
	if (!event || event === 'purchase') throw json(400, { error: 'Invalid ecommerce event' });
	// 202 Accepted at once: the GA4 copy finishes on its own (bounded by its timeout, never throws), so the beacon request
	// is not held open for up to OUTBOUND_TIMEOUT_MS waiting on Google (#362).
	void forwardToGa4(event, { id: process.env.GA4_MEASUREMENT_ID, secret: process.env.GA4_API_SECRET });
	throw json(202, { success: true });
};
