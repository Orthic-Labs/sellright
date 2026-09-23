import { $, component$, type QRL, type Signal } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';

interface CheckoutCtaProps {
  checkoutState: any;
  checkoutValidation: any;
  formattedTotal: Signal<string | null>;
  isOrderProcessing: Signal<boolean>;
  onPlaceOrder$: QRL<() => void>;
  selectedPaymentMethod: Signal<string>;
  state: { loading: boolean };
}

export const CheckoutDesktopCta = component$<CheckoutCtaProps>((props) => (
  <>
    <div class={`checkout-cta-inline ${!props.checkoutValidation.isAllValid ? 'checkout-cta-inline-invalid' : ''}`}>
      <button
        onClick$={$(() => {
          if (props.state.loading || props.checkoutState.isLoading) return;
          props.onPlaceOrder$();
        })}
        disabled={props.isOrderProcessing.value}
        aria-disabled={!props.checkoutValidation.isAllValid}
        class={`checkout-cta ${!props.checkoutValidation.isAllValid ? 'checkout-cta-invalid' : ''}`}
      >
        {props.state.loading || props.checkoutState.isLoading ? (
          <span class="flex items-center justify-center">
            <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Processing...
          </span>
        ) : (
          <span class="checkout-cta-label flex items-center justify-center">
            {props.selectedPaymentMethod.value === 'sezzle' ? (
              'Continue with Sezzle'
            ) : (
              props.formattedTotal.value
                ? `PLACE ORDER \u2014 ${props.formattedTotal.value}`
                : 'PLACE ORDER'
            )}
          </span>
        )}
        {!props.checkoutValidation.isAllValid && (
          <span class="checkout-cta-stop-icon" aria-hidden="true">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" stroke-width="2"></circle>
              <path stroke-linecap="round" stroke-width="2" d="M8.5 8.5l7 7M15.5 8.5l-7 7"></path>
            </svg>
          </span>
        )}
      </button>
      {!props.checkoutValidation.isAllValid && (
        <div class="checkout-cta-tooltip">
          Please complete all required fields to continue
        </div>
      )}
    </div>
    <div class="checkout-below-cta" style="margin-top:20px;">
      <p class="text-[11px] text-center leading-relaxed" style="color: rgba(28,25,23,0.45)">
        By completing your purchase you agree to our{' '}
        <Link href="/terms" target="_blank" class="underline" style="color: rgba(28,25,23,0.65)">Terms & Conditions</Link>
        {' '}and{' '}
        <Link href="/privacy" target="_blank" class="underline" style="color: rgba(28,25,23,0.65)">Privacy Policy</Link>.
      </p>
      <div class="flex items-center justify-center gap-2 text-[12px] text-[rgba(100,85,65,0.72)] mt-2">
        <svg class="w-4 h-4 text-[rgba(100,85,65,0.7)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 11c1.1 0 2-.9 2-2V7a2 2 0 00-4 0v2c0 1.1.9 2 2 2zm6 0h-1V9a5 5 0 10-10 0v2H6a2 2 0 00-2 2v5a2 2 0 002 2h12a2 2 0 002-2v-5a2 2 0 00-2-2z" />
        </svg>
        <span>Secure checkout · Free shipping over $100 · 30-day returns</span>
      </div>
    </div>
  </>
));

export const CheckoutMobileCta = component$<CheckoutCtaProps>((props) => (
  <div class="sticky-cta-bar">
    <div class="sticky-cta-total">
      <div class="sticky-cta-total-label">Total</div>
      <div class="sticky-cta-total-amount">
        {props.formattedTotal.value ?? '\u2014'}
      </div>
    </div>
    <button
      onClick$={$(() => {
        if (props.state.loading || props.checkoutState.isLoading) return;
        props.onPlaceOrder$();
      })}
      disabled={props.isOrderProcessing.value}
      aria-disabled={!props.checkoutValidation.isAllValid}
      class={`sticky-cta-btn ${!props.checkoutValidation.isAllValid ? 'opacity-50' : ''}`}
    >
      {props.state.loading || props.checkoutState.isLoading ? (
        <span class="flex items-center justify-center gap-2">
          <svg class="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          Processing...
        </span>
      ) : (
        'PLACE ORDER'
      )}
    </button>
  </div>
));
