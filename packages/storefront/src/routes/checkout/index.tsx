import { $, component$, useContext, useStore, useStyles$, useTask$, useVisibleTask$, useSignal, useComputed$ } from '@qwik.dev/core';
import { useNavigate } from '@qwik.dev/router';
import { APP_STATE, COUNTRY_COOKIE } from '~/constants';
import { getCookie } from '~/utils';
import { getMe, getAddresses } from '~/services/customer';
import { CountryService } from '~/services/CountryService';
import { CheckoutAddressProvider } from '~/contexts/CheckoutAddressContext';
import { track } from '~/sellright/analytics';
import { useCart, refreshCartLive, refreshCartStock, retireSettledCart, loadCartIfNeeded, useHasMixedPreOrder } from '~/contexts/CartContext';
import { CartService } from '~/services/CartService';
import { validateCheckoutStock } from '~/hooks/pre-submit-stock';
import { CheckoutValidationProvider, useCheckoutValidation, useCheckoutValidationActions } from '~/contexts/CheckoutValidationContext';
import { useCheckout, type PaymentMethod } from '~/hooks/useCheckout';
import { formatCents } from '~/hooks/checkout-total';
import { decideCheckoutEntry, defaultPaymentMethod, shouldApplyConfigDefault, shouldResumeLate } from '~/hooks/checkout-stage';
import { getShopConfig, getShippingQuote } from '~/providers/shop/checkout/checkout';
import type { ShopConfig, ShopShippingMethod } from '~/sellright/types/checkout';
import { validateBillingSection, validateCustomerSection, validateShippingSection } from '~/utils/checkout-section-validation';
import { CheckoutPageView } from '~/components/checkout/CheckoutPageView';
import { CHECKOUT_STYLES } from './checkout-styles';
import { recoverCheckoutPaymentError, classifyResumePaymentError } from './checkout-payment-recovery';
import { acceptsMount, bumpView, isCurrentView } from '~/components/checkout/view-generation';
import type { ResumeQueue } from '~/components/checkout/resume-selection';
import { beginResumeFlow, cancelResumeFlow } from '~/components/checkout/resume-flow';
import { submitOrderFlow } from '~/components/checkout/place-order-flow';
import { applyPaymentInitError, applyPaymentProcessingChange } from '~/components/checkout/payment-callbacks';
import { useLoyaltyOffer } from '~/platform/controllers/loyalty';


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
  const { checkoutState, state: srState, placeOrder: placeOrderNative, resumeConverted, resetOrder } = useCheckout();

  const state = useStore<CheckoutState>({
    loading: false,
    error: '',
  });

  const stripePublishableKey = useSignal<string>('');
  const stripeConfirmTrigger = useSignal(0);
  // Which payment method the shopper has selected — defaults once shopConfig
  // resolves (see the useTask$ below): stripe > nmi > sezzle, whichever the
  // store actually has configured. gatewayConfirmTrigger is the NMI
  // equivalent of stripeConfirmTrigger. The NMI/Sezzle components mint their
  // own Idempotency-Key per PAY submit — a key shared across submits would
  // replay a declined attempt forever (see components/payment/NMI.tsx).
  const paymentMethod = useSignal<PaymentMethod>('stripe');
  const gatewayConfirmTrigger = useSignal(0);
  // Changed-total consent: the shopper's explicit OK of the server total when
  // it differs from the estimate they saw (reset on every PLACE ORDER).
  const totalConfirmed = useSignal(false);
  const confirmedQuoteHash = useSignal('');
  const quoteFormContext = useSignal('');
  const quoteCartContext = useSignal('');
  const pageLoading = useSignal(true);
  const promoExpanded = useSignal(false);
  // Loyalty points to spend on this order (0 = none) — written only by useLoyaltyOffer (the shopper's toggle, or a reset
  // when the discountable amount changes), re-validated server-side at order creation.
  const redeemPoints = useSignal(0);
  const discountableCents = useComputed$(() => Math.max(0, (localCart.cart.subtotal || 0) - (localCart.cart.discountTotal || 0) + (localCart.cart.pointsDiscount || 0)));
  const cartCurrency = useComputed$(() => localCart.cart.currency || 'USD');
  // Destructured on purpose, and the signal itself (not `.value`) goes down to CheckoutOrderSummary, which reads it in its own render.
  const { view: loyaltyView, onRedeemToggle$ } = useLoyaltyOffer(redeemPoints, discountableCents, cartCurrency);

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
  // The config's default method is applied once (see shouldApplyConfigDefault); a late completion must not overwrite
  // the selection nor the client secret that belongs to it.
  const configDefaultApplied = useSignal(false);
  // The mounted payment component could not LOAD (not a decline): `failed` shows a retry, `key` remounts it.
  // `gen` is the route's single view generation (see components/checkout/view-generation.ts): every async handler below
  // captures it at entry and stops without touching state once it changed.
  const paymentInit = useStore({ failed: false, key: 0, gen: 0 });

  useTask$(async ({ track, cleanup }) => {
    const countryCode = track(() => appState.shippingAddress?.countryCode);
    // The server quotes from the cart's own items and coupons; re-quote whenever either changes.
    const items = track(() => localCart.cart.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })));
    const couponCodes = track(() => [...(localCart.cart.couponCodes ?? [])]);

    if (!countryCode) {
      shippingCents.value = null;
      shippingMethod.value = null;
      return;
    }

    let cancelled = false;
    cleanup(() => { cancelled = true; });

    try {
      // Eligibility and rate are decided server-side from the cart (items, coupons, tax); nothing is computed here.
      const { methods, freeShipping } = await getShippingQuote(countryCode, items, couponCodes);
      if (cancelled) return;
      appState.freeShipping = freeShipping;
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

  useTask$(async ({ track, cleanup }) => {
    const shipping = track(() => JSON.stringify(appState.shippingAddress));
    const billing = track(() => JSON.stringify(appState.billingAddress));
    const method = track(() => shippingMethod.value?.code);
    const points = track(() => redeemPoints.value);
    const context = JSON.stringify([shipping, billing, method, points]);
    // Replacing an equal address/method object must not erase pending consent or start another quote read.
    if (context === quoteFormContext.value) return;
    quoteFormContext.value = context;
    confirmedQuoteHash.value = '';
    srState.quoteChange = null;
    CartService.setQuoteContext({ pricingIntent: 'checkout', shipCountry: appState.shippingAddress?.countryCode,
      shippingMethodCode: method, ...(points > 0 ? { redeemPoints: points } : {}) });
    let cancelled = false;
    cleanup(() => { cancelled = true; });
    if (!CartService.token()) return;
    try {
      await CartService.refresh();
      if (cancelled) return;
    } catch (error) {
      if (!cancelled) state.error = error instanceof Error ? error.message : 'Updated quote could not be loaded.';
    }
  });

  useVisibleTask$(({ cleanup }) => {
    cleanup(() => { CartService.setQuoteContext({}); });
  });

  useTask$(({ track }) => {
    const context = track(() => JSON.stringify([localCart.cart.token, localCart.cart.revision, localCart.cart.couponCodes]));
    // Every live read replaces the mirror object, even if its revision/membership stayed unchanged.
    if (context === quoteCartContext.value) return;
    quoteCartContext.value = context;
    confirmedQuoteHash.value = '';
    // Adoption of the refused quote must retain the explicit-confirmation prompt.
    if (srState.quoteChange?.quoteHash !== localCart.cart.quoteHash) srState.quoteChange = null;
  });

  useTask$(({ track }) => {
    const hash = track(() => localCart.cart.quoteHash);
    if (hash) shippingCents.value = localCart.cart.shippingTotal;
  });

  const checkoutTotalCents = useComputed$(() => {
    if (srState.quoteChange) return srState.quoteChange.quote.grandTotal;
    if (localCart.cart.quoteHash) return localCart.cart.grandTotal;
    const subtotal = localCart.cart.subtotal || 0;
    const discount = localCart.cart.discountTotal || 0;
    const discountedSubtotal = Math.max(subtotal - discount, 0);

    // Shipping unknown (no destination yet, or quote still loading/failed) —
    // don't guess. The displayed total reflects subtotal only until the
    // server-priced shipping quote resolves.
    const shipping = shippingCents.value ?? 0;

    return discountedSubtotal + shipping;
  });

  // Once the order exists its server-priced grandTotal is the amount that will
  // be charged, so every total on the page shows THAT, never the estimate.
  const formattedTotal = useComputed$(() => {
    const orderPlaced = srState.phase === 'paying' && srState.grandTotal > 0;
    const cents = (orderPlaced ? srState.grandTotal : checkoutTotalCents.value) || 0;
    if (cents === 0) return null;
    return formatCents(cents);
  });

  const applyShopConfig = $((cfg: ShopConfig) => {
    shopConfig.value = cfg;
    if (cfg.stripePublishableKey) stripePublishableKey.value = cfg.stripePublishableKey;
    // Default selection: prefer whichever method the store actually has configured (stripe > nmi > sezzle). The
    // shopper can still switch via the method selector when more than one is available.
    if (!shouldApplyConfigDefault(configDefaultApplied.value)) return;
    configDefaultApplied.value = true;
    const method = defaultPaymentMethod(cfg);
    if (method) paymentMethod.value = method;
  });

  // EVERY read of the shop config goes through here: it resolves only after the config AND its default method are
  // applied, so no caller sees a null config or a not-yet-defaulted method. A failed fetch rejects.
  // A load that finishes after the view generation changed writes nothing (no config, no default method) and just returns
  // what it read; its caller re-checks the generation.
  // No default parameter for `gen`: a default that reads captured state is evaluated before the QRL's lexical scope is
  // restored and arrives as undefined, which made every stale check fail (see ensure-shop-config-gen.test.ts).
  const ensureShopConfig = $(async (genArg?: number): Promise<ShopConfig> => {
    const gen = genArg ?? paymentInit.gen;
    if (shopConfig.value) return shopConfig.value;
    const cfg = await getShopConfig();
    if (!isCurrentView(paymentInit, gen)) return cfg;
    await applyShopConfig(cfg);
    return shopConfig.value ?? cfg;
  });

  // Forget everything bound to the previous order (store fields, method lock via phase, confirm triggers, consent, init
  // failure). Run on every transition out of a resume state that is NOT a resume of the same order.
  const resetOrderState = $(async () => {
    await resetOrder();
    stripeConfirmTrigger.value = 0;
    gatewayConfirmTrigger.value = 0;
    totalConfirmed.value = false;
    paymentInit.failed = false;
    paymentInit.key = paymentInit.key + 1;
  });

  // Resume the ORIGINAL order of a converted cart: its own view and payment initialisation, never the new-order form
  // gates, the stock check or an order POST. `methodOverride` re-initialises payment for a method the shopper picked;
  // `probe` marks a lookup made because the live cart read failed (see enterCheckout).
  const resumeQueue = useStore<ResumeQueue<PaymentMethod>>({ busy: false, pending: null, epoch: 0 });
  // The resume logic itself lives in resume-flow.ts (so tests can drive it); this only wires it to the page's state.
  const beginResume = $(async (methodOverride?: PaymentMethod, probe = false) => {
    await beginResumeFlow(
      {
        queue: resumeQueue,
        view: paymentInit,
        srState,
        state,
        selectedMethod: () => paymentMethod.value,
        token: () => CartService.token(),
        ensureShopConfig: (gen) => ensureShopConfig(gen),
        resumeConverted: (token, method, isProbe, isCurrent) => resumeConverted(token, method, isProbe, isCurrent),
        navigate: (path) => navigate(path),
      },
      methodOverride,
      probe,
    );
  });

  // The normal new-order checkout's own initialisation (customer, countries, address, destination country).
  const loadNormalCheckout = $(async (gen: number) => {
    const [customerData, countriesData] = await Promise.all([
      getMe().catch(() => null),
      CountryService.getAvailableCountries().catch(() => []),
    ]);
    if (!isCurrentView(paymentInit, gen)) return;

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
        if (!isCurrentView(paymentInit, gen)) return;
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
    if (!isCurrentView(paymentInit, gen)) return;

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
  });

  // Checkout ENTRY. LOCKED: live cart read first, so a converted cart is recognised before the empty-cart gate, the
  // stock task and the form/shipping validation — none of which apply to an order that already exists. A FAILED read
  // proves nothing about the cart, so it never selects the normal checkout: the original order is looked up read-only
  // (it needs no repriced cart) and, when there is none, the page stays on a retryable unresolved state.
  const enterCheckout = $(async () => {
    const gen = paymentInit.gen;
    const current = () => isCurrentView(paymentInit, gen);
    // Started first so it overlaps the cart read; awaited before the form shows. A failure is tolerated here (the
    // method list is then empty and PLACE ORDER refuses until the config loads) — the resume path treats it as fatal.
    const configRead = ensureShopConfig().catch((e) => console.warn('[Checkout] shop-config fetch failed:', e));
    await loadCartIfNeeded(localCart);
    if (!current()) return;
    const read = await refreshCartLive(localCart);
    if (!current()) return;
    const decision = decideCheckoutEntry({
      status: localCart.cart.status,
      readFailed: read === 'failed',
      hasToken: !!CartService.token(),
    });
    if (decision !== 'normal') {
      await beginResume(undefined, decision === 'probe');
      return;
    }
    // The cart is a normal active one. Even if this page was showing a resumed order (the cookie was replaced in
    // another tab between the failure and this retry), that order's code, receipt token, client secret, phase, method
    // lock and triggers must not survive into a different cart's checkout.
    await resetOrderState();
    if (!current()) return;
    // Plan v3.1 §3.5: begin_checkout once per normal checkout view (consent-gated by the analytics bus; minor units).
    track({ name: 'begin_checkout', currency: localCart.cart.currency, value: localCart.cart.subtotal, itemCount: localCart.cart.lines.reduce((n, l) => n + l.quantity, 0) });
    await configRead;
    if (!current()) return;
    await loadNormalCheckout(gen);
  });

  // Retry from the error view re-runs the whole entry sequence (cart read included).
  const onResumeRetry$ = $(async () => {
    // A retry starts the view over.
    const gen = bumpView(paymentInit);
    srState.resume = 'loading';
    srState.error = null;
    try {
      await enterCheckout();
    } catch (error) {
      if (!isCurrentView(paymentInit, gen)) return;
      console.error('[Checkout] Retry failed:', error);
      srState.error = "We couldn't load your checkout. Please try again.";
      srState.resume = 'error';
    }
  });

  const onResumeMethod$ = $(async (method: PaymentMethod) => {
    await beginResume(method);
  });

  // Offered only for a cancelled order; `retireSettledCart` verifies that server-side before it frees the cart slot.
  const onStartNewCart$ = $(async () => {
    const gen = bumpView(paymentInit);
    const retired = await retireSettledCart(localCart);
    if (!isCurrentView(paymentInit, gen)) return;
    if (retired) {
      await resetOrderState();
      if (!isCurrentView(paymentInit, gen)) return;
      isCartEmpty.value = true;
      return;
    }
    srState.error = "We couldn't confirm that this order is finished. Please try again.";
    srState.resume = 'error';
  });

  // Leaving the page supersedes every in-flight handler. Its OWN task, and it reads nothing reactive: Qwik runs a task's
  // cleanup whenever the task re-runs, so this must never live in a task that subscribes to page state (the entry
  // task re-runs when the cart converts at order creation, which would discard the place-order result).
  useVisibleTask$(({ cleanup }) => {
    // Supersede the in-flight resume AND void any queued method selection, so nothing starts after the page is left.
    cleanup(() => { cancelResumeFlow(paymentInit, resumeQueue); });
  });

  useVisibleTask$(async () => {
    const gen = paymentInit.gen;
    if (pageLoading.value) {
      try {
        appState.showCart = false;

        await enterCheckout();
      } catch (error) {
        console.error('[Checkout] Error during checkout initialization:', error);
        if (isCurrentView(paymentInit, gen)) state.error = 'Failed to load checkout. Please try again.';
      } finally {
        pageLoading.value = false;
      }
    }
  });

  // A conversion discovered AFTER initialisation (a later cart refresh, a drawer action, another tab's order reaching
  // the mirror) switches to the resume view too: the original order must not stay behind the incomplete form or the
  // empty-cart view. Entry and PLACE ORDER resume on their own (the predicate excludes them).
  useVisibleTask$(async ({ track }) => {
    const status = track(() => localCart.cart.status);
    const loadingNow = track(() => pageLoading.value);
    const processing = track(() => isOrderProcessing.value);
    if (shouldResumeLate({ status, resume: srState.resume, orderCode: srState.code, phase: srState.phase, pageLoading: loadingNow, processing })) {
      await beginResume();
    }
  });

  useTask$(async ({ track }) => {
    track(() => localCart.cart.lines);
    // A converted cart recovers its own order (see validateCheckoutStock); its status arrives with the live read.
    track(() => localCart.cart.status);

    isCartEmpty.value = localCart.cart.lines.length === 0;

    if (localCart.cart.lines.length > 0) {
        const stockValidation = validateCheckoutStock();
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
    // An existing order is paid through its provider controls, including after an init failure.
    if (srState.phase === 'paying') return;
    if (isOrderProcessing.value) return;
    if (state.loading || checkoutState.isLoading) return;
    if (localCart.cart.pricingIntent !== 'checkout') {
      state.error = 'Your checkout quote is loading. Please review updated amounts before placing your order.';
      return;
    }
    if (srState.quoteChange && confirmedQuoteHash.value !== srState.quoteChange.quoteHash) {
      state.error = 'Review updated amounts & confirm this quote before placing your order.';
      return;
    }

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
    const gen = paymentInit.gen;
    const current = () => isCurrentView(paymentInit, gen);

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
        couponCodes: [...(localCart.cart.couponCodes ?? [])],
        acceptedQuoteHash: srState.quoteChange?.quoteHash ?? localCart.cart.quoteHash,
        redeemPoints: redeemPoints.value > 0 ? redeemPoints.value : undefined,
      };
      // From here to the payment view: place-order-flow.ts (it never bumps the view generation).
      await submitOrderFlow(
        {
          srState,
          state,
          flags: { processingModal: showProcessingModal, orderProcessing: isOrderProcessing, totalConfirmed },
          selectedMethod: () => paymentMethod.value,
          shownCents: () => checkoutTotalCents.value || 0,
          ensureShopConfig: () => ensureShopConfig(),
          placeOrder: (f, method, shown) => placeOrderNative(f, method, shown),
          beginResume: () => beginResume(),
          refreshStock: () => refreshCartStock(localCart),
          navigate: (path) => navigate(path),
          hasCartToken: () => !!CartService.token(),
          onPaying: () => {
            setTimeout(() => {
              document.getElementById('payment-method-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 80);
          },
        },
        form,
        current,
      );
    } catch (error) {
      if (!current()) return;
      state.error = error instanceof Error ? error.message : 'An unknown error occurred. Please check your information and try again.';
    } finally {
      showProcessingModal.value = false;
      isOrderProcessing.value = false;
    }
  });

  // Resume view: classify the order afresh and update the resume view — a decline keeps the controls and shows an
  // error, a cancelled / unknown / unreadable order removes them, a settled one goes to confirmation.
  const recoverResumePaymentError = $(async () => {
    // Controls stay locked (state.loading) until the order status is resolved: a method switch during a slow or failed
    // status read would start a second payment whose view this recovery then overwrites. A recovery does not bump the
    // generation: the mounted component stays the one in charge after a decline.
    const gen = paymentInit.gen;
    const current = () => isCurrentView(paymentInit, gen);
    showProcessingModal.value = false;
    isOrderProcessing.value = false;
    state.loading = true;
    try {
      const outcome = await classifyResumePaymentError({ code: srState.code, receiptToken: srState.receiptToken });
      // Superseded (the view was replaced or the page was left): the newer view owns the state.
      if (!current()) return;
      if (outcome.kind === 'settled') {
        const rt = outcome.receiptToken ? `?rt=${encodeURIComponent(outcome.receiptToken)}` : '';
        navigate(`/checkout/confirmation/${outcome.code}${rt}`);
        return;
      }
      if (outcome.kind === 'payable') {
        srState.paymentError = outcome.message;
        return;
      }
      srState.clientSecret = '';
      srState.paymentError = null;
      if (outcome.kind === 'cancelled') {
        srState.resume = 'cancelled';
        return;
      }
      srState.error = outcome.message;
      srState.resume = 'error';
    } catch (e) {
      // An unexpected failure must not strand the locked, payable-looking view: show the retryable error instead.
      if (!current()) return;
      console.error('[Checkout] Resume payment recovery failed:', e);
      srState.clientSecret = '';
      srState.paymentError = null;
      srState.error = "We couldn't confirm your payment status. Please try again.";
      srState.resume = 'error';
    } finally {
      state.loading = false;
    }
  });

  const onPaymentError$ = $(async (_errorMessage: string, mountGen?: number) => {
    // A callback from a payment component that is no longer the current view says nothing about the current one.
    if (!acceptsMount(paymentInit, mountGen)) return;
    if (srState.resume !== 'none') {
      await recoverResumePaymentError();
      return;
    }
    const gen = paymentInit.gen;
    await recoverCheckoutPaymentError({
      isCurrent: () => isCurrentView(paymentInit, gen),
      isOrderProcessing,
      navigate,
      showProcessingModal,
      state,
      order: srState.code ? { code: srState.code, receiptToken: srState.receiptToken } : undefined,
    });
  });

  // The payment component failed to LOAD (not a decline): no order-state read, nothing to classify — show the retry that
  // remounts it. The order, its client secret and the selected method stay as they are.
  const onPaymentInitError$ = $(async (errorMessage: string, mountGen?: number) => {
    // The component's QRL may run only after the view was replaced (method switch, retry, resume): reject it here.
    if (!applyPaymentInitError({ view: paymentInit, state, flags: { processingModal: showProcessingModal, orderProcessing: isOrderProcessing } }, mountGen)) return;
    console.warn('[Checkout] payment component failed to initialise:', errorMessage);
  });

  const onPaymentProcessingChange$ = $(async (isProcessing: boolean, mountGen?: number) => {
    // A stale component may not LOCK the current view; releasing a lock is always safe.
    applyPaymentProcessingChange({ view: paymentInit, state, flags: { processingModal: showProcessingModal, orderProcessing: isOrderProcessing } }, isProcessing, mountGen);
  });

  // Intentionally NOT generation-guarded: a settled charge means the order is paid, so the shopper is taken to its
  // confirmation whatever view they are on.
  // NMI charges synchronously (no redirect) — on a settled attempt, navigate
  // straight to confirmation the same way the zero-due 'paid' phase does.
  const onGatewaySuccess$ = $(async () => {
    isOrderProcessing.value = false;
    const rt = srState.receiptToken ? `?rt=${encodeURIComponent(srState.receiptToken)}` : '';
    navigate(`/checkout/confirmation/${srState.code}${rt}`);
  });

  return (
    <>
    {srState.quoteChange && confirmedQuoteHash.value !== srState.quoteChange.quoteHash && (
      <section role="alert" aria-label="Updated checkout quote" class="mx-auto max-w-3xl p-4 border rounded-sm space-y-3">
        <p>Your total changed. Review updated amounts before placing your order.</p>
        <dl class="space-y-1">
          <div class="flex justify-between gap-4"><dt>Discount</dt><dd>{formatCents(srState.quoteChange.quote.discountTotal)}</dd></div>
          <div class="flex justify-between gap-4"><dt>Shipping</dt><dd>{formatCents(srState.quoteChange.quote.shippingTotal)}</dd></div>
          <div class="flex justify-between gap-4"><dt>Tax</dt><dd>{formatCents(srState.quoteChange.quote.taxTotal)}</dd></div>
          <div class="flex justify-between gap-4"><dt>Updated total</dt><dd>{formatCents(srState.quoteChange.quote.grandTotal)}</dd></div>
        </dl>
        <button type="button" class="btn-primary px-4 py-2" onClick$={() => {
          confirmedQuoteHash.value = srState.quoteChange?.quoteHash ?? '';
          state.error = null;
        }}>Confirm updated quote</button>
      </section>
    )}
    <CheckoutPageView
      checkoutState={checkoutState}
      checkoutValidation={checkoutValidation}
      formattedTotal={formattedTotal}
      hasMixedPreOrder={hasMixedPreOrder}
      isCartEmpty={isCartEmpty}
      isOrderProcessing={isOrderProcessing}
      localCart={localCart}
      gatewayConfirmTrigger={gatewayConfirmTrigger}
      totalConfirmed={totalConfirmed}
      onGatewaySuccess$={onGatewaySuccess$}
      onPaymentError$={onPaymentError$}
      onPaymentInitError$={onPaymentInitError$}
      onPaymentProcessingChange$={onPaymentProcessingChange$}
      onPlaceOrder$={placeOrder}
      onResumeMethod$={onResumeMethod$}
      onResumeRetry$={onResumeRetry$}
      onStartNewCart$={onStartNewCart$}
      pageLoading={pageLoading}
      paymentInit={paymentInit}
      paymentMethod={paymentMethod}
      promoExpanded={promoExpanded}
      loyalty={loyaltyView}
      onRedeemToggle$={onRedeemToggle$}
      shippingCents={shippingCents}
      showProcessingModal={showProcessingModal}
      shopConfig={shopConfig}
      srState={srState}
      state={state}
      stripeConfirmTrigger={stripeConfirmTrigger}
      stripePublishableKey={stripePublishableKey}
    />
    </>

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

export { head } from '~/platform/checkout';
