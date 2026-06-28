import type { Signal } from '@qwik.dev/core';
import { getActiveOrderQuery } from '~/providers/shop/orders/order';
import { transitionOrderToStateMutation } from '~/providers/shop/checkout/checkout';
import { LocalCartService } from '~/services/LocalCartService';

interface RecoverCheckoutPaymentErrorOptions {
  appState: any;
  isOrderProcessing: Signal<boolean>;
  navigate: (path: string) => void;
  nmiTriggerSignal: Signal<number>;
  paymentComplete: Signal<boolean>;
  sezzleTriggerSignal: Signal<number>;
  showProcessingModal: Signal<boolean>;
  state: { error: string | null };
}

export async function recoverCheckoutPaymentError(options: RecoverCheckoutPaymentErrorOptions): Promise<void> {
  const {
    appState,
    isOrderProcessing,
    navigate,
    nmiTriggerSignal,
    paymentComplete,
    sezzleTriggerSignal,
    showProcessingModal,
    state,
  } = options;

  try {
    const latestOrder = await getActiveOrderQuery();
    console.log('[Checkout] Payment error callback triggered. Current order state:', latestOrder?.state);

    if (latestOrder?.state === 'PaymentAuthorized' || latestOrder?.state === 'PaymentSettled' || latestOrder?.state === 'Settled') {
      console.log('[Checkout] Order actually succeeded despite error callback. Redirecting to confirmation...');
      paymentComplete.value = true;
      navigate(`/checkout/confirmation/${latestOrder.code}`);
      return;
    }

    if (!latestOrder) {
      console.log('[Checkout] No active order found in error handler. Checking for completed order...');
      if (appState.activeOrder?.code) {
        console.log('[Checkout] Redirecting to confirmation page for order:', appState.activeOrder.code);
        paymentComplete.value = true;
        navigate(`/checkout/confirmation/${appState.activeOrder.code}`);
        return;
      }
    }
  } catch (e) {
    console.error('[Checkout] Failed to verify order state in error handler:', e);
  }

  showProcessingModal.value = false;
  state.error = 'Please try a different card or payment method.';
  isOrderProcessing.value = false;
  nmiTriggerSignal.value = 0;
  sezzleTriggerSignal.value = 0;

  try {
    const currentCart = LocalCartService.getCart();
    if (currentCart.items.length > 0 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('cart-updated', {
        detail: { totalQuantity: currentCart.totalQuantity }
      }));
    }
  } catch (cartError) {
    console.error('[Checkout] Error checking cart state after payment failure:', cartError);
  }

  try {
    const currentOrder = await getActiveOrderQuery();
    if (currentOrder && currentOrder.state !== 'AddingItems') {
      const tr = await transitionOrderToStateMutation('AddingItems');
      const tResult = tr.transitionOrderToState;
      if (tResult && 'state' in tResult) {
        appState.activeOrder = tResult as any;
      }
    } else if (currentOrder) {
      appState.activeOrder = currentOrder as any;
    }
  } catch (transitionError) {
    console.error('[Checkout] Failed to transition order back to AddingItems state:', transitionError);
  }
}
