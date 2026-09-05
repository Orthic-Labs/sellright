import { $, component$, useContext, useStore, useStyles$, useTask$, useVisibleTask$, useSignal, useComputed$ } from '@qwik.dev/core';
import {
  useNavigate,
  type DocumentHead
} from '@qwik.dev/router';
import { APP_STATE, COUNTRY_COOKIE } from '~/constants';
import { getCookie } from '~/utils';
import { getActiveOrderQuery } from '~/providers/shop/orders/order';
import { getActiveCustomerQuery, getActiveCustomerAddressesQuery } from '~/providers/shop/customer/customer';
import { CountryService } from '~/services/CountryService';
import { CheckoutAddressProvider } from '~/contexts/CheckoutAddressContext';
import { createSEOHead } from '~/utils/seo';
import { useLocalCart, refreshCartStock, loadCartIfNeeded, useHasMixedPreOrder } from '~/contexts/CartContext';
import { CheckoutValidationProvider, useCheckoutValidation, useCheckoutValidationActions } from '~/contexts/CheckoutValidationContext';
import { useCheckout } from '~/hooks/useCheckout';
import { SR_CHECKOUT_ENABLED } from '~/providers/shop/checkout/checkout';
import { srStripePublishableKey, srShippingMethods } from '~/utils/sellright';
import { LocalCartService } from '~/services/LocalCartService';
import { validateBillingSection, validateCustomerSection, validateShippingSection } from '~/utils/checkout-section-validation';
import { CheckoutPageView } from '~/components/checkout/CheckoutPageView';
import { CHECKOUT_STYLES } from './checkout-styles';
import { recoverCheckoutPaymentError } from './checkout-payment-recovery';


interface CheckoutState {
  loading: boolean;
  error: string | null;
}

