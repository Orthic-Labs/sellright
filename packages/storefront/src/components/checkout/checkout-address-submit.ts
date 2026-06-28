import type { QRL, Signal } from '@qwik.dev/core';
import {
  getActiveOrderQuery,
  setOrderBillingAddressMutation,
  setOrderShippingAddressMutation,
  setOrderShippingMethodMutation,
  setCustomerForOrderMutation,
} from '~/providers/shop/orders/order';
import {
  getActiveCustomerCached,
  getActiveCustomerAddressesQuery,
  createCustomerAddressMutation as createCustomerAddress,
  updateCustomerAddressMutation as updateCustomerAddress,
} from '~/providers/shop/customer/customer';
import type { Order } from '~/generated/graphql-shop';

type SubmitCheckoutAddressesOptions = {
  appState: any;
  checkoutAddressState: any;
  useDifferentBilling: Signal<boolean>;
  isLoading: Signal<boolean>;
  addressSubmissionInProgress: Signal<boolean>;
  addressSubmissionComplete: Signal<boolean>;
  error: Signal<string>;
  hasProceeded: Signal<boolean>;
  onAddressesSubmitted$?: QRL<() => void>;
};

export async function submitCheckoutAddresses(options: SubmitCheckoutAddressesOptions): Promise<void> {
  const {
    appState,
    checkoutAddressState,
    useDifferentBilling,
    isLoading,
    addressSubmissionInProgress,
    addressSubmissionComplete,
    error,
    hasProceeded,
    onAddressesSubmitted$,
  } = options;

    try {
      addressSubmissionInProgress.value = true;
      isLoading.value = true;

      // Update the new context
      checkoutAddressState.addressSubmissionInProgress = true;
      
      // Sync customer data to appState before submission since we removed the automatic sync
      const customerForSync = {
        firstName: appState.customer?.firstName || '',
        lastName: appState.customer?.lastName || '',
        emailAddress: appState.customer?.emailAddress || '',
        phoneNumber: appState.shippingAddress?.phoneNumber || '',
        id: appState.customer?.id || '',
        title: appState.customer?.title || '',
      };
      appState.customer = { ...customerForSync };
      // console.log('[CheckoutAddresses] Syncing customer data to appState for submission');

      // Set addresses and customer info on Vendure order if one exists
      // If we have a Vendure order, it needs proper setup
      if (appState.activeOrder) {
        // First check if customer is already authenticated
        const activeCustomer = await getActiveCustomerCached();
          
          if (activeCustomer) {
            // console.log('Customer is already authenticated:', activeCustomer.emailAddress);
            // Customer is logged in - verify the order has the customer association
            const latestOrder = await getActiveOrderQuery();
            if (latestOrder) {
              appState.activeOrder = latestOrder as Order;
              if (latestOrder.customer) {
                // console.log('✅ Authenticated customer order confirmed:', latestOrder.customer.emailAddress);
              } else {
                // console.log('⚠️ Order exists but no customer association found - this is unusual for authenticated users');
              }
            }
          } else {
            // No authenticated customer - check if order already has customer (guest checkout)
            const latestOrderBeforeCustomerSet = await getActiveOrderQuery();
            if (latestOrderBeforeCustomerSet && latestOrderBeforeCustomerSet.customer) {
              // console.log('Active order already has a customer associated:', latestOrderBeforeCustomerSet.customer.emailAddress);
              appState.activeOrder = latestOrderBeforeCustomerSet as Order;
              // console.log('Skipping setCustomerForOrderMutation as customer is already set for this order.');
            } else {
              // Guest checkout - set customer for order
              const customerData = {
                emailAddress: appState.customer.emailAddress || '',
                firstName: appState.customer.firstName || '',
                lastName: appState.customer.lastName || '',
                phoneNumber: appState.shippingAddress.phoneNumber || '',
              };
              // console.log('Attempting to set customer for order (guest checkout) with data:', customerData);
              const customerResult = await setCustomerForOrderMutation(customerData);

              if (customerResult.__typename === 'Order') {
                // console.log('Successfully set customer for order');
                appState.activeOrder = customerResult as Order;
              } else if (customerResult.__typename === 'EmailAddressConflictError') {
                // Guest checkout with existing customer email - automatically link the order
                // console.log('EmailAddressConflictError: Guest order automatically linked to existing customer account:', customerResult.message);
                // The order should be automatically linked, so we continue with the flow
                // Fetch the updated order to get the linked customer information
                const updatedOrder = await getActiveOrderQuery();
                if (updatedOrder) {
                  appState.activeOrder = updatedOrder as Order;
                  // console.log('Order successfully linked to existing customer:', updatedOrder.customer?.emailAddress);
                }
              } else if (customerResult.__typename === 'AlreadyLoggedInError') {
                // User is already logged in, no need to set customer again
                // console.log('Customer already logged in, skipping customer setup:', customerResult.message);
                const updatedOrder = await getActiveOrderQuery();
                if (updatedOrder) {
                  appState.activeOrder = updatedOrder as Order;
                }
              } else if (customerResult.__typename === 'GuestCheckoutError') {
                // Guest checkout not allowed by configuration
                // console.error('Guest checkout not allowed:', customerResult.message);
                throw new Error('Guest checkout is not enabled. Please create an account or log in to continue.');
              } else if (customerResult.__typename === 'NoActiveOrderError') {
                // No active order exists
                // console.error('No active order found when setting customer:', customerResult.message);
                throw new Error('No active order found. Please restart your checkout process.');
              } else {
                // console.error('Unexpected error setting customer for order. Result:', JSON.stringify(customerResult, null, 2));
                throw new Error('Failed to set customer for order: ' + (customerResult as any).message || 'Unknown error');
              }
            }
          }

        // Check for active order before attempting address mutations
        const latestOrderBeforeMutations = await getActiveOrderQuery();
        if (!latestOrderBeforeMutations || !latestOrderBeforeMutations.id) {
          // console.error('❌ No active order found before setting addresses. Order state:', latestOrderBeforeMutations);
          throw new Error('No active order found. Please retry the checkout process.');
        }
        appState.activeOrder = latestOrderBeforeMutations; // Update appState with the latest order data
        // console.log('✅ Active order confirmed before address mutations:', latestOrderBeforeMutations.code);

        // Ensure country code is defined before proceeding
        if (!appState.shippingAddress.countryCode) {
          throw new Error('Country code is required for shipping address');
        }

        // Prepare address inputs for parallel processing
        const shippingAddressInput = {
          fullName: `${appState.customer.firstName || ''} ${appState.customer.lastName || ''}`.trim(),
          streetLine1: appState.shippingAddress.streetLine1 || '',
          streetLine2: appState.shippingAddress.streetLine2 || '',
          city: appState.shippingAddress.city || '',
          province: appState.shippingAddress.province || '',
          postalCode: appState.shippingAddress.postalCode || '',
          countryCode: appState.shippingAddress.countryCode,
          phoneNumber: appState.shippingAddress.phoneNumber || '',
          company: appState.shippingAddress.company || ''
        };

        let billingAddressInput = undefined;
        if (useDifferentBilling.value) {
          // Ensure country code is defined for billing address
          if (!appState.billingAddress.countryCode) {
            throw new Error('Country code is required for billing address');
          }
          
          billingAddressInput = {
            fullName: `${appState.billingAddress.firstName || ''} ${appState.billingAddress.lastName || ''}`.trim(),
            streetLine1: appState.billingAddress.streetLine1 || '',
            streetLine2: appState.billingAddress.streetLine2 || '',
            city: appState.billingAddress.city || '',
            province: appState.billingAddress.province || '',
            postalCode: appState.billingAddress.postalCode || '',
            countryCode: appState.billingAddress.countryCode || '',
          };
        }

        const shippingResult = await setOrderShippingAddressMutation(shippingAddressInput);
        if (shippingResult.__typename !== 'Order') {
          throw new Error('Failed to set shipping address');
        }
        appState.activeOrder = shippingResult as Order;

        if (billingAddressInput) {
          const billingResult = await setOrderBillingAddressMutation(billingAddressInput);
          if (billingResult.__typename === 'Order') {
            appState.activeOrder = billingResult as Order;
          }
        }

        const shippingMethodId = (shippingAddressInput.countryCode === 'US' || shippingAddressInput.countryCode === 'PR')
          ? ((appState.activeOrder?.subTotalWithTax || 0) >= 10000 ? '6' : '3')
          : '7';
        appState.activeOrder = await setOrderShippingMethodMutation([shippingMethodId]);

        if (!appState.activeOrder) {
          throw new Error('Failed to set shipping method');
        }
        if (activeCustomer) {
          try {
            const customerAddresses = await getActiveCustomerAddressesQuery();
            const defaultShipping = customerAddresses?.addresses?.find((a) => a.defaultShippingAddress);

            const shippingAddressInput = {
              fullName: `${appState.customer.firstName || ''} ${appState.customer.lastName || ''}`.trim(),
              streetLine1: appState.shippingAddress.streetLine1 || '',
              streetLine2: appState.shippingAddress.streetLine2 || '',
              city: appState.shippingAddress.city || '',
              province: appState.shippingAddress.province || '',
              postalCode: appState.shippingAddress.postalCode || '',
              countryCode: appState.shippingAddress.countryCode || '',
              phoneNumber: appState.shippingAddress.phoneNumber || '',
              company: appState.shippingAddress.company || '',
              defaultShippingAddress: true,
              defaultBillingAddress: !useDifferentBilling.value,
            };

            if (defaultShipping) {
              await updateCustomerAddress({
                id: defaultShipping.id,
                ...shippingAddressInput
              }, undefined);
            } else {
              const shippingAddressResult = await createCustomerAddress(shippingAddressInput, undefined);
              if (shippingAddressResult.createCustomerAddress.__typename !== 'Address') {
                console.error('Failed to create customer shipping address', shippingAddressResult);
              }
            }

            if (useDifferentBilling.value) {
              const defaultBilling = customerAddresses?.addresses?.find((a) => a.defaultBillingAddress);
              const billingAddressInput = {
                fullName: `${appState.billingAddress.firstName || ''} ${appState.billingAddress.lastName || ''}`.trim(),
                streetLine1: appState.billingAddress.streetLine1 || '',
                streetLine2: appState.billingAddress.streetLine2 || '',
                city: appState.billingAddress.city || '',
                province: appState.billingAddress.province || '',
                postalCode: appState.billingAddress.postalCode || '',
                countryCode: appState.billingAddress.countryCode || '',
                defaultBillingAddress: true,
                defaultShippingAddress: false,
              };

              if (defaultBilling && defaultBilling.id !== defaultShipping?.id) {
                await updateCustomerAddress({
                  id: defaultBilling.id,
                  ...billingAddressInput
                }, undefined);
              } else {
                const billingAddressResult = await createCustomerAddress(billingAddressInput, undefined);

                if (billingAddressResult.createCustomerAddress.__typename !== 'Address') {
                  console.error('Failed to create customer billing address', billingAddressResult);
                }
              }
            }
          } catch (err) {
            console.error('Error creating/updating customer address:', err);
          }
        }
      } else {
        // console.log('🛒 Local cart mode: Skipping order mutations until Place Order is clicked');
      }

      // console.log('✅ All addresses set successfully');

      // ✅ SIMPLIFIED: Forms already handle persistence to sessionStorage for both guest and auth users
      // No need for duplicate saving here - addresses are already persisted by AddressForm and BillingAddressForm
      // Vendure sync will happen only during place order, not here
      // console.log('✅ Addresses submitted - already persisted by forms');

      // Notify parent component that addresses have been submitted
      if (onAddressesSubmitted$) {
        await onAddressesSubmitted$();
      }

      // Mark as complete for external coordination
      addressSubmissionComplete.value = true;
      checkoutAddressState.addressSubmissionComplete = true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'An error occurred';
      // console.error('❌ Checkout error:', err);
      hasProceeded.value = false; // Allow retry on error
    } finally {
      isLoading.value = false;
      addressSubmissionInProgress.value = false;
      checkoutAddressState.addressSubmissionInProgress = false;
    }
  
}
