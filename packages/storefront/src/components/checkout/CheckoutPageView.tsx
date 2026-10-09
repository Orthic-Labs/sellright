import { $, component$, type QRL, type Signal } from '@qwik.dev/core';
import { OrderProcessingModal } from '~/components/OrderProcessingModal';
import { CheckoutEmptyCart } from './CheckoutEmptyCart';
import { CheckoutMobileCta } from './CheckoutCta';
import { CheckoutOrderSummary } from './CheckoutOrderSummary';
import { CheckoutPaymentPanel } from './CheckoutPaymentPanel';
import type { ShopConfig } from '~/sellright/types/checkout';
import type { CheckoutPhase, PaymentMethod } from '~/hooks/useCheckout';

interface CheckoutPageViewProps {
  checkoutState: any;
  checkoutValidation: any;
  formattedTotal: Signal<string | null>;
  gatewayConfirmTrigger: Signal<number>;
  totalConfirmed: Signal<boolean>;
  hasMixedPreOrder: { value: boolean };
  shopConfig: Signal<ShopConfig | null>;
  isCartEmpty: Signal<boolean>;
  isOrderProcessing: Signal<boolean>;
  localCart: any;
  onGatewaySuccess$: QRL<() => void>;
  onPaymentError$: QRL<(message: string) => void>;
  onPaymentProcessingChange$: QRL<(processing: boolean) => void>;
  onPlaceOrder$: QRL<() => void>;
  pageLoading: Signal<boolean>;
  paymentMethod: Signal<PaymentMethod>;
  promoExpanded: Signal<boolean>;
  redeemPoints: Signal<number>;
  shippingCents: Signal<number | null>;
  showProcessingModal: Signal<boolean>;
  srState: { phase: CheckoutPhase; code: string; receiptToken: string; clientSecret: string; grandTotal: number; shownTotal: number };
  state: { loading: boolean; error: string | null };
  stripeConfirmTrigger: Signal<number>;
  stripePublishableKey: Signal<string>;
}

export const CheckoutPageView = component$<CheckoutPageViewProps>((props) => (
  <div class="checkout-layout">
    {!props.pageLoading.value && props.isCartEmpty.value ? (
      <CheckoutEmptyCart />
    ) : (
      <div class="min-h-screen">
        <OrderProcessingModal
          visible={props.showProcessingModal.value}
          onClose$={$(() => {
            props.showProcessingModal.value = false;
            props.isOrderProcessing.value = false;
          })}
        />
        <div class="max-w-7xl mx-auto pt-5 pb-10 sm:px-6 lg:px-8">
          <div class="checkout-columns lg:flex lg:gap-x-8 xl:gap-x-12">
            <CheckoutOrderSummary
              formattedTotal={props.formattedTotal}
              hasMixedPreOrder={props.hasMixedPreOrder}
              localCart={props.localCart}
              pageLoading={props.pageLoading}
              promoExpanded={props.promoExpanded}
              redeemPoints={props.redeemPoints}
              shippingCents={props.shippingCents}
            />
            <CheckoutPaymentPanel {...props} />
          </div>
        </div>
        <CheckoutMobileCta {...props} />
      </div>
    )}
  </div>
));
