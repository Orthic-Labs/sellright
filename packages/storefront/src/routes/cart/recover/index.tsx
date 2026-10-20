import { component$, useVisibleTask$ } from '@qwik.dev/core';
import type { RequestHandler } from '@qwik.dev/router';
import { createSEOHead } from '~/utils/seo';

export const onGet: RequestHandler = ({ headers }) => {
	headers.set('Cache-Control', 'private, no-store');
	headers.set('Referrer-Policy', 'no-referrer');
};

export const head = createSEOHead({ title: 'Restoring your cart', description: 'Restoring your cart.', noindex: true });

/** Landing page for the abandoned-cart reminder email. The API validates the
 *  signed link, then redirects here with the cart token in the URL fragment
 *  (`#t=<token>`, never sent to a server). We install the `sr_cart` cookie —
 *  same attributes as CartService.writeTokenCookie — and continue to checkout,
 *  where the live cart is read, re-priced and stock-checked as usual. */
export default component$(() => {
	useVisibleTask$(() => {
		const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('t');
		if (token && token.length <= 200) {
			const secure = window.location.protocol === 'https:' ? '; Secure' : '';
			document.cookie = `sr_cart=${encodeURIComponent(token)}; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax${secure}`;
			window.location.replace('/checkout/');
			return;
		}
		window.location.replace('/');
	});
	return <p class="py-12 text-center">Restoring your cart…</p>;
});
