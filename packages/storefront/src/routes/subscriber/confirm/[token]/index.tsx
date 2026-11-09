import type { RequestHandler } from '@qwik.dev/router';
import { confirmSubscriberPage, fetchSubscriberConfirmPage } from '~/sellright/content';

/**
 * GET /subscriber/confirm/{token} — landing page for the double opt-in link sent in
 * the newsletter/waitlist confirmation email. The API renders its own
 * branded HTML page for this (`GET /v1/shop/subscriber/confirm/{token}`), so
 * this route proxies it verbatim rather than re-implementing a confirmation
 * UI the storefront has no state to drive (the API is what actually flips
 * the subscriber to confirmed).
 */
export const onGet: RequestHandler = async ({ params, html, cacheControl }) => {
	cacheControl({ noStore: true });
	const page = await fetchSubscriberConfirmPage(params.token);
	if (!page) {
		html(503, '<!doctype html><title>Unavailable</title><p>Unable to confirm right now — please try the link again shortly.</p>');
		return;
	}
	html(page.status, page.html);
};

/** POST /subscriber/confirm/{token} — the landing page's Confirm button (an explicit press; GET never changes state, so mail
 *  scanners and prefetchers cannot confirm). Proxies the API's result page, as the unsubscribe route does. */
export const onPost: RequestHandler = async ({ params, html, cacheControl }) => {
	cacheControl({ noStore: true });
	const page = await confirmSubscriberPage(params.token);
	if (!page) {
		html(503, '<!doctype html><title>Unavailable</title><p>Unable to confirm right now — please try the link again shortly.</p>');
		return;
	}
	html(page.status, page.html);
};
