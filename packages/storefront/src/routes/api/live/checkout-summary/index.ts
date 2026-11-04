import type { RequestHandler } from '@qwik.dev/router';
import { COUNTRY_COOKIE } from '~/constants';
import { NO_STORE_CACHE_CONTROL } from '~/config/route-cache-policy';
import { TOKEN_COOKIE } from '~/services/CartService';
import { sellright } from '~/sellright/client';
import { readCheckoutSummaryCart, type CheckoutSummaryResponse } from '~/routes/checkout/summary-cart';

/**
 * ADR-0001: the checkout shell's order summary read, a FIXED url (the shell's Link preload header and its early script both name it
 * exactly) whose answer is the visitor's own cart: it reads the `sr_cart` and `countryCode` cookies of the (credentialed) request and
 * makes the SAME checkout-quote read the server-rendered summary makes (routes/checkout/summary-cart.ts, one function for both), so
 * the painted numbers are the server summary's numbers. Per visitor, so never cached anywhere: `private, no-store` (browser and
 * edge), `Vary: Cookie`, no CDN cache. `/api/*` is a `dynamic` route class (route-cache-policy.ts): the express shell layer neither
 * strips its cookies nor ever stores it. Without an `sr_cart` cookie it answers `{ cart: null }` without calling the API. Any failure
 * or doubt (timeout, other cart, converted, no lines, not the checkout quote) is `{ cart: null }` too: the page then behaves as
 * without the read (its skeleton, then Qwik's own entry read).
 */
export const onGet: RequestHandler = async ({ cookie, headers, json, request }) => {
	headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
	headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
	headers.set('Vary', 'Cookie');
	const body: CheckoutSummaryResponse = {
		cart: await readCheckoutSummaryCart((path, init) => sellright().GET(path, init), cookie.get(TOKEN_COOKIE)?.value, cookie.get(COUNTRY_COOKIE)?.value, request.headers.get('cf-ipcountry')),
	};
	json(200, body);
};
