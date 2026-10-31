import type { RequestHandler } from '@qwik.dev/router';
import { NO_STORE_CACHE_CONTROL } from '~/config/route-cache-policy';
import { validatedRequestHost } from '~/utils/trusted-request.server';
import { loadCatalog } from '../../../../catalog';
import { variantForHost } from '../../../../variant';

/**
 * #425: the GET equivalent of the license home's `readCatalog` server$ (same host boundary, same catalog), so the page's parse-time
 * reads script (platform/early-reads.ts) starts the price read with a plain fetch() instead of after app boot. Live, never cached
 * (browser or edge); a failure is a 503 and the page makes its own server$ read.
 */
export const onGet: RequestHandler = async ({ request, url, headers, json }) => {
	headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
	headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
	try {
		const host = validatedRequestHost({ host: request.headers.get('host') ?? url.host, 'x-forwarded-host': request.headers.get('x-forwarded-host') ?? undefined });
		json(200, await loadCatalog(variantForHost(host).collection));
	} catch {
		json(503, { error: 'live_read_unavailable' });
	}
};
