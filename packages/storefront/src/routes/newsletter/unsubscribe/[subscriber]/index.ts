import type { RequestHandler } from '@qwik.dev/router';
import { deploymentStorePin, handleListmonkLink, isSameOriginPost, newsletterRequestHost, renderListmonkConfirmPage } from '~/services/listmonk.server';
import { apiBase } from '~/utils/sellright';

/**
 * Legacy Listmonk link `/newsletter/unsubscribe/{uuid}`. The page is rendered here; the Listmonk call is made by the
 * SellRight API from the store's own connection (services/listmonk.server.ts), so no storefront env is needed. The
 * store is chosen from a validated host: the connection's Host, or X-Forwarded-Host only for a deployment that
 * declares a trusted proxy (`SELLRIGHT_TRUST_FORWARDED_HOST=1`) — never from the request context the rest of the
 * storefront threads through.
 */
const validatedHost = (request: Request) =>
	newsletterRequestHost({ host: request.headers.get('host'), forwardedHost: request.headers.get('x-forwarded-host') });

/** GET shows a confirmation page only: no upstream call, no change (mail scanners and prefetchers issue GETs). */
export const onGet: RequestHandler = async ({ params, html, cacheControl }) => {
	cacheControl({ noStore: true });
	const result = renderListmonkConfirmPage('unsubscribe', { uuid: params.subscriber });
	html(result.status, result.html);
};

/** POST (the page's button, same-origin) unsubscribes; idempotent. */
export const onPost: RequestHandler = async ({ params, request, html, cacheControl }) => {
	cacheControl({ noStore: true });
	const host = validatedHost(request);
	// Fails closed: no usable host or no same-origin Origin means nothing is contacted.
	if (!isSameOriginPost(request.headers.get('origin'), host)) {
		html(403, '<!doctype html><meta name="robots" content="noindex"><title>Forbidden</title><p>This request could not be verified. Open the link from your email again.</p>');
		return;
	}
	const result = await handleListmonkLink('unsubscribe', { host, uuid: params.subscriber, apiBase: apiBase(), storePin: deploymentStorePin() });
	html(result.status, result.html);
};
