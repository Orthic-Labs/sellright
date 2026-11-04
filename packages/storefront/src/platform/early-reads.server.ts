// #415: the server half of the early reads (platform/early-reads.ts): fills the page's plan from the build's brand data and this
// render's shell flag, and hands entry.ssr.tsx the writer that puts the script first in <head> (`earlyReadsStream`, wrapped INSIDE the
// head-order writer so the head is reordered first and the script lands right after `<head><meta charset>`, before the stylesheet and
// every Qwik loader tag).
import { hasView } from '~/platform/gateway';
import { DETAIL_PRODUCTS, HOME_SPOTLIGHT } from '~/platform/brand-data';
import { PRODUCT_PREFIX } from '~/platform/product-path';
import { SHOP_STOCK_ON_LOAD } from '~/platform/stock-triggers';
import { shellRender } from '~/platform/shell-render';
import { COMMERCE_FLOW } from '~/platform/license/flow-env';
import type { RequestHandler } from '@qwik.dev/router';
import { isInternalDataRequest } from '~/config/route-cache-policy';
import { earlyReadsLinkHeader, earlyReadsWriter, type EarlyReadsContext, type EarlyReadsStreamWriter } from '~/platform/early-reads';
import { ASSET_VARIANT_REV } from '~/components/ui/LazyImage';
import { theme } from '~/theme/theme.config';

/** This build's context for a render (`shell`: this request may be stored as a shared shell, so its values are read in the browser). */
export function earlyReadsContext(shell = shellRender()): EarlyReadsContext {
	return {
		productPrefix: PRODUCT_PREFIX,
		shell,
		brandHome: hasView('route.home'),
		brandShop: hasView('route.shop'),
		brandProduct: hasView('route.product'),
		homeSpotlightSlug: HOME_SPOTLIGHT?.slug ?? null,
		detailSlugs: DETAIL_PRODUCTS.map((p) => p.slug),
		shopLiveListing: SHOP_STOCK_ON_LOAD === 'live',
		license: COMMERCE_FLOW === 'license',
		assetDomain: theme.domain,
		assetRev: ASSET_VARIANT_REV,
	};
}

/**
 * The response writer with the early-reads script for this request (see `earlyReadsWriter`). entry.ssr.tsx:
 * `const stream = headOrderWriter(earlyReadsStream(opts.stream, opts.serverData?.url, nonce));`
 */
export function earlyReadsStream<W extends EarlyReadsStreamWriter>(stream: W, url: string | undefined, nonce: string | undefined): W {
	return earlyReadsWriter(stream, { url, nonce, context: earlyReadsContext() });
}

/** The `Link: rel=preload` header of this request's response, or null (see `earlyReadsLinkHeader`): null unless this render is a shell. */
export function shellEarlyHintsLink(pathname: string): string | null {
	return earlyReadsLinkHeader(pathname, earlyReadsContext());
}

/**
 * Route `onRequest` of `/shop/` and `/checkout/`: the shell's `Link` preload header (ADR-0001, Cloudflare Early Hints). Only on a GET
 * document request rendered as a shell (shellRender(): SHELL_CACHE on and the request middleware marked it); a SHELL_CACHE_EXCLUDE
 * path, a dynamic request, a loader/action data request and every other method get no header at all, so they are byte-identical to
 * the render without the switch. The value depends on the path and the build only: never on a cookie, token or country.
 */
export const earlyHintsOnRequest: RequestHandler = ({ url, method, headers, sharedMap }) => {
	if (method !== 'GET' || isInternalDataRequest(sharedMap)) return;
	const link = shellEarlyHintsLink(url.pathname);
	if (link) headers.set('Link', link);
};
