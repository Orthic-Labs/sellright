import { $, component$, useOnDocument, useSignal } from '@qwik.dev/core';
import { useLocation } from '@qwik.dev/router';
import { Order } from '~/generated/graphql-shop';
import { OrderDetails } from './OrderDetails';
import { trackOrderServer } from '~/services/track-order.service';

export default component$(() => {
  const location = useLocation();
  const orderCode = useSignal('');
  const email = useSignal('');
  const orderData = useSignal<Order | null>(null);
  const loading = useSignal(false);
  const error = useSignal('');
  const hasSearched = useSignal(false);

  // T38: Auto-populate from URL on qinit
  useOnDocument('qinit', $(async () => {
    const urlOrderCode = location.url.searchParams.get('orderCode');
    const urlEmail = location.url.searchParams.get('email');

    if (urlOrderCode) {
      orderCode.value = urlOrderCode;
    }

    if (urlEmail) {
      email.value = decodeURIComponent(urlEmail);
    }

    // If both order code and email are provided, automatically track the order
    if (urlOrderCode && urlEmail) {
      // Auto-submit after a brief moment to ensure UI is ready
      setTimeout(async () => {
        loading.value = true;
        error.value = '';
        hasSearched.value = true;

        try {
          const result = await trackOrderServer(orderCode.value.trim(), email.value.trim());

          if (result.success && result.order) {
            orderData.value = result.order;
            error.value = '';
          } else {
            error.value = result.error || 'Order not found. Please check your order number and email address.';
            orderData.value = null;
          }
        } catch (err) {
          error.value = 'Unable to track order at this time. Please try again later.';
          orderData.value = null;
          console.error('Track order error:', err);
        } finally {
          loading.value = false;
        }
      }, 100);
    } else if (urlOrderCode) {
      // If only order code, focus on email input
      const emailInput = document.getElementById('email');
      if (emailInput) {
        emailInput.focus();
      }
    } else {
      // Otherwise focus on order code input
      const orderInput = document.getElementById('orderCode');
      if (orderInput) {
        orderInput.focus();
      }
    }
  }));

  const handleTrackOrder = $(async () => {
    if (!orderCode.value.trim() || !email.value.trim()) {
      error.value = 'Please enter both order number and email address.';
      return;
    }

    loading.value = true;
    error.value = '';
    hasSearched.value = true;
    orderData.value = null;

    try {
      const result = await trackOrderServer(orderCode.value.trim(), email.value.trim());

      if (result.success && result.order) {
        orderData.value = result.order;
        error.value = '';
      } else {
        error.value = result.error || 'Order not found. Please check your order number and email address.';
        orderData.value = null;
      }
    } catch (err) {
      error.value = 'Unable to track order at this time. Please try again later.';
      orderData.value = null;
      console.error('Track order error:', err);
    } finally {
      loading.value = false;
    }
  });

  const handleReset = $(() => {
    orderCode.value = '';
    email.value = '';
    orderData.value = null;
    error.value = '';
    hasSearched.value = false;

    // Re-focus the order code input
    setTimeout(() => {
      const orderInput = document.getElementById('orderCode');
      if (orderInput) {
        orderInput.focus();
      }
    }, 100);
  });

  return (
    <div class="max-w-5xl mx-auto px-4 sm:px-6 py-8 mt-12">
      <div class="px-1 sm:px-0">
        <div class="mb-8">
          <h1 class="text-4xl font-heading font-normal mb-2 text-[#141210]">Track your order</h1>
          <p class="text-[#645541]">
            Enter your order number and email address to view your order status and tracking information.
          </p>
        </div>
        <div class="border-t border-[#E5E0D8] pt-8">
          <form preventdefault:submit onSubmit$={handleTrackOrder} class="space-y-6">
            <div class="grid md:grid-cols-2 gap-6">
              <div>
                <label for="orderCode" class="block text-sm font-medium text-[#1A1A1A] mb-2 uppercase tracking-[0.08em]">
                  Order Number
                </label>
                <input
                  id="orderCode"
                  type="text"
                  bind:value={orderCode}
                  class="w-full px-4 py-3 border border-[#D8D1C7] rounded-[3px] focus:outline-hidden focus:ring-0 focus:border-[#141210] transition-colors text-base bg-white"
                  placeholder="DD12345"
                  required
                  autocomplete="off"
                />
                <p class="text-sm text-[#7A7166] mt-1">
                  Found in your order confirmation email
                </p>
              </div>

              <div>
                <label for="email" class="block text-sm font-medium text-[#1A1A1A] mb-2 uppercase tracking-[0.08em]">
                  Email Address
                </label>
                <input
                  id="email"
                  type="email"
                  bind:value={email}
                  class="w-full px-4 py-3 border border-[#D8D1C7] rounded-[3px] focus:outline-hidden focus:ring-0 focus:border-[#141210] transition-colors text-base bg-white"
                  placeholder="your.email@example.com"
                  required
                  autocomplete="email"
                />
                <p class="text-sm text-[#7A7166] mt-1">
                  The email used for your order
                </p>
              </div>
            </div>

            <div class="flex gap-4">
              <button
                type="submit"
                disabled={loading.value}
                class="flex-1 bg-[#141210] text-[#FDFAF6] px-8 py-4 rounded-[3px] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity duration-200 font-medium text-sm tracking-[0.14em] uppercase flex items-center justify-center gap-2"
              >
                {loading.value ? (
                  <>
                    <div class="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    <span>Tracking...</span>
                  </>
                ) : (
                  <span>Track Order</span>
                )}
              </button>

              {hasSearched.value && (
                <button
                  type="button"
                  onClick$={handleReset}
                  class="px-6 py-4 border border-[#141210] text-[#141210] rounded-[3px] hover:bg-[#F5F0E8] transition-colors duration-200 font-medium text-sm tracking-[0.08em] uppercase"
                >
                  New Search
                </button>
              )}
            </div>
          </form>

          {/* Error Message */}
          {error.value && (
            <div class="mt-6 p-4 bg-red-50 border border-red-200 rounded-[3px]">
              <div class="flex items-start gap-3">
                <svg class="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <h3 class="text-sm font-semibold text-red-800">Unable to track order</h3>
                  <p class="text-sm text-red-700 mt-1">{error.value}</p>
                </div>
              </div>
            </div>
          )}

          {/* Order Details */}
          {orderData.value && (
            <div class="mt-8">
              <OrderDetails order={orderData.value} />
            </div>
          )}
        </div>
      </div>

      {/* Help Section */}
      <div class="mt-10 border-t border-[#E5E0D8] pt-8">
        <h3 class="text-lg font-heading font-medium text-[#141210] mb-4">Need help?</h3>
        <div class="grid md:grid-cols-2 gap-6 text-sm text-[#645541]">
          <div>
            <h4 class="font-medium text-[#141210] mb-2">Can't find your order number?</h4>
            <p>Check your email for the order confirmation. The order number is usually in the subject line or at the top of the email.</p>
          </div>
          <div>
            <h4 class="font-medium text-[#141210] mb-2">Still having trouble?</h4>
            <p>Contact our support team at <a href="mailto:support@damneddesigns.com" class="text-[#965341] hover:text-[#4F3B26] hover:underline">support@damneddesigns.com</a> with your order details.</p>
          </div>
        </div>
      </div>
    </div>
  );
});
