import { $, component$, type QRL, type ReadonlySignal, type Signal } from '@qwik.dev/core';
import { useStoreIdentityLoader } from '~/routes/layout';
import { OrderProcessingModal, platformAction } from '~/platform/gateway';
import { CheckoutEmptyCart } from './CheckoutEmptyCart';
import { CheckoutMobileCta } from './CheckoutCta';
import { CheckoutOrderSummary } from './CheckoutOrderSummary';
import { CheckoutPaymentPanel } from './CheckoutPaymentPanel';
import { CheckoutPaymentMessaging } from './CheckoutPaymentMessaging';
import type { PaymentMessagingOptions } from './payment-messaging';
import { CheckoutResumePanel } from './CheckoutResumePanel';
import type { PaymentInitState } from './PaymentInitRetry';
import type { ShopConfig } from '~/sellright/types/checkout';
import type { CheckoutPhase, PaymentMethod, ResumeView } from '~/hooks/useCheckout';
import type { LoyaltyViewData } from '~/platform/controllers/loyalty';
import type { ActionResult } from '~/platform/views';

interface CheckoutPageViewProps {
  checkoutState: any;
  checkoutValidation: any;
  formattedTotal: Signal<string | null>;
  /** Pay-over-time messaging shown at the top of checkout; null hides it. */
  paymentMessaging: ReadonlySignal<PaymentMessagingOptions | null>;
  gatewayConfirmTrigger: Signal<number>;
  totalConfirmed: Signal<boolean>;
  hasMixedPreOrder: { value: boolean };
  shopConfig: Signal<ShopConfig | null>;
  isCartEmpty: Signal<boolean>;
  isOrderProcessing: Signal<boolean>;
  localCart: any;
  onGatewaySuccess$: QRL<() => void>;
  onPaymentError$: QRL<(message: string, mountGen?: number) => void>;
  onPaymentInitError$: QRL<(message: string, mountGen?: number) => void>;
  onPaymentProcessingChange$: QRL<(processing: boolean, mountGen?: number) => void>;
  onPlaceOrder$: QRL<() => void>;
  onResumeMethod$: QRL<(method: PaymentMethod) => void>;
  onResumeRetry$: QRL<() => void>;
  onStartNewCart$: QRL<() => void>;
  pageLoading: Signal<boolean>;
  paymentInit: PaymentInitState;
  paymentMethod: Signal<PaymentMethod>;
  promoExpanded: Signal<boolean>;
  loyalty: ReadonlySignal<LoyaltyViewData | null>;
  onRedeemToggle$: QRL<(on: boolean) => Promise<ActionResult>>;
  shippingCents: Signal<number | null>;
  showProcessingModal: Signal<boolean>;
  srState: {
    phase: CheckoutPhase;
    code: string;
    receiptToken: string;
    clientSecret: string;
    grandTotal: number;
    shownTotal: number;
    error: string | null;
    resume: ResumeView;
    resumeLines: { name: string; quantity: number }[];
    paymentError: string | null;
  };
  state: { loading: boolean; error: string | null };
  stripeConfirmTrigger: Signal<number>;
  stripePublishableKey: Signal<string>;
}

export const CheckoutPageView = component$<CheckoutPageViewProps>((props) => {
  const identity = useStoreIdentityLoader();
  return (
  <div class="checkout-layout">
    {props.srState.resume !== 'none' ? (
      // Resuming a converted cart's original order comes BEFORE the empty-cart view and every form/shipping/stock gate:
      // its own minimal payment view, never the new-order panel.
      <CheckoutResumePanel
        gatewayConfirmTrigger={props.gatewayConfirmTrigger}
        onGatewaySuccess$={props.onGatewaySuccess$}
        onPaymentError$={props.onPaymentError$}
        onPaymentInitError$={props.onPaymentInitError$}
        onPaymentProcessingChange$={props.onPaymentProcessingChange$}
        onResumeMethod$={props.onResumeMethod$}
        onResumeRetry$={props.onResumeRetry$}
        onStartNewCart$={props.onStartNewCart$}
        paymentInit={props.paymentInit}
        paymentMethod={props.paymentMethod}
        shopConfig={props.shopConfig}
        srState={props.srState}
        state={props.state}
        stripeConfirmTrigger={props.stripeConfirmTrigger}
        stripePublishableKey={props.stripePublishableKey}
      />
    ) : !props.pageLoading.value && props.isCartEmpty.value ? (
      // A refused order (409 / pre-submit read) drops the sold-out line and empties the cart: say why instead of a bare empty state.
      <CheckoutEmptyCart message={props.localCart.notice || props.state.error} />
    ) : (
      <div class="min-h-screen">
        <OrderProcessingModal
          visible={props.showProcessingModal.value}
          storeName={identity.value.identity.storeName}
          onClose$={platformAction('ui.press', $(() => {
            props.showProcessingModal.value = false;
            props.isOrderProcessing.value = false;
          }))}
        />
        <div class="max-w-7xl mx-auto pt-5 pb-10 sm:px-6 lg:px-8">
          <CheckoutPaymentMessaging options={props.paymentMessaging.value} />
          <div class="checkout-columns lg:flex lg:gap-x-8 xl:gap-x-12">
            <CheckoutOrderSummary
              formattedTotal={props.formattedTotal}
              hasMixedPreOrder={props.hasMixedPreOrder}
              localCart={props.localCart}
              pageLoading={props.pageLoading}
              promoExpanded={props.promoExpanded}
              loyalty={props.loyalty}
              onRedeemToggle$={props.onRedeemToggle$}
              shippingCents={props.shippingCents}
            />
            <CheckoutPaymentPanel {...props} />
          </div>
        </div>
        {props.srState.phase !== 'paying' && <CheckoutMobileCta {...props} />}
      </div>
    )}
  </div>
  );
});
