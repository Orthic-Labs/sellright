import { $, component$, type Signal } from '@qwik.dev/core';
import CartContents from '~/components/cart-contents/CartContents';
import CartTotals from '~/components/cart-totals/CartTotals';

interface CheckoutOrderSummaryProps {
  formattedTotal: Signal<string | null>;
  hasMixedPreOrder: Signal<boolean>;
  localCart: any;
  pageLoading: Signal<boolean>;
  promoExpanded: Signal<boolean>;
}

export const CheckoutOrderSummary = component$<CheckoutOrderSummaryProps>((props) => (
  <div class="checkout-left order-2 lg:order-1 mb-8 lg:mb-0 lg:basis-[42%]">
    <div class="sticky top-4">
      <div class="bg-transparent rounded-none sm:rounded-xl overflow-hidden">
        <div class="px-4 py-5 border-b border-[rgba(184,115,51,0.25)]">
          <div class="flex items-end justify-between gap-4">
            <div class="flex flex-col gap-1">
              <span class="text-[11px] font-heading font-normal tracking-[0.08em] uppercase text-[rgba(253,250,246,0.42)]">Your Order</span>
              <span class="text-[26px] font-medium text-[#FDFAF6] tabular-nums leading-none">
                {props.formattedTotal.value ?? ''}
              </span>
            </div>
            <button
              onClick$={$(() => {
                if (props.localCart.appliedCoupon) return;
                const willOpen = !props.promoExpanded.value;
                props.promoExpanded.value = willOpen;
                if (willOpen) {
                  setTimeout(() => {
                    document.getElementById('checkout-promo-code-input')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                  }, 60);
                }
              })}
              class="inline-flex items-center py-0.5 mb-0.5 text-[12px] text-[rgba(253,250,246,0.42)] hover:text-[rgba(253,250,246,0.72)] transition-colors cursor-pointer bg-transparent border-0"
            >
              <span>Add promo code</span>
            </button>
          </div>
        </div>
        <div class="rounded-lg mt-4 mb-3">
          <div class="px-4 py-3 sm:py-4">
            {props.pageLoading.value ? (
              <div class="space-y-4">
                {[1, 2].map((i) => (
                  <div key={i} class="flex gap-3 animate-pulse">
                    <div style="width:56px;height:56px;border-radius:6px;background:rgba(253,250,246,0.08);flex-shrink:0;" />
                    <div class="flex-1" style="min-width:0;">
                      <div style="height:12px;width:70%;border-radius:4px;background:rgba(253,250,246,0.1);margin-bottom:8px;" />
                      <div style="height:10px;width:40%;border-radius:4px;background:rgba(253,250,246,0.06);" />
                    </div>
                    <div style="height:12px;width:48px;border-radius:4px;background:rgba(253,250,246,0.1);flex-shrink:0;" />
                  </div>
                ))}
              </div>
            ) : (
              <CartContents />
            )}
          </div>
        </div>
        {props.hasMixedPreOrder.value && (
          <div class="bg-amber-50/10 border border-amber-200/20 rounded-lg mx-4 mb-4 p-4">
            <div class="flex items-start">
              <div class="flex-shrink-0">
                <svg class="h-5 w-5 text-amber-400/60" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                </svg>
              </div>
              <div class="ml-3">
                <h3 class="text-sm font-medium text-[rgba(253,250,246,0.8)]">Pre-Order Items Notice</h3>
                <div class="mt-2 text-sm text-[rgba(253,250,246,0.5)]">
                  <p>Your order contains pre-order items. Your entire order will ship together when the last pre-order item becomes available.</p>
                </div>
              </div>
            </div>
          </div>
        )}
        <div class="px-4 pb-4 pt-2">
          {props.pageLoading.value ? (
            <div class="animate-pulse space-y-3" style="padding-top:4px;">
              <div class="flex justify-between">
                <div style="height:10px;width:60px;border-radius:4px;background:rgba(253,250,246,0.08);" />
                <div style="height:10px;width:48px;border-radius:4px;background:rgba(253,250,246,0.08);" />
              </div>
              <div class="flex justify-between">
                <div style="height:10px;width:50px;border-radius:4px;background:rgba(253,250,246,0.08);" />
                <div style="height:10px;width:40px;border-radius:4px;background:rgba(253,250,246,0.08);" />
              </div>
              <div style="border-top:1px solid rgba(184,115,51,0.15);padding-top:10px;" class="flex justify-between">
                <div style="height:12px;width:40px;border-radius:4px;background:rgba(253,250,246,0.12);" />
                <div style="height:12px;width:56px;border-radius:4px;background:rgba(253,250,246,0.12);" />
              </div>
            </div>
          ) : (
            <CartTotals
              order={undefined}
              localCart={props.localCart}
              promoPlacement="rows"
              promoExpandedSignal={props.promoExpanded}
            />
          )}
        </div>
      </div>
    </div>
  </div>
));
