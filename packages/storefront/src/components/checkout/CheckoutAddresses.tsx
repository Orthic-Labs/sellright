import { $, component$, useContext, useSignal, QRL, useTask$, useOnDocument, useComputed$ } from '@qwik.dev/core';
import { APP_STATE } from '~/constants';
import { submitCheckoutAddresses } from './checkout-address-submit';
import { validateEmail, validateName, validatePhone, filterPhoneInput, sanitizePhoneNumber } from '~/utils/validation';
import { validateBillingSection, validateCustomerSection, validateShippingSection } from '~/utils/checkout-section-validation';
import { useCheckoutValidationActions } from '~/contexts/CheckoutValidationContext';
import { useLoginModalActions } from '~/contexts/LoginModalContext';
import { useCheckoutAddressState } from '~/contexts/CheckoutAddressContext';
import { CheckoutAddressesView } from './CheckoutAddressesView';
interface CheckoutAddressesProps {
  onAddressesSubmitted$?: QRL<() => void>;
}
export const CheckoutAddresses = component$<CheckoutAddressesProps>(({ onAddressesSubmitted$ }) => {
  const appState = useContext(APP_STATE);
  const validationActions = useCheckoutValidationActions();
  const { openLoginModal } = useLoginModalActions();
  const checkoutAddressState = useCheckoutAddressState();
  const useDifferentBilling = useSignal<boolean>(false);
  const isLoading = useSignal<boolean>(false);
  const billingHasBeenActivated = useSignal<boolean>(false); // Track if billing was ever activated
  const emailValidationError = useSignal<string>('');
  const emailTouched = useSignal<boolean>(false);
  const firstNameValidationError = useSignal<string>('');
  const firstNameTouched = useSignal<boolean>(false);
  const lastNameValidationError = useSignal<string>('');
  const lastNameTouched = useSignal<boolean>(false);
  const phoneValidationError = useSignal<string>('');
  const phoneTouched = useSignal<boolean>(false);
  const addressSubmissionComplete = useSignal<boolean>(false);
  const addressSubmissionInProgress = useSignal<boolean>(false);
  const error = useSignal('');
  const isFormValidSignal = useSignal(false);
  const hasProceeded = useSignal(false);
  const validationTimer = useSignal<number | null>(null);
  const validateCompleteForm$ = $(() => {
    const countryCode = appState.shippingAddress.countryCode || 'US';
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
    const overallValid = customerSection.isValid && shippingSection.isValid && billingSection.isValid;
    emailValidationError.value = customerSection.errors.email || '';
    firstNameValidationError.value = customerSection.errors.firstName || '';
    lastNameValidationError.value = customerSection.errors.lastName || '';
    phoneValidationError.value = customerSection.errors.phone || '';
    isFormValidSignal.value = overallValid;
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
  });
  const phonePlaceholder = useComputed$(() => {
    const countryCode = appState.shippingAddress.countryCode || 'US';
    const isOptional = countryCode === 'US' || countryCode === 'PR';
    return `Phone number${isOptional ? ' (optional)' : ''}` as string;
  });
  useTask$(({ track }) => {
    track(() => addressSubmissionComplete.value);
    track(() => addressSubmissionInProgress.value);
    checkoutAddressState.addressSubmissionComplete = addressSubmissionComplete.value;
    checkoutAddressState.addressSubmissionInProgress = addressSubmissionInProgress.value;
  });
  useTask$(({ track }) => {
    track(() => useDifferentBilling.value);
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
    } else {
      if (!billingHasBeenActivated.value) {
        billingHasBeenActivated.value = true;
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
      } else if (!appState.billingAddress) {
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
      }
    }
  });
  useTask$(({ track }) => {
    track(() => appState.shippingAddress.countryCode);
    if (!useDifferentBilling.value) {
      if (appState.billingAddress) {
        appState.billingAddress.countryCode = appState.shippingAddress.countryCode || '';
      }
    }
  });
  useTask$(({ track }) => {
    track(() => appState.customer?.emailAddress);
    track(() => appState.customer?.firstName);
    track(() => appState.customer?.lastName);
    track(() => appState.shippingAddress?.phoneNumber);
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
  useTask$(({ track }) => {
    track(() => appState.shippingAddress?.streetLine1);
    track(() => appState.shippingAddress?.streetLine2);
    track(() => appState.shippingAddress?.city);
    track(() => appState.shippingAddress?.province);
    track(() => appState.shippingAddress?.postalCode);
    track(() => appState.shippingAddress?.countryCode);
    track(() => appState.shippingAddress?.phoneNumber);
    if (appState.shippingAddress?.streetLine1) {
      if (appState.shippingAddress?.phoneNumber && !phoneTouched.value) {
        phoneTouched.value = true;
        const countryCode = appState.shippingAddress.countryCode || 'US';
        const isPhoneOptional = countryCode === 'US' || countryCode === 'PR';
        const phoneResult = validatePhone(appState.shippingAddress.phoneNumber, countryCode, isPhoneOptional);
        if (!phoneResult.isValid) {
          phoneValidationError.value = phoneResult.message || 'Invalid phone number';
        }
      }
      validateCompleteForm$();
    }
  });
  useTask$(({ track, cleanup }) => {
    track(() => appState.shippingAddress);
    track(() => appState.shippingAddress.countryCode);
    track(() => useDifferentBilling.value);
    track(() => appState.billingAddress);
    if (validationTimer.value) {
      clearTimeout(validationTimer.value);
    }
    const debounceTime = appState.shippingAddress ? 200 : 400;
    validationTimer.value = setTimeout(() => {
      validateCompleteForm$();
    }, debounceTime) as unknown as number;
    cleanup(() => { if (validationTimer.value) clearTimeout(validationTimer.value); });
  });
  useTask$(({ track }) => {
    track(() => appState.shippingAddress.countryCode);
    const countryCode = appState.shippingAddress.countryCode || 'US';
    const isPhoneOptional = countryCode === 'US' || countryCode === 'PR';
    const customerPhoneNumber = (appState.shippingAddress?.phoneNumber || '') as string;
    console.log(`📍 [CheckoutAddresses] Country changed to: ${countryCode}, Phone optional: ${isPhoneOptional}`);
    if (customerPhoneNumber) {
      if (!phoneTouched.value) {
        phoneTouched.value = true;
      }
      const phoneResult = validatePhone(customerPhoneNumber, countryCode, isPhoneOptional);
      phoneValidationError.value = phoneResult.isValid ? '' : (phoneResult.message || 'Invalid phone number');
      console.log(`📞 [CheckoutAddresses] Phone re-validated for ${countryCode}: ${phoneResult.isValid ? 'valid' : (phoneResult.message || 'Invalid phone number')}`);
    }
    validateCompleteForm$();
  });
  const submitAddresses = $(async () => {
    await submitCheckoutAddresses({
      appState,
      checkoutAddressState,
      useDifferentBilling,
      isLoading,
      addressSubmissionInProgress,
      addressSubmissionComplete,
      error,
      hasProceeded,
      onAddressesSubmitted$,
    });
  });
  useOnDocument('qinit', $(() => {
    if (typeof window !== 'undefined') {
      (window as any).submitCheckoutAddressForm = submitAddresses;
    }
  }));
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
  return (
    <CheckoutAddressesView
      appState={appState}
      error={error}
      openLoginModal={openLoginModal}
      phonePlaceholder={phonePlaceholder}
      useDifferentBilling={useDifferentBilling}
      billingHasBeenActivated={billingHasBeenActivated}
      emailValidationError={emailValidationError}
      emailTouched={emailTouched}
      firstNameValidationError={firstNameValidationError}
      firstNameTouched={firstNameTouched}
      lastNameValidationError={lastNameValidationError}
      lastNameTouched={lastNameTouched}
      phoneValidationError={phoneValidationError}
      phoneTouched={phoneTouched}
      handleEmailChange$={handleEmailChange$}
      handleEmailBlur$={handleEmailBlur$}
      handlePhoneChange$={handlePhoneChange$}
      handlePhoneBlur$={handlePhoneBlur$}
      handleFirstNameChange$={handleFirstNameChange$}
      handleFirstNameBlur$={handleFirstNameBlur$}
      handleLastNameChange$={handleLastNameChange$}
      handleLastNameBlur$={handleLastNameBlur$}
    />
  );
});
export default CheckoutAddresses;
