import { $, component$, type QRL, type Signal } from '@qwik.dev/core';
import Payment from '~/components/payment/Payment';
import { CheckoutAddresses } from '~/components/checkout/CheckoutAddresses';
import { StripePaymentElement } from '~/components/checkout/StripePaymentElement';
import { SR_CHECKOUT_ENABLED } from '~/providers/shop/checkout/checkout';
import { CheckoutDesktopCta } from './CheckoutCta';

interface CheckoutPaymentPanelProps {
  checkoutState: any;
  checkoutValidation: any;
  formattedTotal: Signal<string | null>;
  isOrderProcessing: Signal<boolean>;
  nmiTriggerSignal: Signal<number>;
  onPaymentError$: QRL<(message: string) => void>;
  onPaymentForward$: QRL<(orderCode: string) => void>;
  onPaymentProcessingChange$: QRL<(processing: boolean) => void>;
  onPlaceOrder$: QRL<() => void>;
  onStripeError$: QRL<(message: string) => void>;
  onStripeProcessingChange$: QRL<(processing: boolean) => void>;
  pageLoading: Signal<boolean>;
  selectedPaymentMethod: Signal<string>;
  sezzleTriggerSignal: Signal<number>;
  srState: any;
  state: { loading: boolean; error: string | null };
  stripeConfirmTrigger: Signal<number>;
  stripePublishableKey: Signal<string>;
}