const CheckoutContent = component$(() => {
  const navigate = useNavigate();
  const appState = useContext(APP_STATE);
  const localCart = useLocalCart();
  const hasMixedPreOrder = useHasMixedPreOrder();
  const checkoutValidation = useCheckoutValidation();
  const validationActions = useCheckoutValidationActions();
  const { checkoutState, convertLocalCartToVendureOrder, srState, placeOrderStripe } = useCheckout();

  const state = useStore<CheckoutState>({
    loading: false,
    error: '',
  });

  const nmiTriggerSignal = useSignal(0);
  const sezzleTriggerSignal = useSignal(0);
  const selectedPaymentMethod = useSignal<string>('nmi');

  const stripePublishableKey = useSignal<string>('');
  const stripeConfirmTrigger = useSignal(0);
  const pageLoading = useSignal(true);
  const paymentComplete = useSignal(false);
  const promoExpanded = useSignal(false);

  const isCartEmpty = useSignal(true);

  const isOrderProcessing = useSignal(false);
  const showProcessingModal = useSignal(false);

  // Server-authoritative shipping quote (cents). `null` = not yet known — the
  // server hasn't been asked (no destination country yet) or the request is
  // in flight. Never fall back to a client-guessed rate here: whatever the
  // server returns is what the order will actually be charged (FE-10).
  const shippingCents = useSignal<number | null>(null);

  useTask$(async ({ track, cleanup }) => {
    const countryCode = track(() => appState.shippingAddress?.countryCode);
    const subtotal = track(() => localCart.localCart.subTotal || 0);
    const discount = track(() => localCart.appliedCoupon?.discountAmount || 0);
    const freeShipping = track(() => !!localCart.appliedCoupon?.freeShipping);

    if (freeShipping) {
      shippingCents.value = 0;
      return;
    }

    if (!countryCode) {
      shippingCents.value = null;
      return;
    }

    const discountedSubtotal = Math.max(subtotal - discount, 0);
    let cancelled = false;
    cleanup(() => { cancelled = true; });

    try {
      const { methods } = await srShippingMethods(countryCode, discountedSubtotal);
      if (cancelled) return;
      if (!methods.length) {
        shippingCents.value = null;
        return;
      }
      shippingCents.value = Math.min(...methods.map((m) => m.rate));
    } catch (e) {
      if (cancelled) return;
      console.warn('[Checkout] Failed to fetch server shipping quote:', e);
      shippingCents.value = null;
    }
  });

  const checkoutTotalCents = useComputed$(() => {
    const subtotal = localCart.localCart.subTotal || 0;
    const discount = localCart.appliedCoupon?.discountAmount || 0;
    const discountedSubtotal = Math.max(subtotal - discount, 0);

    // Shipping unknown (no destination yet, or quote still loading/failed) —
    // don't guess. The displayed total reflects subtotal only until the
    // server-priced shipping quote resolves.
    const shipping = shippingCents.value ?? 0;

    return discountedSubtotal + shipping;
  });

  const formattedTotal = useComputed$(() => {
    const cents = checkoutTotalCents.value || 0;
    if (cents === 0) return null;
    return '$' + (cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  });

  useVisibleTask$(async () => {
    if (pageLoading.value) {
      try {
        appState.showCart = false;

        if (SR_CHECKOUT_ENABLED) {
          srStripePublishableKey()
            .then((r) => { if (r.publishableKey) stripePublishableKey.value = r.publishableKey; })
            .catch((e) => console.warn('[Checkout] stripe-key fetch failed:', e));
        }

        const [customerData, orderData, countriesData] = await Promise.all([
          getActiveCustomerQuery().catch(() => null),
          getActiveOrderQuery().catch(() => null),
          CountryService.getAvailableCountries().catch(() => []),
        ]);

        if (countriesData && countriesData.length > 0) {
          appState.availableCountries = countriesData;
        }

        if (customerData) {
          appState.customer = {
            title: customerData.title ?? '',
            firstName: customerData.firstName,
            id: customerData.id,
            lastName: customerData.lastName,
            emailAddress: customerData.emailAddress,
            phoneNumber: customerData.phoneNumber ?? '',
          };

          try {
            const addressData = await getActiveCustomerAddressesQuery();
            const defaultShipping = addressData?.addresses?.find((a: any) => a.defaultShippingAddress);
            if (defaultShipping) {
              appState.shippingAddress = {
                ...appState.shippingAddress,
                streetLine1: defaultShipping.streetLine1 || '',
                streetLine2: defaultShipping.streetLine2 || '',
                city: defaultShipping.city || '',
                province: defaultShipping.province || '',
                postalCode: defaultShipping.postalCode || '',
                countryCode: defaultShipping.country?.code || appState.shippingAddress.countryCode || '',
                phoneNumber: defaultShipping.phoneNumber || customerData.phoneNumber || '',
              };
            }
          } catch (e) {
            console.warn('[Checkout] Failed to load customer addresses:', e);
          }
        }

        if (orderData && orderData.id) {
          appState.activeOrder = orderData;
        }

        await loadCartIfNeeded(localCart);

        if (!appState.shippingAddress.countryCode) {
          const cookieCountry = getCookie(COUNTRY_COOKIE);
          if (cookieCountry) {
            appState.shippingAddress.countryCode = cookieCountry;
          } else {
            const storedCountry = sessionStorage.getItem('countryCode');
            if (storedCountry) {
              appState.shippingAddress.countryCode = storedCountry;
            }
          }
        }

        isCartEmpty.value = localCart.localCart.items.length === 0 &&
          (!appState.activeOrder || !appState.activeOrder.lines || appState.activeOrder.lines.length === 0);

        if (localCart.localCart.items.length > 0) {
          refreshCartStock(localCart).catch(error => {
            console.error('Checkout: Failed to refresh stock levels:', error);
          });
        }

      } catch (error) {
        console.error('[Checkout] Error during checkout initialization:', error);
        state.error = 'Failed to load checkout. Please try again.';
      } finally {
        pageLoading.value = false;
      }
    }
  });

  useTask$(async ({ track }) => {
    track(() => localCart.localCart.items);

    isCartEmpty.value = localCart.localCart.items.length === 0 &&
      (!appState.activeOrder || !appState.activeOrder.lines || appState.activeOrder.lines.length === 0);

    if (localCart.localCart.items.length > 0) {
        const stockValidation = LocalCartService.validateStock();
        validationActions.updateStockValidation(stockValidation.valid, stockValidation.errors);
    } else {
        validationActions.updateStockValidation(true, []);
    }
  });

  const paymentScrollMounted = useSignal(false);
  const paymentWasValid = useSignal(false);
  useVisibleTask$(({ track }) => {
    const valid = track(() => checkoutValidation.isCustomerValid && checkoutValidation.isShippingAddressValid);
    if (!paymentScrollMounted.value) {
      paymentScrollMounted.value = true;
      paymentWasValid.value = valid;
      return;
    }
    if (valid && !paymentWasValid.value) {
      paymentWasValid.value = true;
      setTimeout(() => {
        document.getElementById('checkout-payment-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 120);
    } else if (!valid && paymentWasValid.value) {
      paymentWasValid.value = false;
    }
  });

  const placeOrder = $(async () => {
    if (isOrderProcessing.value) return;
    if (state.loading || checkoutState.isLoading) return;

    if (!checkoutValidation.isAllValid) {
      await validationActions.touchAll();
      const missing: string[] = [];
      if (!checkoutValidation.isCustomerValid) missing.push('customer info');
      if (!checkoutValidation.isShippingAddressValid) missing.push('shipping address');
      if (checkoutValidation.useDifferentBilling && !checkoutValidation.isBillingAddressValid) missing.push('billing address');
      if (!checkoutValidation.isPaymentValid) missing.push('payment');
      if (!checkoutValidation.isStockValid) missing.push('stock availability');
      state.error = missing.length
        ? `Please complete: ${missing.join(', ')}`
        : 'Please complete all required fields';
      return;
    }

    showProcessingModal.value = true;
    isOrderProcessing.value = true;
    state.error = null;

    try {
      const customerSection = validateCustomerSection(
        {
          firstName: appState.customer?.firstName || '',
          lastName: appState.customer?.lastName || '',
          emailAddress: appState.customer?.emailAddress || '',
          phoneNumber: appState.shippingAddress?.phoneNumber || '',
        },
        appState.shippingAddress?.countryCode || 'US'
      );
      if (!customerSection.isValid) {
        throw new Error('Please complete all required customer information.');
      }

      const shippingSection = validateShippingSection(appState.shippingAddress);
      if (!shippingSection.isValid) {
        throw new Error('Please complete all required shipping address information.');
      }

      if (checkoutValidation.useDifferentBilling) {
        const billingSection = validateBillingSection(appState.billingAddress);
        if (!billingSection.isValid) {
          throw new Error('Please complete all required billing address information.');
        }
      }

      const items = (localCart.localCart.items || [])
        .map((it: any) => ({ sku: it.productVariantId as string, quantity: it.quantity as number }))
        .filter((i) => i.sku && i.quantity > 0);
      if (!items.length) throw new Error('Your cart is empty.');
      const sa: any = appState.shippingAddress || {};
      const shippingAddress = {
        fullName: `${appState.customer?.firstName || ''} ${appState.customer?.lastName || ''}`.trim(),
        streetLine1: sa.streetLine1, streetLine2: sa.streetLine2, city: sa.city,
        province: sa.province, postalCode: sa.postalCode, countryCode: sa.countryCode, phone: sa.phoneNumber,
      };

      if (SR_CHECKOUT_ENABLED) {
        const phase = await placeOrderStripe({
          items,
          email: appState.customer?.emailAddress || undefined,
          shippingAddress,
          billingAddress: checkoutValidation.useDifferentBilling ? (appState.billingAddress as any) : undefined,
        });
        if (phase === 'paid') {
          try { LocalCartService.clearCart(); } catch { /* ignore */ }
          showProcessingModal.value = false;
          isOrderProcessing.value = false;
          const rt = srState.receiptToken ? `?rt=${encodeURIComponent(srState.receiptToken)}` : '';
          navigate(`/checkout/confirmation/${srState.code}${rt}`);
          return;
        }
        if (phase === 'paying') {
          showProcessingModal.value = false;
          isOrderProcessing.value = false;
          state.error = null;
          setTimeout(() => {
            document.getElementById('stripe-payment-element-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 80);
          return;
        }
        throw new Error(srState.error || 'Checkout failed. Please try again.');
      }

      // Explicit legacy mode must stay on Vendure end-to-end. Creating a
      // SellRight order and then calling its public /pay endpoint with COD mixed
      // two payment state machines and, after offline tenders were hardened,
      // simply failed. Build the Vendure order, then trigger the selected legacy
      // NMI/Sezzle component against that active Vendure order.
      const legacyOrder = await convertLocalCartToVendureOrder();
      if (!legacyOrder) throw new Error('Failed to create the checkout order. Please try again.');
      showProcessingModal.value = false;
      if (selectedPaymentMethod.value === 'sezzle') {
        sezzleTriggerSignal.value += 1;
      } else {
        nmiTriggerSignal.value += 1;
      }
      return;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'An unknown error occurred. Please check your information and try again.';
      showProcessingModal.value = false;
      isOrderProcessing.value = false;
    }
  });

  const onPaymentForward$ = $(async (orderCode: string) => {
    paymentComplete.value = true;
    navigate(`/checkout/confirmation/${orderCode}`);
    state.loading = true;
  });

  const onPaymentError$ = $(async (_errorMessage: string) => {
    await recoverCheckoutPaymentError({
      appState,
      isOrderProcessing,
      navigate,
      nmiTriggerSignal,
      paymentComplete,
      sezzleTriggerSignal,
      showProcessingModal,
      state,
    });
  });

  const onPaymentProcessingChange$ = $(async (isProcessing: boolean) => {
    state.loading = isProcessing;
    isOrderProcessing.value = isProcessing;
  });

  const onStripeError$ = $(async (msg: string) => {
    state.error = msg;
    isOrderProcessing.value = false;
    state.loading = false;
  });

  const onStripeProcessingChange$ = $(async (processing: boolean) => {
    state.loading = processing;
    isOrderProcessing.value = processing;
  });

  return (
    <CheckoutPageView
      checkoutState={checkoutState}
      checkoutValidation={checkoutValidation}
      formattedTotal={formattedTotal}
      hasMixedPreOrder={hasMixedPreOrder}
      isCartEmpty={isCartEmpty}
      isOrderProcessing={isOrderProcessing}
      localCart={localCart}
      nmiTriggerSignal={nmiTriggerSignal}
      onPaymentError$={onPaymentError$}
      onPaymentForward$={onPaymentForward$}
      onPaymentProcessingChange$={onPaymentProcessingChange$}
      onPlaceOrder$={placeOrder}
      onStripeError$={onStripeError$}
      onStripeProcessingChange$={onStripeProcessingChange$}
      pageLoading={pageLoading}
      promoExpanded={promoExpanded}
      selectedPaymentMethod={selectedPaymentMethod}
      sezzleTriggerSignal={sezzleTriggerSignal}
      shippingCents={shippingCents}
      showProcessingModal={showProcessingModal}
      srState={srState}
      state={state}
      stripeConfirmTrigger={stripeConfirmTrigger}
      stripePublishableKey={stripePublishableKey}
    />

  );
});

export default component$(() => {
  useStyles$(CHECKOUT_STYLES);
  return (
    <CheckoutValidationProvider>
      <CheckoutAddressProvider>
        <CheckoutContent />
      </CheckoutAddressProvider>
    </CheckoutValidationProvider>
  );
});

export const head = (): DocumentHead => {
  return createSEOHead({
    title: 'Checkout',
    description: 'Complete your purchase at Damned Designs.',
    noindex: true,
    links: []
  });
};