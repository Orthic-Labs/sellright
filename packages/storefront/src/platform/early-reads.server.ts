// #415: the server half of the early reads (platform/early-reads.ts): fills the page's plan from the build's brand data and this
// render's shell flag, and hands entry.ssr.tsx the writer that puts the script first in <head> (`earlyReadsStream`, wrapped INSIDE the
// head-order writer so the head is reordered first and the script lands right after `<head><meta charset>`, before the stylesheet and
// every Qwik loader tag).
import { hasView } from '~/platform/gateway';
import { DETAIL_PRODUCTS, HOME_SPOTLIGHT } from '~/platform/brand-data';
import { PRODUCT_PREFIX } from '~/platform/product-path';
import { SHOP_STOCK_ON_LOAD } from '~/platform/stock-triggers';
import { shellRender } from '~/platform/shell-render';
import { earlyReadsWriter, type EarlyReadsContext, type EarlyReadsStreamWriter } from '~/platform/early-reads';

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
	};
}

/**
 * The response writer with the early-reads script for this request (see `earlyReadsWriter`). entry.ssr.tsx:
 * `const stream = headOrderWriter(earlyReadsStream(opts.stream, opts.serverData?.url, nonce));`
 */
export function earlyReadsStream<W extends EarlyReadsStreamWriter>(stream: W, url: string | undefined, nonce: string | undefined): W {
	return earlyReadsWriter(stream, { url, nonce, context: earlyReadsContext() });
}
