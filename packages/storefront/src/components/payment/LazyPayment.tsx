import { component$, useResource$, Resource } from '@qwik.dev/core';

/**
 * Lazy-loaded Payment component wrapper
 * Improves initial page load performance by deferring payment component loading
 */

// Lazy load the actual Payment component using useResource$
// const LazyPayment = lazy$(() => import('../payment/Payment'));

// Fallback loading component
const PaymentLoadingFallback = component$(() => (
  <div class="bg-white border border-gray-200 rounded-lg p-6">
    <div class="animate-pulse">
      <div class="h-6 bg-gray-200 rounded-sm w-1/3 mb-4"></div>
      <div class="space-y-3">
        <div class="h-4 bg-gray-200 rounded-sm w-full"></div>
        <div class="h-4 bg-gray-200 rounded-sm w-3/4"></div>
        <div class="h-4 bg-gray-200 rounded-sm w-1/2"></div>
      </div>
      <div class="mt-6 h-10 bg-gray-200 rounded-sm w-full"></div>
    </div>
  </div>
));

export const LazyPaymentWrapper = component$<any>((props) => {
  const paymentResource = useResource$(async () => {
    const { default: Payment } = await import('../payment/Payment');
    return Payment;
  });

  return (
    <Resource
      value={paymentResource}
      onPending={() => <PaymentLoadingFallback />}
      onRejected={(error) => (
        <div class="bg-red-50 border border-red-200 rounded-lg p-6">
          <div class="text-red-600">
            Failed to load payment component: {error.message}
          </div>
        </div>
      )}
      onResolved={(PaymentComponent) => <PaymentComponent {...props} />}
    />
  );
});

export default LazyPaymentWrapper;
