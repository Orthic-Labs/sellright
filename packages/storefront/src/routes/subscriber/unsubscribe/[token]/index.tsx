import type { RequestHandler } from '@qwik.dev/router';
import { fetchSubscriberUnsubscribePage, unsubscribeSubscriber } from '~/sellright/content';

/** GET /subscriber/unsubscribe/{token} — landing page from an email footer
 *  link; proxies the API's own branded HTML form (same pattern as the
 *  confirm route). */
export const onGet: RequestHandler = async ({ params, html, cacheControl }) => {
	cacheControl({ noStore: true });
	const page = await fetchSubscriberUnsubscribePage(params.token);
	if (!page) {
		html(503, '<!doctype html><title>Unavailable</title><p>Unable to unsubscribe right now — please try the link again shortly.</p>');
		return;
	}
	html(page.status, page.html);
};

/** POST /subscriber/unsubscribe/{token} — the one-click unsubscribe a mail
 *  client's `List-Unsubscribe`/`List-Unsubscribe-Post` headers hit directly,
 *  with no page render (RFC 8058). */
export const onPost: RequestHandler = async ({ params, json, cacheControl }) => {
	cacheControl({ noStore: true });
	const result = await unsubscribeSubscriber(params.token);
	json(result.ok ? 200 : 502, result);
};
