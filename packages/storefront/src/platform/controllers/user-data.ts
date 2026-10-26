// #375: hashed user data for ad-platform matching on EVERY pixel event (OpenAI Ads "send user data", checked 2026-10-26:
// developers.openai.com/ads/measurement-pixel#send-user-data), not only on the purchase. Values are normalised and SHA-256
// hashed in the browser; only the hashes (plus the plain country/city/region/postal code the docs allow) are kept, in
// first-party localStorage, and pushed to the dataLayer as `user_data`. The GTM loader (head-analytics.ts) re-pushes the
// stored object before `gtm.js`, so page-view tags see it on the next page. Consent-gated like the analytics bus; revoking
// consent clears it. The visitor id is a random first-party cookie used as the guest's external id; the checkout sends it
// with the order so the server-side conversion (api ads/openai-capi.ts) hashes the same string.
import { BRAND_HEAD } from '~/platform/brand-data';
import { hasAnalyticsConsent } from '~/sellright/analytics';
import { normalizeEmail, normalizePhoneE164, sha256Hex } from './purchase-identity';

export const USER_DATA_STORAGE_KEY = 'sr-user-data';

/** Only a brand whose head.json declares the OpenAI pixel publishes user data, sets the visitor cookie or sends match keys. */
export const userDataEnabled = (): boolean => BRAND_HEAD.analytics?.adPlatforms?.includes('openai') ?? false;
export const VISITOR_COOKIE = 'sr_vid';
const VISITOR_MAX_AGE_S = 365 * 24 * 3600;

export interface UserDataKeys {
	sha256_email_address?: string;
	/** GA4 enhanced conversions: the E.164 number including `+`. */
	sha256_phone_number?: string;
	/** OpenAI: the same number without the `+`. */
	sha256_phone_number_digits?: string;
	sha256_external_id?: string;
	sha256_first_name?: string;
	sha256_last_name?: string;
	country?: string;
	city?: string;
	region?: string;
	postal_code?: string;
}

export interface UserDataInput {
	email?: string | null;
	phone?: string | null;
	firstName?: string | null;
	lastName?: string | null;
	/** Used when first/last are absent ("Ada Lovelace" → ada / lovelace). */
	fullName?: string | null;
	country?: string | null;
	city?: string | null;
	region?: string | null;
	postalCode?: string | null;
	/** The signed-in customer's SellRight id (the external id); guests use the visitor id. */
	customerId?: string | null;
}

