/**
 * Landing attribution: the UTM parameters and the ad platforms' auto-appended `oppref` click reference, captured from the
 * URL the shopper lands on and sent with POST /v1/shop/checkout, where the API stores them as order.metadata.attribution
 * (packages/api/src/orders/attribution.ts holds the same allowlist and cap and re-validates).
 *
 * Touch model: LAST touch within the tab's session. A URL carrying any attribution key replaces the whole stored set (never
 * merged, so one campaign's utm_content never joins another's utm_source); a URL with none (internal navigation, cart,
 * checkout, confirmation) leaves it untouched. Last touch matches how the ad platforms credit a click, and sessionStorage
 * scopes it to the visit: nothing outlives the tab, and no cookie is set.
 *
 * Consent: the same gate as the analytics bus (`hasAnalyticsConsent`). Without consent nothing is stored, read or sent.
 * Browser only; never touched during SSR. Analytics state only, never stock.
 */
import { hasAnalyticsConsent } from './analytics';

export const ATTRIBUTION_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'oppref'] as const;
export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];
export type Attribution = Partial<Record<AttributionKey, string>>;

/** The API's per-value cap (longer values are cut here so a checkout is never refused for them). */
export const ATTRIBUTION_MAX_CHARS = 256;
export const ATTRIBUTION_STORAGE_KEY = 'sr-attribution';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Allowlisted keys only, control characters removed, trimmed, capped, empties dropped. Null when nothing remains. */
export function sanitizeAttribution(raw: unknown): Attribution | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const out: Attribution = {};
	for (const key of ATTRIBUTION_KEYS) {
		const v = (raw as Record<string, unknown>)[key];
		if (typeof v !== 'string') continue;
		const clean = v.replace(CONTROL, '').trim().slice(0, ATTRIBUTION_MAX_CHARS).trim();
		if (clean) out[key] = clean;
	}
	return Object.keys(out).length ? out : null;
}

/** The attribution a URL's query carries, or null. */
export function attributionFromSearch(search: URLSearchParams): Attribution | null {
	const raw: Record<string, string> = {};
	for (const key of ATTRIBUTION_KEYS) {
		const v = search.get(key);
		if (v !== null) raw[key] = v;
	}
	return sanitizeAttribution(raw);
}

/** Copy the attribution keys of `from` onto `to` (for redirects that rebuild a query, e.g. the cart-link seed). */
export function carryAttributionParams(from: URLSearchParams, to: URLSearchParams): URLSearchParams {
	for (const key of ATTRIBUTION_KEYS) {
		const v = from.get(key);
		if (v !== null && !to.has(key)) to.set(key, v);
	}
	return to;
}

const storage = (): Storage | null => {
	try {
		return typeof window === 'undefined' ? null : window.sessionStorage;
	} catch {
		return null;
	}
};

/** Record the landing attribution of `href` (last touch). No-op without consent, without keys or without storage. */
export function captureAttribution(href: string): void {
	if (!hasAnalyticsConsent()) return;
	const store = storage();
	if (!store) return;
	let found: Attribution | null;
	try {
		found = attributionFromSearch(new URL(href).searchParams);
	} catch {
		return;
	}
	if (!found) return;
	try {
		store.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(found));
	} catch {
		// storage full or blocked: the order simply carries no attribution
	}
}

/** The stored attribution to send with an order (re-sanitized), or null. Null without consent. */
export function storedAttribution(): Attribution | null {
	if (!hasAnalyticsConsent()) return null;
	const store = storage();
	if (!store) return null;
	try {
		const raw = store.getItem(ATTRIBUTION_STORAGE_KEY);
		return raw ? sanitizeAttribution(JSON.parse(raw)) : null;
	} catch {
		return null;
	}
}
