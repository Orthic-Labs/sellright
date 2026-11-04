import type { RequestHandler } from '@qwik.dev/router';
import { NO_STORE_CACHE_CONTROL } from '~/config/route-cache-policy';
import { hasView } from '~/platform/gateway';
import { homeLiveValues } from '~/platform/home';
import { buildHomeSpotlight } from '~/platform/home-spotlight';
import { loadBrowseCatalog } from '~/services/browse-catalog';
import { buildConfiguratorDetail } from '~/platform/configurator-detail';
import { productLiveValues } from '~/platform/product';
import { brandProductLive } from '~/platform/product-live';
import { LIVE_READS, type LiveReadName } from '~/platform/early-reads';

/**
 * #415: the GET equivalents of the shell routes' live-values server$ reads (ADR-0001), so the page's early-reads script
 * (platform/early-reads.ts) can start them at document parse with a plain fetch(). Each answers exactly what its server$ answers
 * (same build function, per request) as JSON. Never cached at the browser or the edge; a failure is a 503 (the page then makes its
 * own server$ read). Public catalogue values only: no visitor input but the product slug.
 */
const READS: Record<LiveReadName, (slug: string) => Promise<unknown>> = {
	'home-values': () => homeLiveValues(),
	'home-spotlight': () => buildHomeSpotlight(),
	'shop-catalog': () => loadBrowseCatalog(),
	'shop-configurator': async () => (hasView('route.shop') ? buildConfiguratorDetail() : null),
	'product-values': (slug) => productLiveValues(slug),
	'product-live': (slug) => brandProductLive(slug),
	// served by the license flow's own route (platform/license/routes/api/live/license-catalog); not part of the store flow
	'license-catalog': async () => null,
};

export const onGet: RequestHandler = async ({ params, query, headers, json }) => {
	headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
	headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
	const name = params.read as LiveReadName;
	if (!(LIVE_READS as readonly string[]).includes(name)) {
		json(404, { error: 'unknown_read' });
		return;
	}
	try {
		json(200, (await READS[name](query.get('slug') ?? '')) ?? null);
	} catch {
		json(503, { error: 'live_read_unavailable' });
	}
};
