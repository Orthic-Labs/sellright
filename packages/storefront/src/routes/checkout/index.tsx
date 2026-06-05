import { $, component$, useContext, useStore, useStyles$, useTask$, useVisibleTask$, useSignal, useComputed$ } from '@qwik.dev/core';
import {
  useNavigate,
  Link,
  type DocumentHead
} from '@qwik.dev/router';
import CartContents from '~/components/cart-contents/CartContents';
import CartTotals from '~/components/cart-totals/CartTotals';
import { APP_STATE, AUTH_TOKEN, CUSTOMER_NOT_DEFINED_ID, COUNTRY_COOKIE } from '~/constants';
import { getCookie } from '~/utils';
import { getActiveOrderQuery, setCustomerForOrderMutation } from '~/providers/shop/orders/order';
import { getActiveCustomerQuery, getActiveCustomerAddressesQuery } from '~/providers/shop/customer/customer';
import { CountryService } from '~/services/CountryService';
import { CheckoutAddresses } from '~/components/checkout/CheckoutAddresses';
import { CheckoutAddressProvider } from '~/contexts/CheckoutAddressContext';
import { createSEOHead } from '~/utils/seo';
import Payment from '~/components/payment/Payment';
import { useLocalCart, refreshCartStock, loadCartIfNeeded, useHasMixedPreOrder } from '~/contexts/CartContext';
import { CheckoutValidationProvider, useCheckoutValidation, useCheckoutValidationActions } from '~/contexts/CheckoutValidationContext';
import { OrderProcessingModal } from '~/components/OrderProcessingModal';

import { clearAllValidationCache } from '~/utils/cached-validation';
import { useCheckout } from '~/hooks/useCheckout';
import { transitionOrderToStateMutation } from '~/providers/shop/checkout/checkout';

import { LocalCartService } from '~/services/LocalCartService';
import { CheckoutOptimizationService } from '~/services/CheckoutOptimizationService';
import { validateBillingSection, validateCustomerSection, validateShippingSection } from '~/utils/checkout-section-validation';

// No routeLoader$ — countries load client-side in useVisibleTask$ so the page renders instantly on navigation.