export const CheckoutPaymentPanel = component$<CheckoutPaymentPanelProps>((props) => (
  <div class="checkout-right order-1 lg:order-2 mb-8 lg:mb-0 lg:basis-[58%]">
    <div class="checkout-right-inner" style="padding:8px 20px 32px;">
      <div style="display:flex;align-items:center;gap:0;margin-bottom:24px;padding:4px 0;">
        <div style="display:flex;align-items:center;gap:8px;">
          <div style={{
            width: '24px', height: '24px', borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '11px', fontWeight: '500',
            background: props.checkoutValidation.isShippingAddressValid && props.checkoutValidation.isCustomerValid ? '#B87333' : '#141210',
            color: '#FDFAF6', transition: 'background 0.3s',
          }}>
            {props.checkoutValidation.isShippingAddressValid && props.checkoutValidation.isCustomerValid ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FDFAF6" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>
            ) : '1'}
          </div>
          <span style={{
            fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase',
            color: props.checkoutValidation.isShippingAddressValid && props.checkoutValidation.isCustomerValid ? '#B87333' : '#141210',
            fontWeight: '500', transition: 'color 0.3s',
          }}>Shipping</span>
        </div>
        <div style={{
          flex: '1', height: '1px', margin: '0 12px',
          background: props.checkoutValidation.isShippingAddressValid && props.checkoutValidation.isCustomerValid ? '#B87333' : 'rgba(100,85,65,0.15)',
          transition: 'background 0.3s',
        }} />
        <div style="display:flex;align-items:center;gap:8px;">
          <div style={{
            width: '24px', height: '24px', borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '11px', fontWeight: '500',
            background: props.checkoutValidation.isShippingAddressValid && props.checkoutValidation.isCustomerValid ? '#141210' : 'rgba(100,85,65,0.12)',
            color: props.checkoutValidation.isShippingAddressValid && props.checkoutValidation.isCustomerValid ? '#FDFAF6' : 'rgba(100,85,65,0.4)',
            transition: 'all 0.3s',
          }}>2</div>
          <span style={{
            fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase',
            color: props.checkoutValidation.isShippingAddressValid && props.checkoutValidation.isCustomerValid ? '#141210' : 'rgba(100,85,65,0.35)',
            fontWeight: '500', transition: 'color 0.3s',
          }}>Payment</span>
        </div>
      </div>
      <div class="mb-3">
        {props.pageLoading.value ? (
          <div class="animate-pulse" style="padding-top:8px;">
            <div style="height:14px;width:140px;border-radius:4px;background:rgba(100,85,65,0.1);margin-bottom:20px;" />
            <div class="flex gap-3" style="margin-bottom:14px;">
              <div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
              <div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
            </div>
            <div style="height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);margin-bottom:14px;" />
            <div style="height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);margin-bottom:24px;" />
            <div style="height:14px;width:160px;border-radius:4px;background:rgba(100,85,65,0.1);margin-bottom:20px;" />
            <div style="height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);margin-bottom:14px;" />
            <div class="flex gap-3" style="margin-bottom:14px;">
              <div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
              <div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
            </div>
            <div class="flex gap-3">
              <div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
              <div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
            </div>
          </div>
        ) : (
          <CheckoutAddresses />
        )}
      </div>
      <div id="checkout-payment-section" style="margin-bottom:14px;scroll-margin-top:16px;">
        <div
          class="grid transition-all duration-500 ease-out"
          style={{
            gridTemplateRows: (props.checkoutValidation.isCustomerValid && props.checkoutValidation.isShippingAddressValid) ? '1fr' : '0fr',
            opacity: (props.checkoutValidation.isCustomerValid && props.checkoutValidation.isShippingAddressValid) ? '1' : '0',
          }}
        >
          <div class="overflow-hidden">
            {SR_CHECKOUT_ENABLED ? (
              <div id="stripe-payment-element-section" style="scroll-margin-top:16px;">
                {props.srState.phase === 'paying' && props.stripePublishableKey.value && props.srState.clientSecret ? (
                  <>
                    <StripePaymentElement
                      publishableKey={props.stripePublishableKey.value}
                      clientSecret={props.srState.clientSecret}
                      returnUrl={`${typeof location !== 'undefined' ? location.origin : ''}/checkout/confirmation/${props.srState.code}${props.srState.receiptToken ? `?rt=${encodeURIComponent(props.srState.receiptToken)}` : ''}`}
                      confirmTrigger={props.stripeConfirmTrigger}
                      onError$={props.onStripeError$}
                      onProcessingChange$={props.onStripeProcessingChange$}
                    />
                    <button
                      type="button"
                      onClick$={$(() => { if (!props.state.loading) props.stripeConfirmTrigger.value = props.stripeConfirmTrigger.value + 1; })}
                      disabled={props.state.loading}
                      class="checkout-cta"
                      style="margin-top:14px;"
                    >
                      {props.state.loading
                        ? 'Processing...'
                        : (props.formattedTotal.value ? `PAY \u2014 ${props.formattedTotal.value}` : 'PAY')}
                    </button>
                  </>
                ) : (
                  <div class="payment-placeholder" style="padding:14px 0;">
                    {props.srState.phase === 'placing'
                      ? 'Preparing secure payment...'
                      : 'Click PLACE ORDER to continue to secure card payment.'}
                  </div>
                )}
              </div>
            ) : (
              <Payment
                triggerNMISignal={props.nmiTriggerSignal}
                triggerSezzleSignal={props.sezzleTriggerSignal}
                selectedPaymentMethod={props.selectedPaymentMethod}
                hideButton={true}
                onForward$={props.onPaymentForward$}
                onError$={props.onPaymentError$}
                onProcessingChange$={props.onPaymentProcessingChange$}
                isDisabled={false}
              />
            )}
          </div>
        </div>
        {!(props.checkoutValidation.isCustomerValid && props.checkoutValidation.isShippingAddressValid) && (
          <div class="payment-placeholder">
            Complete your shipping address to see payment options
          </div>
        )}
      </div>
      {props.state.error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '12px 16px', marginBottom: '12px',
          borderRadius: '6px', border: '1px solid rgba(184,115,51,0.25)',
          background: 'rgba(184,115,51,0.06)',
          fontSize: '13px', color: '#141210',
          fontFamily: 'var(--font-body, "IBM Plex Sans", sans-serif)',
        }}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="#B87333" style={{ flexShrink: 0 }}>
            <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
          </svg>
          <span>{props.state.error}</span>
        </div>
      )}
      <CheckoutDesktopCta {...props} />
    </div>
  </div>
));
