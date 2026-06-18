import { $, component$, useContext, useSignal, QRL, useTask$, useOnDocument, useComputed$ } from '@qwik.dev/core';
import { APP_STATE, CUSTOMER_NOT_DEFINED_ID } from '~/constants';
import AddressForm from '~/components/address-form/AddressForm';
import BillingAddressForm from '~/components/billing-address-form/BillingAddressForm';
// LoginModal moved to parent component
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
import { Order } from '~/generated/graphql-shop';
import { validateEmail, validateName, validatePhone, filterPhoneInput, sanitizePhoneNumber } from '~/utils/validation';
import { validateBillingSection, validateCustomerSection, validateShippingSection } from '~/utils/checkout-section-validation';

import { useCheckoutValidationActions } from '~/contexts/CheckoutValidationContext';
import { useLoginModalActions } from '~/contexts/LoginModalContext';

import { useCheckoutAddressState } from '~/contexts/CheckoutAddressContext';
import { ValidationIcon } from './ValidationIcon';


// Interfaces for the component
interface CheckoutAddressesProps {
  onAddressesSubmitted$?: QRL<() => void>;
}

export const CheckoutAddresses = component$<CheckoutAddressesProps>(({ onAddressesSubmitted$ }) => {
  // ... existing hooks ...
  const appState = useContext(APP_STATE);
  const validationActions = useCheckoutValidationActions();
  const { openLoginModal } = useLoginModalActions();
  const checkoutAddressState = useCheckoutAddressState();
  const useDifferentBilling = useSignal<boolean>(false);
  const isLoading = useSignal<boolean>(false);
  const billingHasBeenActivated = useSignal<boolean>(false); // Track if billing was ever activated
  
  // Login modal state is now handled by parent component
  
  // Individual error signals like the old implementation
  const emailValidationError = useSignal<string>('');
  const emailTouched = useSignal<boolean>(false);
  const firstNameValidationError = useSignal<string>('');
  const firstNameTouched = useSignal<boolean>(false);
  const lastNameValidationError = useSignal<string>('');
  const lastNameTouched = useSignal<boolean>(false);
  const phoneValidationError = useSignal<string>('');
  const phoneTouched = useSignal<boolean>(false);
  
  // Create local signals that will be connected to our exported state
  const addressSubmissionComplete = useSignal<boolean>(false);
  const addressSubmissionInProgress = useSignal<boolean>(false);
  
  // Add back missing signals
  const error = useSignal('');
  const isFormValidSignal = useSignal(false);
  const hasProceeded = useSignal(false);
  const validationTimer = useSignal<number | null>(null);
  
  // Complete customer validation with proper phone optional logic
  // 🚨 MOVE THIS TO THE TOP TO ENSURE IT'S AVAILABLE FOR ALL TASKS
  const validateCompleteForm$ = $(() => {
    const countryCode = appState.shippingAddress.countryCode || 'US';
    
    // Get current customer data - ensure all fields are strings
    const customer = {
      firstName: appState.customer?.firstName || '',
      lastName: appState.customer?.lastName || '',
      emailAddress: appState.customer?.emailAddress || '',
      phoneNumber: appState.shippingAddress?.phoneNumber || '',
    };
    
    const customerSection = validateCustomerSection(customer, countryCode);
    const shippingSection = validateShippingSection(appState.shippingAddress);
    const billingSection: ReturnType<typeof validateBillingSection> = useDifferentBilling.value
      ? validateBillingSection(appState.billingAddress)
      : { isValid: true, errors: {} };
    // If checkbox is OFF, billing is always valid since it inherits from shipping
    
    const overallValid = customerSection.isValid && shippingSection.isValid && billingSection.isValid;

    // Update individual error signals - use empty strings for signal clearing
    emailValidationError.value = customerSection.errors.email || '';
    firstNameValidationError.value = customerSection.errors.firstName || '';
    lastNameValidationError.value = customerSection.errors.lastName || '';
    phoneValidationError.value = customerSection.errors.phone || '';
    
    // Update form valid state
    isFormValidSignal.value = overallValid;
    
    // Update the checkout validation context
    validationActions.updateCustomerValidation(
      customerSection.isValid,
      customerSection.errors,
      emailTouched.value || firstNameTouched.value || lastNameTouched.value || phoneTouched.value
    );

    validationActions.updateShippingAddressValidation(shippingSection.isValid, shippingSection.errors, true);

    validationActions.updateBillingMode(useDifferentBilling.value);
    
    if (useDifferentBilling.value) {
      validationActions.updateBillingAddressValidation(billingSection.isValid, billingSection.errors, true);
    }
    
    // Don't sync to appState here to prevent circular dependency
    // State synchronization will be handled by the form submission process
    if (overallValid) {
      // console.log('[CheckoutAddresses] Customer validation passed');
    } else {
      // console.log('[CheckoutAddresses] Customer validation failed');
    }
  });

  // Computed signal for phone placeholder - ensures immediate reactivity to country changes
  const phonePlaceholder = useComputed$(() => {
    const countryCode = appState.shippingAddress.countryCode || 'US';
    const isOptional = countryCode === 'US' || countryCode === 'PR';
    return `Phone number${isOptional ? ' (optional)' : ''}` as string;
  });

  // T25: Sync submission state to context (useTask$ — reactive, client+server)
  useTask$(({ track }) => {
    track(() => addressSubmissionComplete.value);
    track(() => addressSubmissionInProgress.value);
    checkoutAddressState.addressSubmissionComplete = addressSubmissionComplete.value;
    checkoutAddressState.addressSubmissionInProgress = addressSubmissionInProgress.value;
  });


  
  // Initialize billingAddress and handle inheritance from shipping - separated into multiple tasks to prevent conflicts
  
  // T25: Billing checkbox toggle → useTask$
  useTask$(({ track }) => {
    track(() => useDifferentBilling.value);
    
    // If billing checkbox is OFF, always inherit from shipping
    if (!useDifferentBilling.value) {
      appState.billingAddress = {
        firstName: appState.customer?.firstName || '',
        lastName: appState.customer?.lastName || '',
        streetLine1: appState.shippingAddress.streetLine1 || '',
        streetLine2: appState.shippingAddress.streetLine2 || '',
        city: appState.shippingAddress.city || '',
        province: appState.shippingAddress.province || '',
        postalCode: appState.shippingAddress.postalCode || '',
        countryCode: appState.shippingAddress.countryCode || '',
      };
      // console.log('[CheckoutAddresses] Billing address inheriting from shipping (checkbox OFF)');
    } else {
      // Checkbox is ON - handle first time activation
      if (!billingHasBeenActivated.value) {
        billingHasBeenActivated.value = true;
        // Initialize billing with only name and country from customer/shipping
        appState.billingAddress = {
          firstName: appState.customer?.firstName || '',
          lastName: appState.customer?.lastName || '',
          streetLine1: '',
          streetLine2: '',
          city: '',
          province: '',
          postalCode: '',
          countryCode: appState.shippingAddress.countryCode || '',
        };
        // console.log('[CheckoutAddresses] Billing address initialized with only name and country (checkbox first activation)');
      } else if (!appState.billingAddress) {
        // Safety check - if billing address is somehow missing, initialize it
        appState.billingAddress = {
          firstName: appState.customer?.firstName || '',
          lastName: appState.customer?.lastName || '',
          streetLine1: '',
          streetLine2: '',
          city: '',
          province: '',
          postalCode: '',
          countryCode: appState.shippingAddress.countryCode || '',
        };
        // console.log('[CheckoutAddresses] Billing address safety initialization with only name and country');
      }
      // If checkbox is ON and billing has been activated before, preserve existing billing values
      // console.log('[CheckoutAddresses] Billing address preserved (checkbox ON, previously activated)');
    }
  });
  
  // T25: Country changes → useTask$
  useTask$(({ track }) => {
    track(() => appState.shippingAddress.countryCode);
    
    // Only update billing address country if checkbox is OFF (inherit mode)
    if (!useDifferentBilling.value) {
      if (appState.billingAddress) {
        appState.billingAddress.countryCode = appState.shippingAddress.countryCode || '';
        // console.log('[CheckoutAddresses] Updated billing country to match shipping (inherit mode):', appState.billingAddress.countryCode);
      }
    }
    // If checkbox is ON, preserve user's billing country selection - don't interfere
  });
  
  // Country initialization removed - will be handled by layout.tsx or user selection

  // T25: Clear validation errors on customer update → useTask$
  useTask$(({ track }) => {
    track(() => appState.customer?.emailAddress);
    track(() => appState.customer?.firstName);
    track(() => appState.customer?.lastName);
    track(() => appState.shippingAddress?.phoneNumber);
    
    // Auto-touch and validate pre-filled fields so checkmarks appear
    if (appState.customer?.emailAddress && !emailTouched.value) {
      emailTouched.value = true;
      const result = validateEmail(appState.customer.emailAddress);
      emailValidationError.value = result.isValid ? '' : (result.message || 'Invalid email');
    }
    if (appState.customer?.firstName && !firstNameTouched.value) {
      firstNameTouched.value = true;
      const result = validateName(appState.customer.firstName, 'First name');
      firstNameValidationError.value = result.isValid ? '' : (result.message || 'Invalid name');
    }
    if (appState.customer?.lastName && !lastNameTouched.value) {
      lastNameTouched.value = true;
      const result = validateName(appState.customer.lastName, 'Last name');
      lastNameValidationError.value = result.isValid ? '' : (result.message || 'Invalid name');
    }
    if (appState.shippingAddress?.phoneNumber && !phoneTouched.value) {
      phoneTouched.value = true;
      const countryCode = appState.shippingAddress.countryCode || 'US';
      const isPhoneOptional = countryCode === 'US' || countryCode === 'PR';
      const result = validatePhone(appState.shippingAddress.phoneNumber, countryCode, isPhoneOptional);
      phoneValidationError.value = result.isValid ? '' : (result.message || 'Invalid phone');
    }
  });

  // T25: Shipping address change → useTask$
  useTask$(({ track }) => {
    // Track all shipping address fields that might change after login
    track(() => appState.shippingAddress?.streetLine1);
    track(() => appState.shippingAddress?.streetLine2);
    track(() => appState.shippingAddress?.city);
    track(() => appState.shippingAddress?.province);
    track(() => appState.shippingAddress?.postalCode);
    track(() => appState.shippingAddress?.countryCode);
    track(() => appState.shippingAddress?.phoneNumber);

    // When shipping address is populated (e.g., after login), update form validation state
    // This ensures the address fields are properly validated and the form can proceed
    if (appState.shippingAddress?.streetLine1) {
      // Mark phone as touched if it has a value from login, so validation errors show
      if (appState.shippingAddress?.phoneNumber && !phoneTouched.value) {
        phoneTouched.value = true;
        // Immediately validate the phone number with the current country
        const countryCode = appState.shippingAddress.countryCode || 'US';
        const isPhoneOptional = countryCode === 'US' || countryCode === 'PR';
        const phoneResult = validatePhone(appState.shippingAddress.phoneNumber, countryCode, isPhoneOptional);
        if (!phoneResult.isValid) {
          phoneValidationError.value = phoneResult.message || 'Invalid phone number';
        }
      }

      // Trigger validation to update the form state
      validateCompleteForm$();
    }
  });

  // T25: Main validation → useTask$
  useTask$(({ track, cleanup }) => {
    track(() => appState.shippingAddress);
    track(() => appState.shippingAddress.countryCode);
    track(() => useDifferentBilling.value);
    track(() => appState.billingAddress);
    
    // Allow validation to run immediately when address data changes
    // This ensures payment section activates as soon as shipping address is complete
    // console.log('[CheckoutAddresses] Triggering validation due to form data change');

    // 🚀 SOPHISTICATED DEBOUNCING: Use different timing based on validation type
    if (validationTimer.value) {
      clearTimeout(validationTimer.value);
    }

    const debounceTime = appState.shippingAddress ? 200 : 400;
    validationTimer.value = setTimeout(() => {
      validateCompleteForm$();
    }, debounceTime) as unknown as number;
    cleanup(() => { if (validationTimer.value) clearTimeout(validationTimer.value); });
  });

  // T25: Country change → phone re-validation → useTask$
  useTask$(({ track }) => {
    track(() => appState.shippingAddress.countryCode);

    // Immediately re-validate phone when country changes (no debounce for country changes)
    const countryCode = appState.shippingAddress.countryCode || 'US';
    const isPhoneOptional = countryCode === 'US' || countryCode === 'PR';
    const customerPhoneNumber = (appState.shippingAddress?.phoneNumber || '') as string;

    console.log(`📍 [CheckoutAddresses] Country changed to: ${countryCode}, Phone optional: ${isPhoneOptional}`);

    // Immediately re-validate phone with new country rules
    // Mark phone as touched if it has a value, so validation errors show in UI
    if (customerPhoneNumber) {
      if (!phoneTouched.value) {
        phoneTouched.value = true;
      }
      const phoneResult = validatePhone(customerPhoneNumber, countryCode, isPhoneOptional);
      phoneValidationError.value = phoneResult.isValid ? '' : (phoneResult.message || 'Invalid phone number');

      console.log(`📞 [CheckoutAddresses] Phone re-validated for ${countryCode}: ${phoneResult.isValid ? 'valid' : (phoneResult.message || 'Invalid phone number')}`);
    }

    // Address field validation now handled in AddressForm component itself

    // Trigger immediate complete validation for country changes
    validateCompleteForm$();
  });

  // Submit addresses to the API - moved before useTask$ that calls it
  const submitAddresses = $(async () => {
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
  });

  // T25: Expose submit function on qinit
  useOnDocument('qinit', $(() => {
    if (typeof window !== 'undefined') {
      (window as any).submitCheckoutAddressForm = submitAddresses;
    }
  }));

  // Individual field validation handlers - exactly like old implementation
  const handleEmailChange$ = $((value: string) => {
    appState.customer = { ...appState.customer, emailAddress: value };
    
    if (emailTouched.value) {
      const emailResult = validateEmail(value);
      if (emailResult.isValid) {
        emailValidationError.value = '';
      } else {
        emailValidationError.value = emailResult.message || 'Invalid email';
      }
    }
  });

  const handleEmailBlur$ = $(() => {
    emailTouched.value = true;
    const emailResult = validateEmail(appState.customer?.emailAddress || '');
    if (emailResult.isValid) {
      emailValidationError.value = '';
    } else {
      emailValidationError.value = emailResult.message || 'Invalid email';
    }
  });

  const handleFirstNameChange$ = $((value: string) => {
    appState.customer = { ...appState.customer, firstName: value };
    
    if (firstNameTouched.value) {
      const nameResult = validateName(value, 'First name');
      if (nameResult.isValid) {
        firstNameValidationError.value = '';
      } else {
        firstNameValidationError.value = nameResult.message || 'Invalid first name';
      }
    }
  });

  const handleFirstNameBlur$ = $(() => {
    firstNameTouched.value = true;
    const nameResult = validateName(appState.customer?.firstName || '', 'First name');
    if (nameResult.isValid) {
      firstNameValidationError.value = '';
    } else {
      firstNameValidationError.value = nameResult.message || 'Invalid first name';
    }
  });

  const handleLastNameChange$ = $((value: string) => {
    appState.customer = { ...appState.customer, lastName: value };
    
    if (lastNameTouched.value) {
      const nameResult = validateName(value, 'Last name');
      if (nameResult.isValid) {
        lastNameValidationError.value = '';
      } else {
        lastNameValidationError.value = nameResult.message || 'Invalid last name';
      }
    }
  });

  const handleLastNameBlur$ = $(() => {
    lastNameTouched.value = true;
    const nameResult = validateName(appState.customer?.lastName || '', 'Last name');
    if (nameResult.isValid) {
      lastNameValidationError.value = '';
    } else {
      lastNameValidationError.value = nameResult.message || 'Invalid last name';
    }
  });

  const handlePhoneChange$ = $((value: string) => {
    // Filter input to only allow valid phone characters
    const filteredValue = filterPhoneInput(sanitizePhoneNumber(value));
    appState.shippingAddress = { ...appState.shippingAddress, phoneNumber: filteredValue };

    if (phoneTouched.value) {
      const countryCode = appState.shippingAddress.countryCode || 'US';
      const isPhoneOptional = countryCode === 'US' || countryCode === 'PR';
      const phoneResult = validatePhone(filteredValue, countryCode, isPhoneOptional);
      if (phoneResult.isValid) {
        phoneValidationError.value = '';
      } else {
        phoneValidationError.value = phoneResult.message || 'Invalid phone number';
      }
    }
  });

  const handlePhoneBlur$ = $(() => {
    phoneTouched.value = true;
    const phoneNumber = appState.shippingAddress?.phoneNumber || '';
    const countryCode = appState.shippingAddress.countryCode || 'US';
    const isPhoneOptional = countryCode === 'US' || countryCode === 'PR';
    const phoneResult = validatePhone(phoneNumber, countryCode, isPhoneOptional);
    if (phoneResult.isValid) {
      phoneValidationError.value = '';
    } else {
      phoneValidationError.value = phoneResult.message || 'Invalid phone number';
    }
  });

  // Auto-validation removed - validation will only occur on user interaction
  
  return (
    <div class="space-y-4 CheckoutAddresses">
      {/* Error Display */}
      {error.value && (
        <div class="p-4 bg-red-50 border border-red-200 rounded-md">
          <p class="text-sm text-red-800">{error.value}</p>
        </div>
      )}

      {/* Title with Clean Sign-in Option */}
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-[30px] leading-none md:text-[34px] font-heading font-normal tracking-wide text-[#1A1A1A] flex-1 text-center md:text-left md:flex-none">
          Shipping Details
        </h3>

        {/* Simple Login Option for Guest Users */}
        {appState.customer?.id === CUSTOMER_NOT_DEFINED_ID && (
          <div class="flex items-center text-sm">
            <span class="text-gray-600 mr-2">Have an account?</span>
            <button
              onClick$={$(() => openLoginModal())}
              class="text-[#8a6d4a] hover:text-[#4F3B26] font-medium transition-colors underline cursor-pointer"
            >
              Sign in
            </button>
          </div>
        )}
      </div>
      
      {/* Customer Information - Direct implementation without title */}
      <section>
        <div class="space-y-4">
          {/* Email and Phone side-by-side */}
          <div class="grid grid-cols-2 gap-4">
            <div class="relative">
              <input
                type="email"
                value={appState.customer?.emailAddress}
                placeholder="Email address"
                onChange$={(_, el) => handleEmailChange$(el.value)}
                onBlur$={handleEmailBlur$}
                class={`block w-full px-[14px] py-[11px] pr-10 text-[16px] rounded-[3px] border placeholder:text-[rgba(100,85,65,0.42)] focus:outline-hidden transition-colors duration-200 bg-white ${
                  emailTouched.value && emailValidationError.value
                    ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                    : 'border-[rgba(140,107,58,0.18)] focus:border-[rgba(140,107,58,0.4)] focus:ring-[rgba(140,107,58,0.25)]'
                }`}
              />
              <ValidationIcon
                touched={emailTouched.value}
                error={emailValidationError.value}
                valid={emailTouched.value && !emailValidationError.value && !!(appState.customer?.emailAddress)}
              />
            </div>
            <div class="relative">
              <input
                type="tel"
                value={sanitizePhoneNumber(appState.shippingAddress?.phoneNumber)}
                placeholder={phonePlaceholder.value}
                onChange$={(_, el) => handlePhoneChange$(el.value)}
                onBlur$={handlePhoneBlur$}
                class={`block w-full px-[14px] py-[11px] pr-10 text-[16px] rounded-[3px] border placeholder:text-[rgba(100,85,65,0.42)] focus:outline-hidden transition-colors duration-200 bg-white ${
                  phoneTouched.value && phoneValidationError.value
                    ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                    : 'border-[rgba(140,107,58,0.18)] focus:border-[rgba(140,107,58,0.4)] focus:ring-[rgba(140,107,58,0.25)]'
                }`}
              />
              <ValidationIcon
                touched={phoneTouched.value}
                error={phoneValidationError.value}
                valid={phoneTouched.value && !phoneValidationError.value && !!(appState.shippingAddress?.phoneNumber)}
              />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="relative">
              <input
                type="text"
                value={appState.customer?.firstName}
                placeholder="First name"
                onChange$={(_, el) => handleFirstNameChange$(el.value)}
                onBlur$={handleFirstNameBlur$}
                class={`block w-full px-[14px] py-[11px] pr-10 text-[16px] rounded-[3px] border placeholder:text-[rgba(100,85,65,0.42)] focus:outline-hidden transition-colors duration-200 bg-white ${
                  firstNameTouched.value && firstNameValidationError.value
                    ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                    : 'border-[rgba(140,107,58,0.18)] focus:border-[rgba(140,107,58,0.4)] focus:ring-[rgba(140,107,58,0.25)]'
                }`}
              />
              <ValidationIcon
                touched={firstNameTouched.value}
                error={firstNameValidationError.value}
                valid={firstNameTouched.value && !firstNameValidationError.value && !!(appState.customer?.firstName)}
              />
            </div>

            <div class="relative">
              <input
                type="text"
                value={appState.customer?.lastName}
                placeholder="Last name"
                onChange$={(_, el) => handleLastNameChange$(el.value)}
                onBlur$={handleLastNameBlur$}
                class={`block w-full px-[14px] py-[11px] pr-10 text-[16px] rounded-[3px] border placeholder:text-[rgba(100,85,65,0.42)] focus:outline-hidden transition-colors duration-200 bg-white ${
                  lastNameTouched.value && lastNameValidationError.value
                    ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                    : 'border-[rgba(140,107,58,0.18)] focus:border-[rgba(140,107,58,0.4)] focus:ring-[rgba(140,107,58,0.25)]'
                }`}
              />
              <ValidationIcon
                touched={lastNameTouched.value}
                error={lastNameValidationError.value}
                valid={lastNameTouched.value && !lastNameValidationError.value && !!(appState.customer?.lastName)}
              />
            </div>
          </div>
        </div>
      </section>

      {/* Shipping Address */}
      <section>
        <AddressForm 
          shippingAddress={appState.shippingAddress}
          isReviewMode={false}
        />
      </section>

      {/* Billing Toggle */}
      <section>
        <button
          type="button"
          onClick$={$(() => {
            const next = !useDifferentBilling.value;
            useDifferentBilling.value = next;
            if (!next) {
              billingHasBeenActivated.value = false;
            }
            // validation runs automatically via useVisibleTask$ tracking useDifferentBilling.value
          })}
          class="inline-flex items-center gap-2 py-1 text-[13px] text-[rgba(100,85,65,0.6)] hover:text-[rgba(100,85,65,0.9)] transition-colors cursor-pointer bg-transparent border-none mb-0"
        >
          <span>Use different billing address</span>
          <svg
            class={`w-4 h-4 text-[rgba(100,85,65,0.4)] transition-transform duration-200 ${useDifferentBilling.value ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* Billing Address Form — smooth reveal */}
        <div
          class="grid transition-all duration-400 ease-out"
          style={{
            gridTemplateRows: useDifferentBilling.value ? '1fr' : '0fr',
            opacity: useDifferentBilling.value ? '1' : '0',
          }}
        >
          <div class="overflow-hidden">
            <div class="mt-4">
              <BillingAddressForm
                billingAddress={appState.billingAddress || {
                  firstName: appState.customer?.firstName || '',
                  lastName: appState.customer?.lastName || '',
                  streetLine1: '',
                  streetLine2: '',
                  city: '',
                  province: '',
                  postalCode: '',
                  countryCode: appState.shippingAddress.countryCode || '',
                }}
              />
            </div>
          </div>
        </div>
      </section>

      {/* LoginModal moved to parent checkout component for proper full-screen rendering */}
      

    </div>
  );
});

export default CheckoutAddresses;