const prefetchOrderConfirmation = $((orderCode: string) => {
  if (typeof document !== 'undefined' && orderCode) {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = `/checkout/confirmation/${orderCode}`;
    link.as = 'document';
    document.head.appendChild(link);
  }
});

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
  const { checkoutState, convertLocalCartToVendureOrder } = useCheckout();

  const state = useStore<CheckoutState>({
    loading: false,
    error: '',
  });

  const nmiTriggerSignal = useSignal(0);
  const sezzleTriggerSignal = useSignal(0);
  const selectedPaymentMethod = useSignal<string>('nmi');
  const pageLoading = useSignal(true);
  const paymentComplete = useSignal(false);
  const promoExpanded = useSignal(false);

  const isCartEmpty = useSignal(true);

  const isOrderProcessing = useSignal(false);
  const showProcessingModal = useSignal(false);

  // Compute live checkout total for the CTA button
  const checkoutTotalCents = useComputed$(() => {
    const subtotal = localCart.localCart.subTotal || 0;
    const discount = localCart.appliedCoupon?.discountAmount || 0;
    const discountedSubtotal = Math.max(subtotal - discount, 0);
    const countryCode = appState.shippingAddress?.countryCode;

    let shipping = 0;
    if (localCart.appliedCoupon?.freeShipping) {
      shipping = 0;
    } else if (countryCode) {
      if (countryCode === 'US' || countryCode === 'PR') {
        shipping = discountedSubtotal >= 10000 ? 0 : 800;
      } else {
        shipping = 2000;
      }
    }

    return discountedSubtotal + shipping;
  });

  const formattedTotal = useComputed$(() => {
    const cents = checkoutTotalCents.value || 0;
    if (cents === 0) return null;
    return '$' + (cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  });

  // T26: Initial checkout load — client-only (document.cookie, window access)
  // useVisibleTask$ because checkout is SSG'd — useTask$ without track() won't re-run on client
  useVisibleTask$(async () => {
    if (pageLoading.value) {
      try {
        clearAllValidationCache();
        appState.showCart = false;

        const [customerData, orderData, countriesData] = await Promise.all([
          getCookie(AUTH_TOKEN) ? getActiveCustomerQuery().catch(() => null) : Promise.resolve(null),
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

        // Restore persisted country from cookie/sessionStorage
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


  // T26: Cart validation — useTask$
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

  // Scroll payment form into view when address validation flips to valid
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

      // If retrying after payment failure, verify actual server state before transitioning
      if (appState.activeOrder && appState.activeOrder.state === 'ArrangingPayment') {
        try {
          const currentOrder = await getActiveOrderQuery();
          if (currentOrder && currentOrder.state === 'ArrangingPayment') {
            const transitionResult = await transitionOrderToStateMutation('AddingItems');
            const result = transitionResult.transitionOrderToState;
            if (result && 'state' in result) {
              appState.activeOrder = result as any;
            } else if (result && 'errorCode' in result) {
              console.error('[Checkout] Retry transition rejected by Vendure:', result);
              state.error = 'Failed to reset order for retry. Please refresh the page.';
              showProcessingModal.value = false;
              isOrderProcessing.value = false;
              return;
            }
          } else if (currentOrder) {
            // Server already has order in AddingItems (or other) — sync local state
            appState.activeOrder = currentOrder as any;
          }
        } catch (transitionError) {
          console.error('[Checkout] Retry transition threw:', transitionError);
          state.error = 'Failed to reset order for retry. Please refresh the page.';
          showProcessingModal.value = false;
          isOrderProcessing.value = false;
          return;
        }
      }

      // Refresh stock from server before proceeding to payment
      try {
        await refreshCartStock(localCart);
        const stockCheck = LocalCartService.validateStock();
        if (!stockCheck.valid) {
          throw new Error(stockCheck.errors?.[0] || 'Some items are no longer available');
        }
      } catch (stockError) {
        state.error = stockError instanceof Error ? stockError.message : 'Failed to verify stock availability';
        showProcessingModal.value = false;
        isOrderProcessing.value = false;
        return;
      }

      // Convert local cart to Vendure order
      try {
        const vendureOrder = await convertLocalCartToVendureOrder();
        if (!vendureOrder) {
          throw new Error(checkoutState.error || 'Failed to create order from your cart.');
        }
        appState.activeOrder = vendureOrder;
      } catch (conversionError) {
        state.error = conversionError instanceof Error ? conversionError.message : 'An unknown error occurred while creating your order.';
        showProcessingModal.value = false;
        isOrderProcessing.value = false;
        return;
      }

      // Set customer for order (guest checkout only)
      const isGuest = !appState.customer.id || appState.customer.id === CUSTOMER_NOT_DEFINED_ID;

      if (isGuest) {
        const customerData = {
          emailAddress: appState.customer.emailAddress || '',
          firstName: appState.customer.firstName || '',
          lastName: appState.customer.lastName || '',
          phoneNumber: appState.shippingAddress.phoneNumber || '',
        };

        try {
          const customerResult = await setCustomerForOrderMutation(customerData);

          if (customerResult.__typename === 'Order') {
            appState.activeOrder = customerResult as any;
          } else if (customerResult.__typename === 'EmailAddressConflictError') {
            const updatedOrder = await getActiveOrderQuery();
            if (updatedOrder) {
              appState.activeOrder = updatedOrder;
            }
          } else if (customerResult.__typename === 'GuestCheckoutError') {
            throw new Error('Guest checkout is not enabled. Please create an account or log in to continue.');
          } else if (customerResult.__typename === 'NoActiveOrderError') {
            throw new Error('No active order found. Please restart your checkout process.');
          } else {
            throw new Error('Failed to set customer for order: ' + (customerResult as any).message || 'Unknown error');
          }
        } catch (customerError) {
          throw customerError instanceof Error ? customerError : new Error('Failed to set customer information.');
        }
      }

      // Use CheckoutOptimizationService for efficient address and shipping method processing
      try {
        const shippingAddressInput = {
          fullName: appState.shippingAddress.fullName || `${appState.customer?.firstName || ''} ${appState.customer?.lastName || ''}`.trim(),
          streetLine1: appState.shippingAddress.streetLine1 || '',
          streetLine2: appState.shippingAddress.streetLine2,
          city: appState.shippingAddress.city || '',
          province: appState.shippingAddress.province || '',
          postalCode: appState.shippingAddress.postalCode || '',
          countryCode: appState.shippingAddress.countryCode || '',
          phoneNumber: appState.shippingAddress.phoneNumber,
          company: appState.shippingAddress.company,
        };

        const billingAddressInput = checkoutValidation.useDifferentBilling && appState.billingAddress ? {
          fullName: `${appState.billingAddress.firstName || ''} ${appState.billingAddress.lastName || ''}`.trim(),
          streetLine1: appState.billingAddress.streetLine1 || '',
          streetLine2: appState.billingAddress.streetLine2,
          city: appState.billingAddress.city || '',
          province: appState.billingAddress.province || '',
          postalCode: appState.billingAddress.postalCode || '',
          countryCode: appState.billingAddress.countryCode || '',
        } : undefined;

        const optimizationResult = await CheckoutOptimizationService.optimizedCheckoutProcessing(
          shippingAddressInput,
          billingAddressInput,
          appState.activeOrder?.subTotal || 0
        );

        if (!optimizationResult.order) {
          throw new Error('Failed to process address and shipping information.');
        }

        appState.activeOrder = optimizationResult.order;
      } catch (optimizationError) {
        console.warn('CheckoutOptimizationService failed, falling back to manual address submission:', optimizationError);

	        if (typeof window !== 'undefined' && (window as any).submitCheckoutAddressForm) {
	          await (window as any).submitCheckoutAddressForm();
	        } else {
	          const submitError = new Error('Failed to submit address form.') as Error & { cause?: unknown };
	          submitError.cause = optimizationError;
	          throw submitError;
	        }
	      }

      // Transition to ArrangingPayment
      if (appState.activeOrder && appState.activeOrder.state !== 'ArrangingPayment') {
        const transitionResult = await transitionOrderToStateMutation('ArrangingPayment');
        if (transitionResult.transitionOrderToState && 'state' in transitionResult.transitionOrderToState) {
          appState.activeOrder = transitionResult.transitionOrderToState as any;
        } else {
            throw new Error('Failed to prepare the order for payment.');
        }
      }

      const latestOrder = await getActiveOrderQuery();
      if (latestOrder?.state === 'ArrangingPayment') {
        appState.activeOrder = latestOrder;
        if (latestOrder.code) {
          await prefetchOrderConfirmation(latestOrder.code);
        }
        if (selectedPaymentMethod.value === 'nmi' && nmiTriggerSignal.value === 0) {
          nmiTriggerSignal.value++;
        } else if (selectedPaymentMethod.value === 'sezzle' && sezzleTriggerSignal.value === 0) {
          sezzleTriggerSignal.value++;
        }
      } else {
        throw new Error('Order is not ready for payment. Please try again.');
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'An unknown error occurred. Please check your information and try again.';
      showProcessingModal.value = false;
      isOrderProcessing.value = false;
    }
  });

  return (
    <div class="checkout-layout">

      {!pageLoading.value && isCartEmpty.value ? (
        <div style="min-height:100vh;background:#F7F2EA;display:flex;align-items:center;justify-content:center;padding:40px 24px;">
          <div style="text-align:center;max-width:380px;">
            <svg style="width:48px;height:48px;margin:0 auto 28px;color:rgba(140,107,58,0.45);" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
            </svg>
            <h2 class="font-heading" style="font-size:28px;font-weight:400;color:#141210;letter-spacing:0.02em;margin-bottom:12px;">
              Your cart is empty
            </h2>
            <p style="font-size:14px;color:rgba(100,85,65,0.55);margin-bottom:36px;line-height:1.7;">
              Add some items to your cart to continue with checkout.
            </p>
            <Link href="/shop" style="display:inline-block;background:#141210;color:#FDFAF6;padding:14px 40px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;border-radius:3px;">
              Continue Shopping
            </Link>
          </div>
        </div>
      ) : (
        <div class="min-h-screen">
          <OrderProcessingModal
            visible={showProcessingModal.value}
            onClose$={$(() => {
              showProcessingModal.value = false;
              isOrderProcessing.value = false;
            })}
          />

          <div class="max-w-7xl mx-auto pt-5 pb-10 sm:px-6 lg:px-8">
            <div class="checkout-columns lg:flex lg:gap-x-8 xl:gap-x-12">
              {/* ── LEFT: Order summary (dark sidebar) ── */}
              <div class="checkout-left order-2 lg:order-1 mb-8 lg:mb-0 lg:basis-[42%]">
                <div class="sticky top-4">
                  <div class="bg-transparent rounded-none sm:rounded-xl overflow-hidden">
                    {/* Header with total + promo link */}
                    <div class="px-4 py-5 border-b border-[rgba(184,115,51,0.25)]">
                      <div class="flex items-end justify-between gap-4">
                        <div class="flex flex-col gap-1">
                          <span class="text-[11px] font-heading font-normal tracking-[0.08em] uppercase text-[rgba(253,250,246,0.42)]">Your Order</span>
                          <span class="text-[26px] font-medium text-[#FDFAF6] tabular-nums leading-none">
                            {formattedTotal.value ?? ''}
                          </span>
                        </div>
                        <button
                          onClick$={() => {
                            if (localCart.appliedCoupon) return;
                            const willOpen = !promoExpanded.value;
                            promoExpanded.value = willOpen;
                            if (willOpen) {
                              setTimeout(() => {
                                document.getElementById('checkout-promo-code-input')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                              }, 60);
                            }
                          }}
                          class="inline-flex items-center py-0.5 mb-0.5 text-[12px] text-[rgba(253,250,246,0.42)] hover:text-[rgba(253,250,246,0.72)] transition-colors cursor-pointer bg-transparent border-0"
                        >
                          <span>Add promo code</span>
                        </button>
                      </div>
                    </div>

                    {/* Cart items */}
                    <div class="rounded-lg mt-4 mb-3">
                      <div class="px-4 py-3 sm:py-4">
                        {pageLoading.value ? (
                          <div class="space-y-4">
                            {[1, 2].map((i) => (
                              <div key={i} class="flex gap-3 animate-pulse">
                                <div style="width:56px;height:56px;border-radius:6px;background:rgba(253,250,246,0.08);flex-shrink:0;" />
                                <div class="flex-1" style="min-width:0;">
                                  <div style="height:12px;width:70%;border-radius:4px;background:rgba(253,250,246,0.1);margin-bottom:8px;" />
                                  <div style="height:10px;width:40%;border-radius:4px;background:rgba(253,250,246,0.06);" />
                                </div>
                                <div style="height:12px;width:48px;border-radius:4px;background:rgba(253,250,246,0.1);flex-shrink:0;" />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <CartContents />
                        )}
                      </div>
                    </div>

                    {/* Pre-order notice — only when cart has BOTH pre-order and regular items */}
                    {hasMixedPreOrder.value && (
                      <div class="bg-amber-50/10 border border-amber-200/20 rounded-lg mx-4 mb-4 p-4">
                        <div class="flex items-start">
                          <div class="flex-shrink-0">
                            <svg class="h-5 w-5 text-amber-400/60" viewBox="0 0 20 20" fill="currentColor">
                              <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                            </svg>
                          </div>
                          <div class="ml-3">
                            <h3 class="text-sm font-medium text-[rgba(253,250,246,0.8)]">Pre-Order Items Notice</h3>
                            <div class="mt-2 text-sm text-[rgba(253,250,246,0.5)]">
                              <p>Your order contains pre-order items. Your entire order will ship together when the last pre-order item becomes available.</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Totals rows */}
                    <div class="px-4 pb-4 pt-2">
                      {pageLoading.value ? (
                        <div class="animate-pulse space-y-3" style="padding-top:4px;">
                          <div class="flex justify-between">
                            <div style="height:10px;width:60px;border-radius:4px;background:rgba(253,250,246,0.08);" />
                            <div style="height:10px;width:48px;border-radius:4px;background:rgba(253,250,246,0.08);" />
                          </div>
                          <div class="flex justify-between">
                            <div style="height:10px;width:50px;border-radius:4px;background:rgba(253,250,246,0.08);" />
                            <div style="height:10px;width:40px;border-radius:4px;background:rgba(253,250,246,0.08);" />
                          </div>
                          <div style="border-top:1px solid rgba(184,115,51,0.15);padding-top:10px;" class="flex justify-between">
                            <div style="height:12px;width:40px;border-radius:4px;background:rgba(253,250,246,0.12);" />
                            <div style="height:12px;width:56px;border-radius:4px;background:rgba(253,250,246,0.12);" />
                          </div>
                        </div>
                      ) : (
                        <CartTotals
                          order={undefined}
                          localCart={localCart}
                          promoPlacement="rows"
                          promoExpandedSignal={promoExpanded}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* ── RIGHT: Form + payment ── */}
              <div class="checkout-right order-1 lg:order-2 mb-8 lg:mb-0 lg:basis-[58%]">
                <div class="checkout-right-inner" style="padding:8px 20px 32px;">

                  {/* Progress indicator */}
                  <div style="display:flex;align-items:center;gap:0;margin-bottom:24px;padding:4px 0;">
                    <div style="display:flex;align-items:center;gap:8px;">
                      <div style={{
                        width: '24px', height: '24px', borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '11px', fontWeight: '500',
                        background: checkoutValidation.isShippingAddressValid && checkoutValidation.isCustomerValid ? '#B87333' : '#141210',
                        color: '#FDFAF6', transition: 'background 0.3s',
                      }}>
                        {checkoutValidation.isShippingAddressValid && checkoutValidation.isCustomerValid ? (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FDFAF6" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>
                        ) : '1'}
                      </div>
                      <span style={{
                        fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase',
                        color: checkoutValidation.isShippingAddressValid && checkoutValidation.isCustomerValid ? '#B87333' : '#141210',
                        fontWeight: '500', transition: 'color 0.3s',
                      }}>Shipping</span>
                    </div>
                    <div style={{
                      flex: '1', height: '1px', margin: '0 12px',
                      background: checkoutValidation.isShippingAddressValid && checkoutValidation.isCustomerValid ? '#B87333' : 'rgba(100,85,65,0.15)',
                      transition: 'background 0.3s',
                    }} />
                    <div style="display:flex;align-items:center;gap:8px;">
                      <div style={{
                        width: '24px', height: '24px', borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '11px', fontWeight: '500',
                        background: checkoutValidation.isShippingAddressValid && checkoutValidation.isCustomerValid ? '#141210' : 'rgba(100,85,65,0.12)',
                        color: checkoutValidation.isShippingAddressValid && checkoutValidation.isCustomerValid ? '#FDFAF6' : 'rgba(100,85,65,0.4)',
                        transition: 'all 0.3s',
                      }}>2</div>
                      <span style={{
                        fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase',
                        color: checkoutValidation.isShippingAddressValid && checkoutValidation.isCustomerValid ? '#141210' : 'rgba(100,85,65,0.35)',
                        fontWeight: '500', transition: 'color 0.3s',
                      }}>Payment</span>
                    </div>
                  </div>

                  {/* Shipping details */}
                  <div class="mb-3">
                    {pageLoading.value ? (
                      <div class="animate-pulse" style="padding-top:8px;">
                        {/* Section heading skeleton */}
                        <div style="height:14px;width:140px;border-radius:4px;background:rgba(100,85,65,0.1);margin-bottom:20px;" />
                        {/* Name row: first + last */}
                        <div class="flex gap-3" style="margin-bottom:14px;">
                          <div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
                          <div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
                        </div>
                        {/* Email */}
                        <div style="height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);margin-bottom:14px;" />
                        {/* Phone */}
                        <div style="height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);margin-bottom:24px;" />
                        {/* Address heading */}
                        <div style="height:14px;width:160px;border-radius:4px;background:rgba(100,85,65,0.1);margin-bottom:20px;" />
                        {/* Street */}
                        <div style="height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);margin-bottom:14px;" />
                        {/* City + State row */}
                        <div class="flex gap-3" style="margin-bottom:14px;">
                          <div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
                          <div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
                        </div>
                        {/* Zip + Country row */}
                        <div class="flex gap-3">
                          <div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
                          <div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
                        </div>
                      </div>
                    ) : (
                      <CheckoutAddresses />
                    )}
                  </div>

                  {/* Payment — gated on address completion, smooth reveal */}
                  <div id="checkout-payment-section" style="margin-bottom:14px;scroll-margin-top:16px;">
                    <div
                      class="grid transition-all duration-500 ease-out"
                      style={{
                        gridTemplateRows: (checkoutValidation.isCustomerValid && checkoutValidation.isShippingAddressValid) ? '1fr' : '0fr',
                        opacity: (checkoutValidation.isCustomerValid && checkoutValidation.isShippingAddressValid) ? '1' : '0',
                      }}
                    >
                      <div class="overflow-hidden">
                    <Payment
                      triggerNMISignal={nmiTriggerSignal}
                      triggerSezzleSignal={sezzleTriggerSignal}
                      selectedPaymentMethod={selectedPaymentMethod}
                      hideButton={true}
                      onForward$={$(async (orderCode: string) => {
                        paymentComplete.value = true;
                        navigate(`/checkout/confirmation/${orderCode}`);
                        state.loading = true;
                      })}
                      onError$={$(async (_errorMessage: string) => {
                        // CRITICAL CHECK: Before handling error, check if order actually succeeded
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

                        // Cart is always local — just ensure UI refreshes

                        try {
                          const currentCart = LocalCartService.getCart();
                          if (currentCart.items.length > 0) {
                            if (typeof window !== 'undefined') {
                              window.dispatchEvent(new CustomEvent('cart-updated', {
                                detail: { totalQuantity: currentCart.totalQuantity }
                              }));
                            }
                          }
                        } catch (cartError) {
                          console.error('[Checkout] Error checking cart state after payment failure:', cartError);
                        }

                        // Try to transition order back to AddingItems state for retry
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
                      })}
                      onProcessingChange$={$(async (isProcessing: boolean) => {
                        state.loading = isProcessing;
                        isOrderProcessing.value = isProcessing;
                      })}
                      isDisabled={false}
                    />
                      </div>
                    </div>
                    {!(checkoutValidation.isCustomerValid && checkoutValidation.isShippingAddressValid) && (
                      <div class="payment-placeholder">
                        Complete your shipping address to see payment options
                      </div>
                    )}
                  </div>
                  {state.error && (
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
                      <span>{state.error}</span>
                    </div>
                  )}
                  {/* ── CTA block (desktop) — hidden on mobile, sticky bar used instead ── */}
                  <div class={`checkout-cta-inline ${!checkoutValidation.isAllValid ? 'checkout-cta-inline-invalid' : ''}`}>
                    <button
                      onClick$={$(() => {
                        if (state.loading || checkoutState.isLoading) return;
                        placeOrder();
                      })}
                      disabled={isOrderProcessing.value}
                      aria-disabled={!checkoutValidation.isAllValid}
                      class={`checkout-cta ${!checkoutValidation.isAllValid ? 'checkout-cta-invalid' : ''}`}
                    >
                      {state.loading || checkoutState.isLoading ? (
                        <span class="flex items-center justify-center">
                          <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Processing...
                        </span>
                      ) : (
                        <span class="checkout-cta-label flex items-center justify-center">
                          {selectedPaymentMethod.value === 'sezzle' ? (
                            'Continue with Sezzle'
                          ) : (
                            formattedTotal.value
                              ? `PLACE ORDER \u2014 ${formattedTotal.value}`
                              : 'PLACE ORDER'
                          )}
                        </span>
                      )}
                      {!checkoutValidation.isAllValid && (
                        <span class="checkout-cta-stop-icon" aria-hidden="true">
                          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <circle cx="12" cy="12" r="9" stroke-width="2"></circle>
                            <path stroke-linecap="round" stroke-width="2" d="M8.5 8.5l7 7M15.5 8.5l-7 7"></path>
                          </svg>
                        </span>
                      )}
                    </button>
                    {!checkoutValidation.isAllValid && (
                      <div class="checkout-cta-tooltip">
                        Please complete all required fields to continue
                      </div>
                    )}
                  </div>

                  {/* Below-CTA content (desktop only) */}
                  <div class="checkout-below-cta" style="margin-top:20px;">
                    <p class="text-[11px] text-center leading-relaxed" style="color: rgba(28,25,23,0.45)">
                      By completing your purchase you agree to our{' '}
                      <Link href="/terms" target="_blank" class="underline" style="color: rgba(28,25,23,0.65)">Terms & Conditions</Link>
                      {' '}and{' '}
                      <Link href="/privacy" target="_blank" class="underline" style="color: rgba(28,25,23,0.65)">Privacy Policy</Link>.
                    </p>
                    <div class="flex items-center justify-center gap-2 text-[12px] text-[rgba(100,85,65,0.72)] mt-2">
                      <svg class="w-4 h-4 text-[rgba(100,85,65,0.7)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 11c1.1 0 2-.9 2-2V7a2 2 0 00-4 0v2c0 1.1.9 2 2 2zm6 0h-1V9a5 5 0 10-10 0v2H6a2 2 0 00-2 2v5a2 2 0 002 2h12a2 2 0 002-2v-5a2 2 0 00-2-2z" />
                      </svg>
                      <span>Secure checkout · Free shipping over $100 · 30-day returns</span>
                    </div>
                  </div>

                </div>
              </div>
            </div>
          </div>

          {/* ── Mobile sticky CTA bar ── */}
          <div class="sticky-cta-bar">
            <div class="sticky-cta-total">
              <div class="sticky-cta-total-label">Total</div>
              <div class="sticky-cta-total-amount">
                {formattedTotal.value ?? '\u2014'}
              </div>
            </div>
            <button
              onClick$={$(() => {
                if (state.loading || checkoutState.isLoading) return;
                placeOrder();
              })}
              disabled={isOrderProcessing.value}
              aria-disabled={!checkoutValidation.isAllValid}
              class={`sticky-cta-btn ${!checkoutValidation.isAllValid ? 'opacity-50' : ''}`}
            >
              {state.loading || checkoutState.isLoading ? (
                <span class="flex items-center justify-center gap-2">
                  <svg class="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Processing...
                </span>
              ) : (
                'PLACE ORDER'
              )}
            </button>
          </div>

        </div>
      )}
    </div>
  );
});

const CHECKOUT_STYLES = `

        .checkout-layout{min-height:100vh;background:linear-gradient(to right,#2c2926 42%,#F7F2EA 42%)}
        .checkout-columns{align-items:stretch}
        .checkout-left,.checkout-right{min-height:100%}

        /* CTA button — always full black, never greyed out */
        .checkout-cta{display:block;width:100%;background:#141210;color:#FDFAF6;opacity:1;cursor:pointer;height:50px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;border-radius:3px;border:none;font-weight:500;transition:opacity 0.2s;position:relative}
        .checkout-cta:hover{opacity:0.88}
        .checkout-cta.checkout-cta-invalid{cursor:not-allowed;opacity:0.92}
        .checkout-cta.checkout-cta-invalid:hover{opacity:0.92}
        .checkout-cta-label{transition:color 0.18s ease}
        .checkout-cta.checkout-cta-invalid:hover .checkout-cta-label{color:#fca5a5}
        .checkout-cta-stop-icon{position:absolute;right:20px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity 0.18s ease;color:#fca5a5}
        .checkout-cta.checkout-cta-invalid:hover .checkout-cta-stop-icon{opacity:1}
        .checkout-cta-inline{position:relative}
        .checkout-cta-tooltip{position:absolute;left:50%;top:calc(100% + 8px);transform:translateX(-50%) translateY(-4px);opacity:0;pointer-events:none;background:rgba(250,248,244,0.98);color:rgba(28,25,23,0.76);border:1px solid rgba(176,168,152,0.48);box-shadow:0 8px 20px rgba(28,25,23,0.12);font-size:11px;line-height:1;padding:7px 10px;border-radius:4px;white-space:nowrap;transition:all 0.18s ease;z-index:5}
        .checkout-cta-tooltip::before{content:'';position:absolute;left:50%;top:-4px;transform:translateX(-50%) rotate(45deg);width:8px;height:8px;background:rgba(250,248,244,0.98);border-left:1px solid rgba(176,168,152,0.48);border-top:1px solid rgba(176,168,152,0.48)}
        .checkout-cta-inline.checkout-cta-inline-invalid:hover .checkout-cta-tooltip{opacity:1;transform:translateX(-50%) translateY(0)}

        /* Warm placeholder text for checkout form inputs */
        .checkout-right input::placeholder,
        .checkout-right select::placeholder,
        .checkout-right textarea::placeholder {
          color: rgba(100, 85, 65, 0.42) !important;
        }

        /* Payment placeholder shown before address is complete */
        .payment-placeholder{
          padding:2px 0;
          text-align:center;
          font-size:11px;
          color:rgba(100,85,65,0.4);
          letter-spacing:0.02em;
          line-height:1.6;
        }

        /* Mobile sticky bar — hidden on desktop */
        .sticky-cta-bar{
          display:none;
        }

        @media (max-width:767px){
          .checkout-layout{background:#F7F2EA}
          .checkout-left{background:#2c2926}
          .checkout-right{background:transparent}

          /* Extra bottom padding on mobile so the sticky bar doesn't overlap the inline button */
          .checkout-right-inner{padding-bottom:90px!important}

          /* Hide inline button + below-button content on mobile — sticky bar handles it */
          .checkout-cta-inline{display:none}
          .checkout-below-cta{display:none}

          /* Show sticky bar on mobile */
          .sticky-cta-bar{
            display:flex;
            position:fixed;
            bottom:0;left:0;right:0;
            z-index:40;
            background:#F7F2EA;
            border-top:1px solid rgba(184,115,51,0.18);
            padding:12px 16px calc(12px + env(safe-area-inset-bottom));
            align-items:center;
            gap:12px;
            box-shadow:0 -4px 20px rgba(0,0,0,0.06);
          }
          .sticky-cta-total{
            flex-shrink:0;
            text-align:left;
          }
          .sticky-cta-total-label{
            font-size:10px;
            letter-spacing:0.1em;
            text-transform:uppercase;
            color:rgba(100,85,65,0.5);
            line-height:1;
            margin-bottom:3px;
          }
          .sticky-cta-total-amount{
            font-size:16px;
            font-weight:500;
            color:#141210;
            line-height:1;
          }
          .sticky-cta-btn{
            flex:1;
            background:#141210;
            color:#FDFAF6;
            border:none;
            height:46px;
            border-radius:3px;
            font-size:11px;
            letter-spacing:0.14em;
            text-transform:uppercase;
            font-weight:500;
            cursor:pointer;
            transition:opacity 0.2s;
            opacity:1;
          }
          .sticky-cta-btn:active{opacity:0.85;}
        }
` as const;

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
