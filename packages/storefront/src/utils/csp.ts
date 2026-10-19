/**
 * Content-Security-Policy for the Express entry, built as a pure function so the
 * emitted policy is testable without booting a server. The fixed policy is the
 * per-directive allowlist documented in `entry.express.tsx`; optional origins are
 * added only when the configuration that needs them is present:
 *
 *  - `https://challenges.cloudflare.com` (script-src + frame-src) when a
 *    Turnstile site key is configured (`VITE_TURNSTILE_SITE_KEY`). Every
 *    Turnstile form (sign-in, login modal, contact, forgot-password, order
 *    tracking, newsletter) injects that script from the browser WITHOUT a
 *    nonce, and the widget renders in a frame from the same origin.
 *  - `https://ipapi.co` (connect-src) when the browser country fallback is
 *    enabled (`VITE_IP_COUNTRY_FALLBACK`, default on): `lookupCountryCode`
 *    falls back to that third-party lookup from the browser whenever the
 *    first-party `/api/country` answers nothing.
 *  - `https://services.sheerid.com` (script-src + frame-src) when the
 *    canonical store theme enables SheerID (`VITE_SHEERID_ENABLED=1`).
 *  - Google Identity origins (script/style/connect/frame) when Google sign-in
 *    is on; the origin lists come from `config/google-signin.ts` via `google`.
 *  - Analytics origins (script/connect) when the brand declares `analytics` in head.json;
 *    the lists come from `analyticsCsp()` in `platform/head.tsx` via `analytics`.
 *    Never `unsafe-eval`: no GTM Custom JavaScript variables, no production Preview mode.
 */
import { YOUTUBE_EMBED_ORIGIN } from '../platform/youtube';
import type { GoogleIdentityCsp } from '../config/google-signin';
import { ipCountryFallbackEnabled } from './visitor-country';

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const IP_LOOKUP_ORIGIN = 'https://ipapi.co';
export const SHEERID_ORIGIN = 'https://services.sheerid.com';

export interface CspOptions {
	/** Per-request nonce for inline scripts. */
	nonce: string;
	/** SellRight API origin (connect-src), when it is not same-origin. */
	apiOrigin?: string;
	/** Turnstile site key; any non-blank value enables the Turnstile origin. */
	turnstileSiteKey?: string | null;
	/** Raw `VITE_IP_COUNTRY_FALLBACK` value; unset = enabled. */
	ipCountryFallback?: string | null;
	/** Canonical store theme SheerID enablement; only true adds the fixed SDK/frame origin. */
	sheerIdEnabled?: boolean;
	/** Extra Google Identity sources (`googleIdentityCsp(...)`); empty lists add nothing. */
	google?: GoogleIdentityCsp;
	/** Analytics sources (`analyticsCsp(...)`); undefined adds nothing, so the policy is unchanged without it. */
	analytics?: { script: string[]; connect: string[] };
	/** Only the platform's fixed privacy embed origin; head.json embeds.youtube must opt in. */
	youtubeEmbed?: boolean;
}

const withSources = (base: string, extra: string[] = []) => [base, ...extra].join(' ');

export function buildCsp({ nonce, apiOrigin, turnstileSiteKey, ipCountryFallback, sheerIdEnabled, google, analytics, youtubeEmbed }: CspOptions): string {
	const turnstile = (turnstileSiteKey ?? '').trim() ? ` ${TURNSTILE_ORIGIN}` : '';
	const ipLookup = ipCountryFallbackEnabled(ipCountryFallback) ? ` ${IP_LOOKUP_ORIGIN}` : '';
	const sheerId = sheerIdEnabled === true ? ` ${SHEERID_ORIGIN}` : '';
	const youtube = youtubeEmbed === true ? ` ${YOUTUBE_EMBED_ORIGIN}` : '';
	const api = apiOrigin ? ` ${apiOrigin}` : '';
	return [
		`default-src 'self'`,
		withSources(`script-src 'self' 'nonce-${nonce}' https://js.stripe.com https://sandbox.nmi.com https://secure.nmi.com${turnstile}${sheerId}`, [...(google?.script ?? []), ...(analytics?.script ?? [])]),
		withSources(`style-src 'self' 'unsafe-inline'`, google?.style),
		`img-src 'self' data: https:`,
		`font-src 'self'`,
		withSources(`connect-src 'self' https://api.stripe.com https://sandbox.nmi.com https://secure.nmi.com${api}${ipLookup}`, [...(google?.connect ?? []), ...(analytics?.connect ?? [])]),
		withSources(`frame-src https://js.stripe.com https://hooks.stripe.com https://sandbox.nmi.com https://secure.nmi.com${turnstile}${youtube}${sheerId}`, google?.frame),
		`object-src 'none'`,
		`base-uri 'self'`,
		`worker-src 'self'`,
		`form-action 'self'`,
		`frame-ancestors 'none'`,
		`upgrade-insecure-requests`,
	].join('; ');
}
