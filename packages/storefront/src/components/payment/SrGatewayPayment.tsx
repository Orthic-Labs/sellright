import { $, component$, QRL, useSignal, useVisibleTask$, noSerialize, type NoSerialize } from '@qwik.dev/core';
import { loadCollectJs, prepareCardTokenization } from '~/services/NmiCollect';
import { srGatewayPayment, srVerifyGatewayPayment, srErrorBody } from '~/utils/sellright';
import { useCheckoutValidationActions } from '~/contexts/CheckoutValidationContext';
import { AcceptedCards } from './AcceptedCards';

/**
 * SellRight gateway payment panel — NMI (Collect.js tokenize →
 * POST gateway-payment) and Sezzle (POST gateway-payment → hosted redirect).
 * Sits behind SR_CHECKOUT_ENABLED like StripePaymentElement does: the order
 * already exists in PendingPayment when this mounts (phase 'paying').
 *
 * The retired Vendure NMI/Sezzle components are untouched for the dormant
 * path. One deliberate behaviour change on the live path: card details are
 * tokenized by Collect.js iframes — raw PAN never reaches this app or the
 * API (payment_token is the only supported input upstream).
 */

interface SrGatewayPaymentProps {
  orderCode: string;
  receiptToken?: string;
  nmi: { tokenizationKey: string; mode: 'test' | 'live'; environment?: 'sandbox' | 'production' } | null;
  sezzle: boolean;
  formattedTotal?: string | null;
  onForward$: QRL<(orderCode: string) => void>;
  onError$: QRL<(errorMessage: string) => void>;
  onProcessingChange$?: QRL<(isProcessing: boolean) => void>;
}

type Method = 'nmi' | 'sezzle';

