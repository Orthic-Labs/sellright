import type { RequestHandler } from '@qwik.dev/router';
import { NO_STORE_CACHE_CONTROL } from '~/config/route-cache-policy';
import { COUNTRY_HEADER, parseCdnCountry, trustsCdnCountryHeader } from '~/utils/visitor-country';

/**
 * Visitor country from the CDN country header. Per-visitor answer: never cached at the browser or the edge.
 * The header is read ONLY when `BEHIND_CLOUDFLARE=1` says the edge overwrites it; otherwise a client that reaches the
 * origin directly could set any country, so the answer is null. `country_code: null` tells the client to fall back to
 * its next source.
 */
export const onGet: RequestHandler = async ({ request, headers, json }) => {
	headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
	headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
	const trusted = trustsCdnCountryHeader(process.env.BEHIND_CLOUDFLARE);
	json(200, { country_code: trusted ? parseCdnCountry(request.headers.get(COUNTRY_HEADER)) : null });
};
