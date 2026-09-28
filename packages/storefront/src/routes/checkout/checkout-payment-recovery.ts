import type { Signal } from '@qwik.dev/core';
import { getOrder } from '~/providers/shop/checkout/checkout';

interface RecoverCheckoutPaymentErrorOptions {
  isOrderProcessing: Signal<boolean>;
  navigate: (path: string) => void;
  showProcessingModal: Signal<boolean>;
  state: { error: string | null };
  /** The PendingPayment order the failed attempt was against. */
  order?: { code: string; receiptToken?: string };
}

/**
 * A failed client call does not mean the charge failed — Stripe's own
 * network response can be lost on a slow connection while the payment
 * settles server-side regardless. Read the actual order state before telling
 * the shopper to retry; only reset the form for a genuinely payable order.
 */
export async function recoverCheckoutPaymentError(options: RecoverCheckoutPaymentErrorOptions): Promise<void> {
  const { isOrderProcessing, navigate, showProcessingModal, state, order } = options;

  if (order?.code) {
    try {
      const sr = await getOrder(order.code, order.receiptToken);
      if (sr.state === 'Paid') {
        const rt = order.receiptToken ? `?rt=${encodeURIComponent(order.receiptToken)}` : '';
        navigate(`/checkout/confirmation/${sr.code}${rt}`);
        return;
      }
    } catch (e) {
      console.error('[Checkout] Order state check failed:', e);
    }
  }

  // Order still payable (or its state couldn't be confirmed) — reset and let
  // the shopper retry the payment.
  showProcessingModal.value = false;
  state.error = 'Please try a different card or payment method.';
  isOrderProcessing.value = false;
}
