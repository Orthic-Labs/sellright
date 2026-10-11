/**
 * Content-Security-Policy for the Express entry, built as a pure function so the
 * emitted policy is testable without booting a server. The fixed policy is the
 * per-directive allowlist documented in `entry.express.tsx`; two origins are
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
 */
import { ipCountryFallbackEnabled } from './visitor-country';

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const IP_LOOKUP_ORIGIN = 'https://ipapi.co';

export interface CspOptions {
	/** Per-request nonce for inline scripts. */
	nonce: string;
	/** SellRight API origin (connect-src), when it is not same-origin. */
	apiOrigin?: string;
	/** Turnstile site key; any non-blank value enables the Turnstile origin. */
	turnstileSiteKey?: string | null;
	/** Raw `VITE_IP_COUNTRY_FALLBACK` value; unset = enabled. */
	ipCountryFallback?: string | null;
}

export function buildCsp({ nonce, apiOrigin, turnstileSiteKey, ipCountryFallback }: CspOptions): string {
	const turnstile = (turnstileSiteKey ?? '').trim() ? ` ${TURNSTILE_ORIGIN}` : '';
	const ipLookup = ipCountryFallbackEnabled(ipCountryFallback) ? ` ${IP_LOOKUP_ORIGIN}` : '';
	const api = apiOrigin ? ` ${apiOrigin}` : '';
	return [
		`default-src 'self'`,
		`script-src 'self' 'nonce-${nonce}' https://js.stripe.com https://sandbox.nmi.com https://secure.nmi.com${turnstile}`,
		`style-src 'self' 'unsafe-inline'`,
		`img-src 'self' data: https:`,
		`font-src 'self'`,
		`connect-src 'self' https://api.stripe.com https://sandbox.nmi.com https://secure.nmi.com${api}${ipLookup}`,
		`frame-src https://js.stripe.com https://hooks.stripe.com https://sandbox.nmi.com https://secure.nmi.com${turnstile}`,
		`object-src 'none'`,
		`base-uri 'self'`,
		`worker-src 'self'`,
		`form-action 'self'`,
		`frame-ancestors 'none'`,
		`upgrade-insecure-requests`,
	].join('; ');
}
