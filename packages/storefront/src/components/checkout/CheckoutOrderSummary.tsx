import { $, component$, type QRL, type ReadonlySignal, type Signal } from '@qwik.dev/core';
import CartContents from '~/components/cart-contents/CartContents';
import CartTotals from '~/components/cart-totals/CartTotals';
import { LoyaltyRedemptionView, platformAction } from '~/platform/gateway';
import type { LoyaltyViewData } from '~/platform/controllers/loyalty';
import type { ActionResult } from '~/platform/views';
import type { Cart } from '~/sellright/types/cart';
import { formatCents } from '~/hooks/checkout-total';
import { checkoutSummarySource, displayServerCart, hasMixedPreOrder, type ServerCartValue } from '~/routes/checkout/summary-cart';

interface CheckoutOrderSummaryProps {
  formattedTotal: Signal<string | null>;
  hasMixedPreOrder: { value: boolean };
  localCart: any;
  pageLoading: Signal<boolean>;
  /** L11: display-only server read of the cart (routes/checkout/summary-cart.ts), shown until the client's entry read lands. The
   *  ADR-0001 shell marker (#412) is no cart: the summary keeps its reserved skeleton until the entry read lands. */
  serverCart: ReadonlySignal<ServerCartValue>;
  entryReadDone: Signal<boolean>;
  promoExpanded: Signal<boolean>;
  shippingCents: Signal<number | null>;
  /** The loyalty offer projection (platform/controllers/loyalty.ts): null for a guest, a program that is off, or until the account is read. */
  loyalty: ReadonlySignal<LoyaltyViewData | null>;
  /** The only way to change the points the shopper spends; the checkout route owns the redemption signal. */
  onRedeemToggle$: QRL<(on: boolean) => Promise<ActionResult>>;
}

/**
 * A17 mount point: the brand's points-redemption control; the base LoyaltyRedeem is the fallback (both through the gateway handle,
 * which resolves the slot at render time: a module-level slot lookup `?? LoyaltyRedeem` constant was `undefined` inside this
 * component's lazy chunk in the client build). Reads both signals in its own render (an inline `&&` over them in the summary's JSX
 * never re-rendered once the account loaded).
 */
const CheckoutLoyalty = component$<{
  pageLoading: Signal<boolean>;
  loyalty: ReadonlySignal<LoyaltyViewData | null>;
  onRedeemToggle$: QRL<(on: boolean) => Promise<ActionResult>>;
}>((props) => {
  const view = props.loyalty.value;
  if (props.pageLoading.value || !view) return null;
  return <LoyaltyRedemptionView {...view} onRedeemToggle$={platformAction('loyalty.redeem-toggle', props.onRedeemToggle$)} />;
});

export const CheckoutOrderSummary = component$<CheckoutOrderSummaryProps>((props) => {
  const serverCart = displayServerCart(props.serverCart.value);
  // L11: which cart the summary shows (see checkoutSummarySource): the server read only before the client's entry read lands.
  const source = checkoutSummarySource({
    pageLoading: props.pageLoading.value,
    entryReadDone: props.entryReadDone.value,
    client: { status: props.localCart.cart.status, lineCount: props.localCart.cart.lines?.length ?? 0 },
    hasServerCart: !!serverCart,
  });
  const shownCart: Cart | undefined = source === 'server' && serverCart ? serverCart : undefined;
  const formattedTotal = shownCart ? (shownCart.grandTotal > 0 ? formatCents(shownCart.grandTotal) : null) : props.formattedTotal.value;
  const mixedPreOrder = shownCart ? hasMixedPreOrder(shownCart.lines) : props.hasMixedPreOrder.value;
  return (
  <div class="checkout-left order-2 lg:order-1 mb-8 lg:mb-0 lg:basis-[42%]">
    <div class="sticky top-4">
      <div class="bg-transparent rounded-none sm:rounded-xl overflow-hidden">
        <div class="px-4 py-5 border-b border-[rgba(var(--color-accent-rgb),0.25)]">
          <div class="flex items-end justify-between gap-4">
            <div class="flex flex-col gap-1">
              <span class="text-[11px] font-heading font-normal tracking-[0.08em] uppercase text-[rgba(253,250,246,0.42)]">Your Order</span>
              <span class="text-[26px] font-medium text-[#FDFAF6] tabular-nums leading-none">
                {/* While loading, hold the total's line height so the summary does not grow when it arrives (CLS). */}
                {formattedTotal || (props.pageLoading.value ? <span class="inline-block animate-pulse" style="width:96px;height:26px;border-radius:4px;background:rgba(253,250,246,0.08);vertical-align:bottom;" /> : '')}
              </span>
            </div>
            <button
              onClick$={$(() => {
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
              <span>Add coupon or credit code</span>
            </button>
          </div>
        </div>
        <div class="rounded-lg mt-4 mb-3">
          <div class="px-4 py-3 sm:py-4">
            {source === 'skeleton' ? (
              // One placeholder per line the cart mirror already knows (at least one), each as tall as a loaded line (152px at
              // phone width), so the loaded summary does not move the form below it (it shifted 121px, CLS 0.125).
              <div class="space-y-4">
                {Array.from({ length: Math.max(1, props.localCart.cart.lines?.length ?? 0) }, (_, i) => i).map((i) => (
                  <div key={i} class="flex gap-3 animate-pulse" style="min-height:152px;">
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
              <CartContents cart={shownCart} />
            )}
          </div>
        </div>
        {mixedPreOrder && (
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
          {source === 'skeleton' ? (
            <div class="animate-pulse space-y-3" style="padding-top:4px;min-height:146px;">
              <div class="flex justify-between">
                <div style="height:10px;width:60px;border-radius:4px;background:rgba(253,250,246,0.08);" />
                <div style="height:10px;width:48px;border-radius:4px;background:rgba(253,250,246,0.08);" />
              </div>
              <div class="flex justify-between">
                <div style="height:10px;width:50px;border-radius:4px;background:rgba(253,250,246,0.08);" />
                <div style="height:10px;width:40px;border-radius:4px;background:rgba(253,250,246,0.08);" />
              </div>
              <div style="border-top:1px solid rgba(var(--color-accent-rgb),0.15);padding-top:10px;" class="flex justify-between">
                <div style="height:12px;width:40px;border-radius:4px;background:rgba(253,250,246,0.12);" />
                <div style="height:12px;width:56px;border-radius:4px;background:rgba(253,250,246,0.12);" />
              </div>
            </div>
          ) : (
            <CartTotals
              localCart={props.localCart}
              displayCart={shownCart}
              promoPlacement="rows"
              promoExpandedSignal={props.promoExpanded}
              serverShippingCents={props.shippingCents}
            />
          )}
        </div>
        <CheckoutLoyalty pageLoading={props.pageLoading} loyalty={props.loyalty} onRedeemToggle$={props.onRedeemToggle$} />
      </div>
    </div>
  </div>
);
});
