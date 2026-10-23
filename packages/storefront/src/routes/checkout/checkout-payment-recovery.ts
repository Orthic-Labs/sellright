import type { Signal } from '@qwik.dev/core';
import { getOrder } from '~/providers/shop/checkout/checkout';
import { classifyOrderState } from '~/services/order-state';

interface RecoverCheckoutPaymentErrorOptions {
  isOrderProcessing: Signal<boolean>;
  navigate: (path: string) => void;
  showProcessingModal: Signal<boolean>;
  state: { error: string | null };
  /** The PendingPayment order the failed attempt was against. */
  order?: { code: string; receiptToken?: string };
  /** False once a newer view/generation (or the page being left) superseded this recovery: its result is dropped. */
  isCurrent?: () => boolean;
}

/**
 * A failed client call does not mean the charge failed — Stripe's own
 * network response can be lost on a slow connection while the payment
 * settles server-side regardless. Read the actual order state before telling
 * the shopper to retry; only reset the form for a genuinely payable order.
 */
export async function recoverCheckoutPaymentError(options: RecoverCheckoutPaymentErrorOptions): Promise<void> {
  const { isOrderProcessing, navigate, showProcessingModal, state, order, isCurrent = () => true } = options;

  if (order?.code) {
    try {
      const sr = await getOrder(order.code, order.receiptToken);
      if (!isCurrent()) return;
      if (sr?.state === 'Paid') {
        const rt = order.receiptToken ? `?rt=${encodeURIComponent(order.receiptToken)}` : '';
        navigate(`/checkout/confirmation/${encodeURIComponent(sr.code)}${rt}`);
        return;
      }
    } catch (e) {
      console.error('[Checkout] Order state check failed:', e);
    }
  }

  if (!isCurrent()) return;

  // Order still payable (or its state couldn't be confirmed) — reset and let
  // the shopper retry the payment.
  showProcessingModal.value = false;
  state.error = 'Please try a different card or payment method.';
  isOrderProcessing.value = false;
}

/** What the resume view must do after a payment attempt on the resumed order failed. */
export type ResumePaymentOutcome =
  /** The payment actually went through (the client call lost its response): go to the confirmation page. */
  | { kind: 'settled'; code: string; receiptToken: string }
  /** Still PendingPayment: keep the controls and show this message. */
  | { kind: 'payable'; message: string }
  /** Cancelled meanwhile: no controls; offer the cancelled-order recovery. */
  | { kind: 'cancelled' }
  /** Unknown state, or the state could not be read: no controls, a retryable error (a blind retry could double-pay). */
  | { kind: 'error'; message: string };

export const RESUME_PAYMENT_RETRY_MESSAGE = 'Please try a different card or payment method.';

/**
 * Resume counterpart of `recoverCheckoutPaymentError`. The shared handler only writes a form error and redirects for
 * Paid; the resume view has no such error line and must also react to Cancelled/unknown orders. Reads the order and
 * classifies it with the same `classifyOrderState` the resume stage uses.
 */
export async function classifyResumePaymentError(
  order: { code: string; receiptToken?: string },
  read: (code: string, receiptToken?: string) => Promise<{ state: string; code: string }> = getOrder,
): Promise<ResumePaymentOutcome> {
  let fresh: { state: string; code: string };
  try {
    fresh = await read(order.code, order.receiptToken || undefined);
    // An empty read (a reader that resolves null/undefined instead of throwing) is an unresolved status, never a state.
    if (!fresh || typeof fresh.state !== 'string') throw new Error('Empty order response');
  } catch (e) {
    console.error('[Checkout] Resume order state check failed:', e);
    return { kind: 'error', message: "We couldn't confirm your payment status. Please try again." };
  }
  switch (classifyOrderState(fresh.state)) {
    case 'settled':
      return { kind: 'settled', code: fresh.code || order.code, receiptToken: order.receiptToken ?? '' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'payable':
      return { kind: 'payable', message: RESUME_PAYMENT_RETRY_MESSAGE };
    default:
      return { kind: 'error', message: "This order can't be paid right now. Please contact support." };
  }
}
