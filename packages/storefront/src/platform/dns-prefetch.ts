// #425: the document head pre-resolves only the third-party hosts this brand actually uses. Before, every store prefetched NMI, Sezzle
// (live + sandbox), SheerID and three geo-IP hosts (two of which nothing calls and the CSP blocks), whatever its configuration.
//   - Payment gateways: the store's own `GET /v1/shop/config` `gateways` (its admin Settings), read per host by the express layer with
//     the social sign-in ids (utils/social-sign-in.server.ts) and handed to the render as the `x-sr-gateways` request header. Rotten
//     (Stripe) reports none of NMI/Sezzle and gets none of their hosts.
//   - SheerID: the built theme flag (VITE_SHEERID_ENABLED, the same flag the CSP and the offer use).
//   - Geo-IP: ipapi.co only while the browser country fallback is on (VITE_IP_COUNTRY_FALLBACK, utils/visitor-country.ts).
import { PROVIDER_PREFETCH_ORIGINS } from '~/platform/payments/labels';
import { ipCountryFallbackEnabled } from '~/utils/visitor-country';
import { IP_LOOKUP_ORIGIN, SHEERID_ORIGIN } from '~/utils/csp';

/** The internal request header carrying the store's configured gateways (set by entry.express.tsx, never trusted from a client). */
export const GATEWAYS_HEADER = 'x-sr-gateways';

/** NMI Collect.js's live host (services/NmiCollect.ts collectJsSrc). */
export const NMI_PREFETCH_ORIGIN = 'https://secure.nmi.com';

const KNOWN_GATEWAYS = ['stripe', 'nmi', 'sezzle'] as const;

/** The gateway ids a shop config enables (`gateways.<id>` truthy), known ids only. Pure. */
export function gatewaysFromShopConfig(body: unknown): string[] {
	const g = (body as { gateways?: Record<string, unknown> } | null)?.gateways;
	if (!g || typeof g !== 'object') return [];
	return KNOWN_GATEWAYS.filter((id) => !!g[id]);
}

/** The header value parsed back: known ids only, so a forged or malformed value adds nothing. Pure. */
export function parseGatewaysHeader(raw: string | string[] | undefined | null): string[] {
	const v = Array.isArray(raw) ? raw.join(',') : raw ?? '';
	const ids = v.split(',').map((s) => s.trim().toLowerCase());
	return KNOWN_GATEWAYS.filter((id) => ids.includes(id));
}

export interface DnsPrefetchInputs {
	gateways: readonly string[];
	sheerIdEnabled: boolean;
	/** Raw VITE_IP_COUNTRY_FALLBACK; unset = enabled. */
	ipCountryFallback: string | null | undefined;
}

/** The dns-prefetch origins for this brand, in the order the head emitted them. Pure. */
export function dnsPrefetchOrigins({ gateways, sheerIdEnabled, ipCountryFallback }: DnsPrefetchInputs): string[] {
	const out: string[] = [];
	if (gateways.includes('nmi')) out.push(NMI_PREFETCH_ORIGIN);
	if (sheerIdEnabled) out.push(SHEERID_ORIGIN);
	if (gateways.includes('sezzle')) out.push(...PROVIDER_PREFETCH_ORIGINS);
	if (ipCountryFallbackEnabled(ipCountryFallback)) out.push(IP_LOOKUP_ORIGIN);
	return out;
}
