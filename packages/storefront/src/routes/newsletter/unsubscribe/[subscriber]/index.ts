import type { RequestHandler } from '@qwik.dev/router';
import { deploymentStorePin, handleListmonkLink, isSameOriginPost, newsletterRequestHost, renderListmonkConfirmPage, resolveListmonkConfig } from '~/services/listmonk.server';

/**
 * Legacy Listmonk link `/newsletter/unsubscribe/{uuid}`, served only for a store that configures Listmonk
 * (services/listmonk.server.ts); every other host answers 404 and no upstream is contacted. The store is chosen from a
 * validated host: the connection's Host, or X-Forwarded-Host only for a deployment that declares a trusted proxy
 * (`SELLRIGHT_TRUST_FORWARDED_HOST=1`) — never from the request context the rest of the storefront threads through.
 */
const validatedHost = (request: Request) =>
	newsletterRequestHost({ host: request.headers.get('host'), forwardedHost: request.headers.get('x-forwarded-host') });

/** GET shows a confirmation page only: no upstream call, no change (mail scanners and prefetchers issue GETs). */
export const onGet: RequestHandler = async ({ params, request, html, cacheControl }) => {
	cacheControl({ noStore: true });
	const result = renderListmonkConfirmPage('unsubscribe', { host: validatedHost(request), uuid: params.subscriber, storePin: deploymentStorePin() });
	html(result.status, result.html);
};

/** POST (the page's button, same-origin) unsubscribes; idempotent. */
export const onPost: RequestHandler = async ({ params, request, html, cacheControl }) => {
	cacheControl({ noStore: true });
	const host = validatedHost(request);
	// An unconfigured host is a 404 before anything else (nothing to protect, nothing contacted).
	if (resolveListmonkConfig(host, process.env, deploymentStorePin()) && !isSameOriginPost(request.headers.get('origin'), host)) {
		html(403, '<!doctype html><meta name="robots" content="noindex"><title>Forbidden</title><p>This request could not be verified. Open the link from your email again.</p>');
		return;
	}
	const result = await handleListmonkLink('unsubscribe', { host, uuid: params.subscriber, storePin: deploymentStorePin() });
	html(result.status, result.html);
};
