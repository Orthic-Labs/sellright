// A13: checkout SEO heads and the /checkout/payment redirect moved verbatim from src/routes/checkout/**. The place-order and cart-refresh
// orchestration stays in the route (it is a $ closure over ~15 component signals; see the A13 report).
import type { DocumentHead, RequestHandler } from '@qwik.dev/router';
import { theme } from '~/theme/theme.config';
import { createSEOHead } from '~/utils/seo';
import { useStoreIdentityLoader } from '~/routes/layout';
import { displayOrderCode } from '~/utils/order-code';

export const head = (): DocumentHead => {
  return createSEOHead({
    title: 'Checkout',
    description: `Complete your purchase at ${theme.storeName}.`,
    noindex: true,
    links: []
  });
};

// ── /checkout/payment ───────────────────────────────────────────
export const onGet: RequestHandler = async ({ headers, send }) => {
  // Server-side redirect to avoid any blank page before client hydration
  headers.set('Location', '/checkout');
  send(302, '');
};

export const paymentHead = () => {
  return createSEOHead({
    title: `Payment - ${theme.storeName}`,
    description: 'Payment processing page',
    noindex: true,
  });
};

// ── /checkout/confirmation/[code] ───────────────────────────────
export const confirmationHead = ({ params, resolveValue }: { params: { code: string }; resolveValue: any }) => {
  const identity = resolveValue(useStoreIdentityLoader).identity;
  return createSEOHead({
    title: 'Order Confirmation',
    description: `Thank you for your order${params?.code ? ' ' + displayOrderCode(params.code) : ''} at ${identity.storeName}. View your order summary and details.`,
    noindex: true,
    identity,
  });
};
