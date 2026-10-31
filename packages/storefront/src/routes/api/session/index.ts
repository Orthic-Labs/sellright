import type { RequestHandler } from '@qwik.dev/router';
import { NO_STORE_CACHE_CONTROL } from '~/config/route-cache-policy';
import { theme } from '~/theme/theme.config';
import { resolveSessionCustomer } from '~/utils/session-customer.server';

/**
 * ADR-0001 §1 (I-2): the signed-in customer and the `sr_legacy_cart` hint, per visitor, so never in a cacheable page.
 * The root layout calls this from the browser once per page load. Never cached at the browser or the edge.
 */
export const onGet: RequestHandler = async ({ cookie, headers, url, sharedMap, json }) => {
	headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
	headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
	headers.set('Vary', 'Cookie');
	try {
		json(200, await resolveSessionCustomer({ cookie, headers, url, sharedMap, isDemo: !!theme.isDemo }));
	} catch {
		// An API failure is not "signed out": the client keeps its current state on a non-200.
		json(503, { error: 'session_unavailable' });
	}
};
