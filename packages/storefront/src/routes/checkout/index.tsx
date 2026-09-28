import { $, component$, useContext, useStore, useStyles$, useTask$, useVisibleTask$, useSignal, useComputed$ } from '@qwik.dev/core';
import {
  useNavigate,
  type DocumentHead
} from '@qwik.dev/router';
import { theme } from '~/theme/theme.config';
import { APP_STATE, COUNTRY_COOKIE } from '~/constants';
import { getCookie } from '~/utils';
import { getMe, getAddresses } from '~/services/customer';
import { CountryService } from '~/services/CountryService';
import { CheckoutAddressProvider } from '~/contexts/CheckoutAddressContext';
import { createSEOHead } from '~/utils/seo';
import { useCart, refreshCartStock, loadCartIfNeeded, useHasMixedPreOrder } from '~/contexts/CartContext';
import { CartService } from '~/services/CartService';
import { CheckoutValidationProvider, useCheckoutValidation, useCheckoutValidationActions } from '~/contexts/CheckoutValidationContext';
import { useCheckout, type PaymentMethod } from '~/hooks/useCheckout';
import { getShopConfig, getEligibleShippingMethods } from '~/providers/shop/checkout/checkout';
import type { ShopConfig, ShopShippingMethod } from '~/sellright/types/checkout';
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
  const localCart = useCart();
  const hasMixedPreOrder = useHasMixedPreOrder();
  const checkoutValidation = useCheckoutValidation();
  const validationActions = useCheckoutValidationActions();
  const { checkoutState, state: srState, placeOrder: placeOrderNative } = useCheckout();

  const state = useStore<CheckoutState>({
    loading: false,
    error: '',
  });

  const stripePublishableKey = useSignal<string>('');
  const stripeConfirmTrigger = useSignal(0);
  // Which payment method the shopper has selected — defaults once shopConfig
  // resolves (see the useTask$ below): stripe > nmi > sezzle, whichever the
  // store actually has configured. gatewayConfirmTrigger is the NMI
  // equivalent of stripeConfirmTrigger; gatewayIdempotencyKey is minted once
  // per placeOrder() attempt and reused by the NMI/Sezzle components so a
  // retried gateway call (not a retried checkout) replays instead of
  // double-charging.
  const paymentMethod = useSignal<PaymentMethod>('stripe');
  const gatewayConfirmTrigger = useSignal(0);
  const gatewayIdempotencyKey = useSignal('');
  const pageLoading = useSignal(true);
  const promoExpanded = useSignal(false);
  // Loyalty points to spend on this order (0 = none) — set by LoyaltyRedeem,
  // re-validated server-side at order creation.
  const redeemPoints = useSignal(0);

  const isCartEmpty = useSignal(true);

  const isOrderProcessing = useSignal(false);
  const showProcessingModal = useSignal(false);

  // Server-authoritative shipping quote (cents). `null` = not yet known — the
  // server hasn't been asked (no destination country yet) or the request is
  // in flight. Never fall back to a client-guessed rate here: whatever the
  // server returns is what the order will actually be charged.
  const shippingCents = useSignal<number | null>(null);
  // The method the checkout submits — server-authoritative selection (cheapest
  // eligible, matching the displayed rate). POST /checkout 409s
  // 'method_required' for physical carts when this is absent.
  const shippingMethod = useSignal<ShopShippingMethod | null>(null);
  // Public runtime config — decides whether the Stripe Payment Element mounts
  // once the order reaches PendingPayment.
  const shopConfig = useSignal<ShopConfig | null>(null);

  useTask$(async ({ track, cleanup }) => {
    const countryCode = track(() => appState.shippingAddress?.countryCode);
    const subtotal = track(() => localCart.cart.subtotal || 0);
    const discount = track(() => localCart.cart.discountTotal || 0);

    if (!countryCode) {
      shippingCents.value = null;
      shippingMethod.value = null;
      return;
    }

    const discountedSubtotal = Math.max(subtotal - discount, 0);
    let cancelled = false;
    cleanup(() => { cancelled = true; });

    try {
      // Both the raw and post-coupon subtotal are sent so a threshold rule
      // keyed on the discounted basis (e.g. a coupon-driven free-shipping
      // tier) is decided server-side — never guessed by zeroing the rate here.
      const methods = await getEligibleShippingMethods(countryCode, subtotal, discountedSubtotal);
      if (cancelled) return;
      if (!methods.length) {
        shippingCents.value = null;
        shippingMethod.value = null;
        return;
      }
      // Cheapest eligible — the displayed rate and the submitted method must
      // be the same server-priced choice.
      const cheapest = methods.reduce((a, b) => (b.rate < a.rate ? b : a));
      shippingMethod.value = cheapest;
      shippingCents.value = cheapest.rate;
    } catch (e) {
      if (cancelled) return;
      console.warn('[Checkout] Failed to fetch server shipping quote:', e);
      shippingCents.value = null;
      shippingMethod.value = null;
    }
  });

  const checkoutTotalCents = useComputed$(() => {
    const subtotal = localCart.cart.subtotal || 0;
    const discount = localCart.cart.discountTotal || 0;
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

        // Public runtime config decides whether the Stripe Payment Element
        // mounts once the order reaches PendingPayment.
        getShopConfig()
          .then((cfg) => {
            shopConfig.value = cfg;
            if (cfg.stripePublishableKey) stripePublishableKey.value = cfg.stripePublishableKey;
            // Default selection: prefer whichever method the store actually
            // has configured, in this priority order. The shopper can still
            // switch via the method selector when more than one is available.
            if (cfg.stripeConfigured) paymentMethod.value = 'stripe';
            else if (cfg.gateways?.nmi) paymentMethod.value = 'nmi';
            else if (cfg.gateways?.sezzle) paymentMethod.value = 'sezzle';
          })
          .catch((e) => console.warn('[Checkout] shop-config fetch failed:', e));

        const [customerData, countriesData] = await Promise.all([
          getMe().catch(() => null),
          CountryService.getAvailableCountries().catch(() => []),
        ]);

        if (countriesData && countriesData.length > 0) {
          appState.availableCountries = countriesData;
        }

        if (customerData) {
          // appState.customer's field names are the CheckoutAddresses form
          // state's own shape (title/emailAddress/phoneNumber), not the native
          // AuthCustomer wire shape (email/phone, no title) — map explicitly
          // rather than reshaping appState, which other checkout components
          // still bind by these names.
          appState.customer = {
            title: '',
            firstName: customerData.firstName ?? '',
            id: customerData.id,
            lastName: customerData.lastName ?? '',
            emailAddress: customerData.email,
            phoneNumber: customerData.phone ?? '',
          };

          try {
            const addresses = await getAddresses();
            const defaultShipping = addresses.find((a) => a.isDefaultShipping);
            if (defaultShipping) {
              appState.shippingAddress = {
                ...appState.shippingAddress,
                streetLine1: defaultShipping.line1 || '',
                streetLine2: defaultShipping.line2 || '',
                city: defaultShipping.city || '',
                province: defaultShipping.province || '',
                postalCode: defaultShipping.postalCode || '',
                countryCode: defaultShipping.country || appState.shippingAddress.countryCode || '',
                phoneNumber: defaultShipping.phone || customerData.phone || '',
              };
            }
          } catch (e) {
            console.warn('[Checkout] Failed to load customer addresses:', e);
          }
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

        isCartEmpty.value = localCart.cart.lines.length === 0;

        if (localCart.cart.lines.length > 0) {
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
    track(() => localCart.cart.lines);

    isCartEmpty.value = localCart.cart.lines.length === 0;

    if (localCart.cart.lines.length > 0) {
        const stockValidation = CartService.validateStock();
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

      const items = localCart.cart.lines
        .map((line) => ({ sku: line.sku, quantity: line.quantity }))
        .filter((i) => i.sku && i.quantity > 0);
      if (!items.length) throw new Error('Your cart is empty.');
      const sa: any = appState.shippingAddress || {};
      // Native field names (line1/country) going out — appState itself stays
      // in the CheckoutAddresses form shape (streetLine1/countryCode); this is
      // just the outgoing request body.
      const shippingAddress = {
        fullName: `${appState.customer?.firstName || ''} ${appState.customer?.lastName || ''}`.trim(),
        line1: sa.streetLine1, line2: sa.streetLine2, city: sa.city,
        province: sa.province, postalCode: sa.postalCode, country: sa.countryCode, phone: sa.phoneNumber,
      };
      const ba: any = appState.billingAddress || {};
      const billingAddress = checkoutValidation.useDifferentBilling
        ? {
            fullName: `${ba.firstName || ''} ${ba.lastName || ''}`.trim(),
            line1: ba.streetLine1, line2: ba.streetLine2, city: ba.city,
            province: ba.province, postalCode: ba.postalCode, country: ba.countryCode,
          }
        : undefined;

      const form = {
        items,
        email: appState.customer?.emailAddress || undefined,
        shippingAddress,
        shippingMethodCode: shippingMethod.value?.code,
        billingAddress,
        couponCode: localCart.cart.coupon?.applied ? localCart.cart.coupon.code : undefined,
        redeemPoints: redeemPoints.value > 0 ? redeemPoints.value : undefined,
      };
      gatewayIdempotencyKey.value = crypto.randomUUID();
      const phase = await placeOrderNative(form, paymentMethod.value);
      if (phase === 'paid') {
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
          document.getElementById('payment-method-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 80);
        return;
      }
      throw new Error(srState.error || 'Checkout failed. Please try again.');
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'An unknown error occurred. Please check your information and try again.';
      showProcessingModal.value = false;
      isOrderProcessing.value = false;
    }
  });

  const onPaymentError$ = $(async (_errorMessage: string) => {
    await recoverCheckoutPaymentError({
      isOrderProcessing,
      navigate,
      showProcessingModal,
      state,
      order: srState.code ? { code: srState.code, receiptToken: srState.receiptToken } : undefined,
    });
  });

  const onPaymentProcessingChange$ = $(async (isProcessing: boolean) => {
    state.loading = isProcessing;
    isOrderProcessing.value = isProcessing;
  });

  // NMI charges synchronously (no redirect) — on a settled attempt, navigate
  // straight to confirmation the same way the zero-due 'paid' phase does.
  const onGatewaySuccess$ = $(async () => {
    isOrderProcessing.value = false;
    const rt = srState.receiptToken ? `?rt=${encodeURIComponent(srState.receiptToken)}` : '';
    navigate(`/checkout/confirmation/${srState.code}${rt}`);
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
      gatewayConfirmTrigger={gatewayConfirmTrigger}
      gatewayIdempotencyKey={gatewayIdempotencyKey}
      onGatewaySuccess$={onGatewaySuccess$}
      onPaymentError$={onPaymentError$}
      onPaymentProcessingChange$={onPaymentProcessingChange$}
      onPlaceOrder$={placeOrder}
      pageLoading={pageLoading}
      paymentMethod={paymentMethod}
      promoExpanded={promoExpanded}
      redeemPoints={redeemPoints}
      shippingCents={shippingCents}
      showProcessingModal={showProcessingModal}
      shopConfig={shopConfig}
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
    description: `Complete your purchase at ${theme.storeName}.`,
    noindex: true,
    links: []
  });
};
