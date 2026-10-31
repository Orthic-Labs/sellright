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
 *  - Sign in with Apple origins (script/connect/frame) when Apple sign-in is on, gated per request host exactly like
 *    Google; the lists come from `config/apple-signin.ts` via `apple`.
 *  - Analytics origins (script/connect) when the brand declares `analytics` in head.json;
 *    the lists come from `analyticsCsp()` in `platform/head.tsx` via `analytics`.
 *    Never `unsafe-eval`: no GTM Custom JavaScript variables, no production Preview mode.
 */
import { YOUTUBE_EMBED_ORIGIN } from '../platform/youtube';
import type { GoogleIdentityCsp } from '../config/google-signin';
import type { AppleIdentityCsp } from '../config/apple-signin';
import { ipCountryFallbackEnabled } from './visitor-country';

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const IP_LOOKUP_ORIGIN = 'https://ipapi.co';
export const SHEERID_ORIGIN = 'https://services.sheerid.com';

export interface CspOptions {
	/**
	 * Per-request nonce for inline scripts. Omitted (undefined) only for an ADR-0001 `shell` render: that body may be shared, so
	 * script-src carries no nonce and the express layer adds the sha256 of every executable inline script at response end
	 * (`withScriptHashes`). Never 'unsafe-inline' for scripts, never a shared nonce.
	 */
	nonce: string | undefined;
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
	/** Extra Sign in with Apple sources (`appleIdentityCsp(...)`); empty lists add nothing. */
	apple?: AppleIdentityCsp;
	/** Analytics sources (`analyticsCsp(...)`); undefined adds nothing, so the policy is unchanged without it. */
	analytics?: { script: string[]; connect: string[] };
	/** Only the platform's fixed privacy embed origin; head.json embeds.youtube must opt in. */
	youtubeEmbed?: boolean;
}

const withSources = (base: string, extra: string[] = []) => [base, ...extra].join(' ');

export function buildCsp({ nonce, apiOrigin, turnstileSiteKey, ipCountryFallback, sheerIdEnabled, google, apple, analytics, youtubeEmbed }: CspOptions): string {
	const turnstile = (turnstileSiteKey ?? '').trim() ? ` ${TURNSTILE_ORIGIN}` : '';
	const ipLookup = ipCountryFallbackEnabled(ipCountryFallback) ? ` ${IP_LOOKUP_ORIGIN}` : '';
	const sheerId = sheerIdEnabled === true ? ` ${SHEERID_ORIGIN}` : '';
	const youtube = youtubeEmbed === true ? ` ${YOUTUBE_EMBED_ORIGIN}` : '';
	const api = apiOrigin ? ` ${apiOrigin}` : '';
	return [
		`default-src 'self'`,
		// Collect.js (NMI) injects its own stylesheet from its host and, for Apple Pay, applepay.cdn-apple.com/jsapi
		// (both verified in the live secure.nmi.com/token/Collect.js, 2026-10-26).
		withSources(`script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''} https://js.stripe.com https://sandbox.nmi.com https://secure.nmi.com https://applepay.cdn-apple.com${turnstile}${sheerId}`, [...(google?.script ?? []), ...(apple?.script ?? []), ...(analytics?.script ?? [])]),
		withSources(`style-src 'self' 'unsafe-inline' https://sandbox.nmi.com https://secure.nmi.com`, google?.style),
		`img-src 'self' data: https:`,
		// #400/#377: Apple Pay's button stylesheet (Collect.js / Stripe wallets) loads its font from applepay.cdn-apple.com.
		`font-src 'self' https://applepay.cdn-apple.com`,
		// #400: the Turnstile widget script fetches a data: URL from the page when it runs (blocked on Damned checkout).
		withSources(`connect-src 'self' https://api.stripe.com https://sandbox.nmi.com https://secure.nmi.com${api}${ipLookup}${turnstile ? ' data:' : ''}`, [...(google?.connect ?? []), ...(apple?.connect ?? []), ...(analytics?.connect ?? [])]),
		withSources(`frame-src https://js.stripe.com https://hooks.stripe.com https://sandbox.nmi.com https://secure.nmi.com${turnstile}${youtube}${sheerId}`, [...(google?.frame ?? []), ...(apple?.frame ?? [])]),
		`object-src 'none'`,
		`base-uri 'self'`,
		`worker-src 'self'`,
		`form-action 'self'`,
		`frame-ancestors 'none'`,
		`upgrade-insecure-requests`,
	].join('; ');
}


// ─────────────────────────────────────────────────────────────────────────────
// ADR-0001 item 4: CSP by hash for a shell render (no nonce). The express layer renders a shell request without a nonce, buffers
// the finished body and allows exactly the inline scripts in THAT body by sha256. Pure: `sha256Base64` is injected so this module
// stays free of node:crypto.
// ─────────────────────────────────────────────────────────────────────────────

/** Inline script types that are data, never executed (Qwik state/vnode, JSON-LD). Import maps and modules ARE policed. */
const DATA_SCRIPT_TYPE = /^(application\/(ld\+)?json|qwik\/[a-z-]+|text\/qwik[a-z-]*)$/i;

/** The exact text of every inline script the browser would police under script-src. External (src) and data scripts excluded. */
export function executableInlineScripts(html: string): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
		const attrs = m[1] ?? '';
		if (/\ssrc\s*=/i.test(` ${attrs}`)) continue;
		const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
		const t = (type?.[1] ?? type?.[2] ?? type?.[3] ?? '').trim();
		if (t && DATA_SCRIPT_TYPE.test(t)) continue;
		out.push(m[2] ?? '');
	}
	return out;
}

/** `'sha256-…'` sources for every distinct executable inline script in `html`, in document order. */
export function inlineScriptHashSources(html: string, sha256Base64: (text: string) => string): string[] {
	return [...new Set(executableInlineScripts(html).map((s) => `'sha256-${sha256Base64(s)}'`))];
}

/**
 * The policy with every nonce source removed from script-src and the given hash sources added right after `'self'`. Throws when
 * the policy has no script-src or script-src allows 'unsafe-inline' (a hash policy must never fall back to either).
 */
export function withScriptHashes(csp: string, hashSources: readonly string[]): string {
	const parts = csp.split(/;\s*/);
	const i = parts.findIndex((d) => /^script-src\s/.test(d));
	if (i < 0) throw new Error('CSP has no script-src');
	if (/'unsafe-inline'/.test(parts[i]!)) throw new Error("script-src allows 'unsafe-inline'");
	const tokens = parts[i]!.split(/\s+/).filter((t) => !/^'nonce-/.test(t));
	const at = tokens.indexOf("'self'") >= 0 ? tokens.indexOf("'self'") + 1 : 1;
	tokens.splice(at, 0, ...hashSources);
	parts[i] = tokens.join(' ');
	return parts.join('; ');
}
