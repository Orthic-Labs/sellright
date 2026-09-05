import { $, useStore } from '@qwik.dev/core';
import { useLocalCart } from '~/contexts/CartContext';
import { LocalCartService } from '~/services/LocalCartService';
import { convertLocalCartToVendureOrder as _convertLocalCartToVendureOrder } from '~/contexts/CartContext';
import {
  placeOrder as srPlaceOrder,
  createPaymentIntent as srCreatePI,
  type SrCheckoutForm,
} from '~/providers/shop/checkout/checkout';

/**
 * @description
 * Checkout flow hook. The legacy Vendure path
 * (`convertLocalCartToVendureOrder`) is preserved behind the explicit fallback;
 * the SellRight + Stripe path (behind VITE_SR_CHECKOUT) is the new state machine.
 *
 * SR flow (state machine):
 *   idle → placing (POST /checkout) → either
 *     - paid       (server already settled a zero-due/gift-card-covered order), or
 *     - paying     (PaymentIntent client_secret → Stripe Payment Element confirm)
 *   → confirming (Stripe redirect to /checkout/confirmation/{code}?rt=…)
 *   any step → error (recoverable; order stays PendingPayment)
 */
export type SrCheckoutPhase = 'idle' | 'placing' | 'paid' | 'paying' | 'error';

export const useCheckout = () => {
  const cartState = useLocalCart();

  const checkoutState = useStore({
    isLoading: false,
    error: null as string | null,
  });

  // SR/Stripe state machine.
  const srState = useStore({
    phase: 'idle' as SrCheckoutPhase,
    code: '' as string,
    receiptToken: '' as string,
    clientSecret: '' as string,
    grandTotal: 0,
    error: null as string | null,
  });

  /**
   * Legacy Vendure path — converts the local cart to a Vendure order.
   * Does NOT clear the cart items.
   */
  const convertLocalCartToVendureOrder = $(async () => {
    checkoutState.isLoading = true;
    checkoutState.error = null;

    try {
      const stockValidation = LocalCartService.validateStock();
      if (!stockValidation.valid) {
        throw new Error(`Stock validation failed: ${stockValidation.errors.join(', ')}`);
      }

      const order = await _convertLocalCartToVendureOrder(cartState);

      if (order) {
        return order;
      } else {
        throw new Error('Failed to create Vendure order from the cart.');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An unknown checkout error occurred.';
      checkoutState.error = errorMessage;
      console.error('❌ useCheckout: Failed to convert cart:', error);
      return null;
    } finally {
      checkoutState.isLoading = false;
    }
  });

  /**
   * SR/Stripe path — create the order, then resolve either the already-paid
   * short-circuit OR a Stripe PaymentIntent. A zero-total order is only treated
   * as paid when the server says Paid; the client must never invent settlement.
   */
  const placeOrderStripe = $(async (form: SrCheckoutForm): Promise<SrCheckoutPhase> => {
    srState.phase = 'placing';
    srState.error = null;
    checkoutState.isLoading = true;
    try {
      const created = await srPlaceOrder(form);
      srState.code = created.code;
      srState.receiptToken = created.receiptToken ?? '';
      srState.grandTotal = created.grandTotal;

      if (created.state === 'Paid') {
        srState.phase = 'paid';
        return 'paid';
      }

      // Never let the browser reinterpret PendingPayment as Paid merely because
      // the displayed total is zero. That previously swallowed a failed manual
      // payment call and navigated to confirmation while the ledger stayed open.
      if (created.grandTotal === 0) {
        throw new Error('The order has no amount due but was not settled by the server. Please retry checkout.');
      }

      // Card path — mint the PaymentIntent and hand the client_secret to the
      // Stripe Payment Element (mounted by the caller).
      const pi = await srCreatePI(created.code);
      if (!pi.clientSecret) throw new Error('Could not start the payment.');
      srState.clientSecret = pi.clientSecret;
      srState.phase = 'paying';
      return 'paying';
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Checkout failed. Please try again.';
      srState.error = msg;
      checkoutState.error = msg;
      srState.phase = 'error';
      return 'error';
    } finally {
      checkoutState.isLoading = false;
    }
  });

  return {
    checkoutState,
    convertLocalCartToVendureOrder,
    // SR/Stripe
    srState,
    placeOrderStripe,
  };
};