/** OpenAI: lowercase, whitespace and ASCII punctuation removed. */
export const normalizeName = (v: string | null | undefined): string | null => {
	const n = (v ?? '').toLowerCase().replace(/[\s!-/:-@[-`{-~]/g, '');
	return n || null;
};
/** OpenAI: trimmed, case kept. */
export const normalizeExternalId = (v: string | null | undefined): string | null => ((v ?? '').trim() ? (v ?? '').trim() : null);
const plain = (v: string | null | undefined, max: number): string | null => ((v ?? '').trim() ? (v ?? '').trim().slice(0, max) : null);

/** The hashed/plain keys for one input (only fields that normalise are present). */
export async function userDataKeys(input: UserDataInput): Promise<UserDataKeys> {
	const out: UserDataKeys = {};
	const email = normalizeEmail(input.email);
	if (email) out.sha256_email_address = await sha256Hex(email);
	const e164 = await normalizePhoneE164(input.phone, input.country).catch(() => null);
	if (e164) {
		out.sha256_phone_number = await sha256Hex(e164);
		out.sha256_phone_number_digits = await sha256Hex(e164.replace(/^\+/, ''));
	}
	const parts = (input.fullName ?? '').trim().split(/\s+/).filter(Boolean);
	const first = normalizeName(input.firstName || parts[0]);
	const last = normalizeName(input.lastName || (parts.length > 1 ? parts.slice(1).join(' ') : null));
	if (first) out.sha256_first_name = await sha256Hex(first);
	if (last) out.sha256_last_name = await sha256Hex(last);
	const external = normalizeExternalId(input.customerId);
	if (external) out.sha256_external_id = await sha256Hex(external);
	const country = (input.country ?? '').trim().toUpperCase();
	if (/^[A-Z]{2}$/.test(country)) out.country = country;
	const city = plain(input.city, 128);
	if (city) out.city = city;
	const region = plain(input.region, 128);
	if (region) out.region = region;
	const postal = plain(input.postalCode, 32);
	if (postal) out.postal_code = postal;
	return out;
}

const local = (): Storage | null => {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null;
	}
};

export function readCookie(name: string): string | null {
	if (typeof document === 'undefined') return null;
	const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
	if (!m) return null;
	try {
		return decodeURIComponent(m[1]!);
	} catch {
		return m[1]!;
	}
}

/** The first-party visitor id (created on first use, 1 year). Null without consent or outside the browser. */
export function visitorId(): string | null {
	if (typeof document === 'undefined' || !hasAnalyticsConsent()) return null;
	const existing = readCookie(VISITOR_COOKIE);
	if (existing && /^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing;
	let id: string;
	try {
		id = crypto.randomUUID();
	} catch {
		id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
	}
	const secure = location.protocol === 'https:' ? '; Secure' : '';
	document.cookie = `${VISITOR_COOKIE}=${id}; Path=/; Max-Age=${VISITOR_MAX_AGE_S}; SameSite=Lax${secure}`;
	return readCookie(VISITOR_COOKIE) === id ? id : null;
}

export function storedUserData(): UserDataKeys {
	try {
		const raw = local()?.getItem(USER_DATA_STORAGE_KEY);
		const v = raw ? JSON.parse(raw) : null;
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as UserDataKeys) : {};
	} catch {
		return {};
	}
}

let lastPushed = '';

function push(data: UserDataKeys): void {
	const json = JSON.stringify(data);
	if (json === '{}' || json === lastPushed) return;
	lastPushed = json;
	const w = window as unknown as { dataLayer?: unknown[] };
	w.dataLayer = w.dataLayer || [];
	w.dataLayer.push({ event: 'user_data', user_data: data });
}

/**
 * Merge what is known now into the stored identity, keep it, and push it. A signed-in customer's id replaces the visitor
 * id as the external id. Browser + consent only; never throws.
 */
export async function publishUserData(input: UserDataInput = {}): Promise<UserDataKeys> {
	if (typeof window === 'undefined' || !hasAnalyticsConsent()) return {};
	try {
		const stored = storedUserData();
		// External id: the signed-in customer's id when given; otherwise keep the one already stored (a page without the
		// customer in hand must not swap it for the visitor id), else the visitor id.
		const external = input.customerId || (stored.sha256_external_id ? null : visitorId());
		const fresh = await userDataKeys({ ...input, customerId: external });
		const merged: UserDataKeys = { ...stored, ...fresh };
		try {
			local()?.setItem(USER_DATA_STORAGE_KEY, JSON.stringify(merged));
		} catch {
			// storage blocked: this page still pushes it
		}
		push(merged);
		return merged;
	} catch {
		return {};
	}
}

/** Consent revoked: forget the stored identity (the visitor cookie stays inert while consent is off). */
export function clearUserData(): void {
	lastPushed = '';
	try {
		local()?.removeItem(USER_DATA_STORAGE_KEY);
	} catch {
		// nothing stored
	}
}

/** Sent with POST /v1/shop/checkout: the OpenAI pixel's browser reference and the visitor id. Null without consent. */
export function orderTracking(): { obref?: string; visitorId?: string } | null {
	if (!hasAnalyticsConsent()) return null;
	const obref = readCookie('__obref');
	const vid = visitorId();
	const out: { obref?: string; visitorId?: string } = {};
	if (obref && obref.length <= 256) out.obref = obref;
	if (vid) out.visitorId = vid;
	return Object.keys(out).length ? out : null;
}

/** The pixel's own 30-day `__oppref` cookie: fallback when the tab's landing attribution has no oppref. */
export const pixelOppref = (): string | null => (hasAnalyticsConsent() ? readCookie('__oppref') : null);

export function __resetUserDataForTests(): void {
	lastPushed = '';
}
