import type { RequestHandler } from '@qwik.dev/router';
import { handleListmonkLink } from '~/services/listmonk.server';
import { sellrightRequestHost } from '~/utils/sellright-request-host.server';

/**
 * GET /newsletter/confirm/{uuid} — legacy Listmonk link, served only for a store that configures Listmonk
 * (services/listmonk.server.ts); every other store answers 404 and no upstream is contacted. The store is the
 * request's own host, resolved per request.
 */
export const onGet: RequestHandler = async ({ params, url, request, html, cacheControl }) => {
	cacheControl({ noStore: true });
	const host = sellrightRequestHost.getStore() ?? request.headers.get('x-forwarded-host') ?? url.host;
	const result = await handleListmonkLink('confirm', { host, uuid: params.subscriber });
	html(result.status, result.html);
};
