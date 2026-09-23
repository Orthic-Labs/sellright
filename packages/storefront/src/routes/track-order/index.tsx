import { component$ } from '@qwik.dev/core';
import { createSEOHead } from '~/utils/seo';
import { OrderTracking } from '~/components/order-tracking';
import { theme } from '~/theme/theme.config';

export default component$(() => {
  return (
    <div class="min-h-screen pt-8 pb-20">
      <OrderTracking />
    </div>
  );
});

export const head = createSEOHead({
  title: 'Track Your Order',
  description: `Track your ${theme.storeName} order status and shipping information. Enter your order number and email to get real-time updates.`,
  noindex: true,
});