export default component$<SrGatewayPaymentProps>((props) => {
  const method = useSignal<Method>(props.nmi ? 'nmi' : 'sezzle');
  const isProcessing = useSignal(false);
  const error = useSignal('');
  const collectReady = useSignal(false);
  const tokenize = useSignal<NoSerialize<() => Promise<string>>>();
  const paymentToken = useSignal<string>();
  const validationActions = useCheckoutValidationActions();

  // One idempotency key per shopper payment attempt. Rotated ONLY after a
  // terminal decline/failure (a fresh attempt must not collide with the old
  // key); 'unknown' retries deliberately reuse the key so the server replays
  // the same attempt rather than double-charging.
  const idemKey = useSignal(`sr-gw-${props.orderCode}-${Math.random().toString(36).slice(2)}`);

  const fieldIds = { ccnumber: 'sr-nmi-ccnumber', ccexp: 'sr-nmi-ccexp', cvv: 'sr-nmi-cvv' };

  // Payment section is "valid" the way Sezzle was: real validation happens at
  // tokenize/charge time (Collect.js field validation + gateway response).
  useVisibleTask$(() => {
    validationActions.updatePaymentValidation(true, {}, true);
  });

  // Load Collect.js as soon as the NMI tab is active — warm, so PAY is instant.
  useVisibleTask$(async ({ track, cleanup }) => {
    const active = track(() => method.value);
    let disposed = false;
    cleanup(() => { disposed = true; });
    collectReady.value = false;
    tokenize.value = undefined;
    if (active !== 'nmi' || !props.nmi) return;
    try {
      const collect = await loadCollectJs(props.nmi.tokenizationKey, props.nmi.mode, undefined, props.nmi.environment);
      if (disposed) return;
      tokenize.value = noSerialize(prepareCardTokenization(collect, {
        ccnumber: `#${fieldIds.ccnumber}`, ccexp: `#${fieldIds.ccexp}`, cvv: `#${fieldIds.cvv}`,
      }, () => { if (!disposed) collectReady.value = true; }));
    } catch {
      error.value = 'Card payment could not be initialised — please refresh and try again.';
    }
  });

  const chargeNmi = $(async () => {
    if (isProcessing.value || !props.nmi || !tokenize.value || !collectReady.value) return;
    error.value = '';
    isProcessing.value = true;
    if (props.onProcessingChange$) await props.onProcessingChange$(true);
    try {
      // Keep the exact payload on an ambiguous retry; a fresh token changes its fingerprint.
      const token = paymentToken.value ?? await tokenize.value();
      paymentToken.value = token;
      const attempt = await srGatewayPayment(
        props.orderCode,
        { method: 'nmi', token },
        { idempotencyKey: idemKey.value, receiptToken: props.receiptToken },
      );
      if (attempt.status === 'settled') {
        await props.onForward$(props.orderCode);
        return;
      }
      if (attempt.status === 'unknown' || attempt.status === 'pending' || attempt.status === 'processing' || attempt.status === 'authorized') {
        // Outcome unclear — reconcile with the provider before retrying.
        const verify = await srVerifyGatewayPayment(props.orderCode, attempt.attemptId, { receiptToken: props.receiptToken });
        if (verify.status === 'settled') { await props.onForward$(props.orderCode); return; }
        throw new Error('Payment is still being confirmed — check your orders before trying again.');
      }
      // declined / failed — rotate the key so a retry is a NEW attempt.
      idemKey.value = `sr-gw-${props.orderCode}-${Math.random().toString(36).slice(2)}`;
      paymentToken.value = undefined;
      throw new Error(attempt.status === 'declined' ? 'Payment declined — check your card or try another method.' : 'Payment could not be processed — please try again.');
    } catch (err) {
      const body = srErrorBody<{ error?: string }>(err);
      error.value = body?.error ?? (err instanceof Error ? err.message : 'Payment failed — please try again.');
      await props.onError$(error.value);
    } finally {
      isProcessing.value = false;
      if (props.onProcessingChange$) await props.onProcessingChange$(false);
    }
  });

  const continueSezzle = $(async () => {
    if (isProcessing.value) return;
    error.value = '';
    isProcessing.value = true;
    let redirecting = false;
    if (props.onProcessingChange$) await props.onProcessingChange$(true);
    try {
      const attempt = await srGatewayPayment(
        props.orderCode,
        { method: 'sezzle' },
        { idempotencyKey: idemKey.value, receiptToken: props.receiptToken },
      );
      if (attempt.checkoutUrl) {
        // Redirect initiated — do NOT clear isProcessing (the page is unloading;
        // a state flip here can re-render into a half-torn-down checkout).
        redirecting = true;
        window.location.href = attempt.checkoutUrl;
        return;
      }
      throw new Error('Sezzle checkout could not be started — please try again.');
    } catch (err) {
      const body = srErrorBody<{ error?: string }>(err);
      error.value = body?.error ?? (err instanceof Error ? err.message : 'Sezzle checkout failed — please try again.');
      await props.onError$(error.value);
    } finally {
      if (!redirecting) {
        isProcessing.value = false;
        if (props.onProcessingChange$) await props.onProcessingChange$(false);
      }
    }
  });

  const showNmi = !!props.nmi;
  const showSezzle = props.sezzle;

  return (
    <div class="w-full">
      {(showNmi && showSezzle) && (
        <div class="flex gap-2 mb-4">
          <button
            type="button"
            onClick$={() => { method.value = 'nmi'; }}
            class={`flex-1 py-2 rounded border text-sm ${method.value === 'nmi' ? 'border-[var(--color-accent)] text-[#FDFAF6]' : 'border-[rgba(140,107,58,0.18)] text-[rgba(100,85,65,0.6)]'}`}
          >Card</button>
          <button
            type="button"
            onClick$={() => { method.value = 'sezzle'; }}
            class={`flex-1 py-2 rounded border text-sm ${method.value === 'sezzle' ? 'border-[var(--color-accent)] text-[#FDFAF6]' : 'border-[rgba(140,107,58,0.18)] text-[rgba(100,85,65,0.6)]'}`}
          >Sezzle</button>
        </div>
      )}

      {method.value === 'nmi' && showNmi && (
        <div>
          <AcceptedCards />
          <div class="grid grid-cols-4 gap-4 w-full mb-2">
            <div class="col-span-2">
              <div id={fieldIds.ccnumber} style={{ height: '44px' }} class="block w-full rounded-[3px] border border-[rgba(140,107,58,0.18)] bg-white" />
            </div>
            <div class="col-span-1">
              <div id={fieldIds.ccexp} style={{ height: '44px' }} class="block w-full rounded-[3px] border border-[rgba(140,107,58,0.18)] bg-white" />
            </div>
            <div class="col-span-1">
              <div id={fieldIds.cvv} style={{ height: '44px' }} class="block w-full rounded-[3px] border border-[rgba(140,107,58,0.18)] bg-white" />
            </div>
          </div>
          <button
            type="button"
            onClick$={chargeNmi}
            disabled={isProcessing.value || !collectReady.value}
            class="checkout-cta"
          >
            {isProcessing.value ? 'Processing...' : (props.formattedTotal ? `PAY — ${props.formattedTotal}` : 'PAY')}
          </button>
        </div>
      )}

      {method.value === 'sezzle' && showSezzle && (
        <div class="flex flex-col items-center gap-3 py-4">
          {/* eslint-disable-next-line qwik/jsx-img */}
          <img src="/sezzle-color.svg" alt="Sezzle" width="100" height="28" />
          <p class="text-sm text-[rgba(100,85,65,0.7)] text-center">4 interest-free payments. You'll finish on Sezzle's secure page.</p>
          <button
            type="button"
            onClick$={continueSezzle}
            disabled={isProcessing.value}
            class="checkout-cta"
          >
            {isProcessing.value ? 'Processing...' : 'Continue with Sezzle'}
          </button>
        </div>
      )}

      {error.value && <div class="text-red-600 text-sm mt-3" role="alert">{error.value}</div>}
    </div>
  );
});
