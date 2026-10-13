import type { RequestHandler } from '@qwik.dev/router';
import { createSEOHead } from '~/utils/seo';
import { CartSeedPage } from '~/platform/controllers/cart-seed';

export const onGet: RequestHandler = ({ headers }) => {
	headers.set('Cache-Control', 'private, no-store');
};

export const head = createSEOHead({ title: 'Preparing your cart', description: 'Preparing your cart.', noindex: true });

export default CartSeedPage;
