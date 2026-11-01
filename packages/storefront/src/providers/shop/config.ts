// The store's public runtime config (GET /v1/shop/config), on its own so the product page's pay-later line, express
// buttons and loyalty line read it without loading the checkout provider (CartService, attribution, order calls) (#429).
import { sellright } from '~/sellright/client';
import { earlyFetch } from '~/platform/early-reads';
import type { ShopConfig } from '~/sellright/types/checkout';

const fetchShopConfig = async (): Promise<ShopConfig> => {
	// Low fetch priority (lane 11): public store settings never compete with the page's image or its live stock read.
	// #415: the page's first config read takes this document's early read of it (once, started at parse), else reads live.
	const { data } = await sellright().GET('/v1/shop/config', { priority: 'low', fetch: earlyFetch });
	if (data === null || data === undefined) throw new Error('Empty shop config response');
	return data as ShopConfig;
};

// One config read per page in the browser (#362): the PDP pay-later line, express buttons, cart drawer, checkout and
// loyalty widgets each asked for it on their own. Public store settings only (no stock, prices or customer data). The
// share is keyed to the page (path + query), so a client-side navigation reads it again, and a failed read is not kept.
// Object-property holder (not a module-level `let`) so the minifier can't fold it. Never used on the server, where a
// module value would outlive the request.
const configShare: { page?: string; read?: Promise<ShopConfig> } = {};

/** Public runtime config — decides whether Stripe is wired for this store. */
export const getShopConfig = (): Promise<ShopConfig> => {
	if (typeof window === 'undefined') return fetchShopConfig();
	const page = window.location.pathname + window.location.search;
	if (configShare.read && configShare.page === page) return configShare.read;
	const read = fetchShopConfig();
	configShare.page = page;
	configShare.read = read;
	read.catch(() => { if (configShare.read === read) configShare.read = undefined; });
	return read;
};
