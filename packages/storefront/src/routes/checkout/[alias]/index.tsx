// routes.json operational.cartSeedPath (e.g. Rotten's /checkout/facebook/): the cart-link seed under a brand's own alias. Any other
// /checkout/<segment>/ is today's catch-all 404 (onGet, head and component).
import { component$ } from '@qwik.dev/core';
import { useLocation, type DocumentHead, type RequestHandler } from '@qwik.dev/router';
import CatchAll, { head as catchAllHead, onGet as catchAllOnGet, useLegacyRedirects } from '../../[...catchall]/index';
import { CartSeedPage } from '~/platform/controllers/cart-seed';
import { BRAND_ROUTES } from '~/platform/brand-data';
import { createSEOHead } from '~/utils/seo';

export { useLegacyRedirects };

const SEED_PATH = BRAND_ROUTES?.operational?.cartSeedPath ?? null;
const isSeed = (pathname: string) => SEED_PATH !== null && (pathname === SEED_PATH || `${pathname}/` === SEED_PATH);

export const onGet: RequestHandler = async (ev) => {
	if (isSeed(ev.url.pathname)) {
		ev.headers.set('Cache-Control', 'private, no-store');
		return;
	}
	return catchAllOnGet(ev);
};

const SEED_HEAD = createSEOHead({ title: 'Preparing your cart', description: 'Preparing your cart.', noindex: true });
export const head: DocumentHead = (props) => (isSeed(props.url.pathname) ? SEED_HEAD : typeof catchAllHead === 'function' ? catchAllHead(props) : catchAllHead) as ReturnType<Extract<DocumentHead, (...a: never[]) => unknown>>;

/** With an alias configured, the exact alias path is the seed page and every other segment the 404 page. */
const AliasOrNotFound = component$(() => {
	const location = useLocation();
	return isSeed(location.url.pathname) ? <CartSeedPage /> : <CatchAll />;
});

export default SEED_PATH ? AliasOrNotFound : CatchAll;
