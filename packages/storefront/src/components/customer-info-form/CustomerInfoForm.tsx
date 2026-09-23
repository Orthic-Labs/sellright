import { $, QRL, component$, useContext, useSignal, useTask$ } from '@qwik.dev/core';
import { APP_STATE, CUSTOMER_NOT_DEFINED_ID } from '~/constants';
import { validateEmail, validateName, validatePhone, filterPhoneInput, sanitizePhoneNumber } from '~/utils/validation';

export interface CustomerInfoErrors {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface CustomerInfoFormProps {
  updateValidity?: QRL<(isValid: boolean) => void>;
}

// Export a proper validation function that checks actual customer fields
export const validateCustomerInfo = $((customer?: any, shippingCountryCode?: string) => {
  if (!customer) return false;
  
  // Validate email
  const emailResult = validateEmail(customer.emailAddress || '');
  
  // Validate first name
  const firstNameResult = validateName(customer.firstName || '');
  
  // Validate last name
  const lastNameResult = validateName(customer.lastName || '');
  
  // Validate phone - required for international orders, optional for US/PR
  const isUSorPR = shippingCountryCode === 'US' || shippingCountryCode === 'PR';
  const phoneResult = validatePhone(customer.phoneNumber || '', shippingCountryCode || 'US', isUSorPR);
  
  // Overall form validity
  return emailResult.isValid && 
         firstNameResult.isValid && 
         lastNameResult.isValid && 
         phoneResult.isValid;
});

export const CustomerInfoForm = component$<CustomerInfoFormProps>(({ updateValidity }) => {
  const appState = useContext(APP_STATE);
  
  // Validation signals
  const emailValidationError = useSignal<string>('');
  const emailTouched = useSignal(false);
  const firstNameValidationError = useSignal<string>('');
  const firstNameTouched = useSignal(false);
  const lastNameValidationError = useSignal<string>('');
  const lastNameTouched = useSignal(false);
  const phoneValidationError = useSignal<string>('');
  const phoneTouched = useSignal(false);
  
  // Form validation state - exported for parent component
  const isValid = useSignal(false);
  
  // Single, consistent validation function
  const validateCustomerForm = $(() => {
    if (!appState.customer) return false;
    
    // Validate email
    const emailResult = validateEmail(appState.customer.emailAddress || '');
    emailValidationError.value = emailResult.isValid ? '' : emailResult.message || 'Invalid email';
    
    // Validate first name
    const firstNameResult = validateName(appState.customer.firstName || '');
    firstNameValidationError.value = firstNameResult.isValid ? '' : firstNameResult.message || 'First name is required';
    
    // Validate last name
    const lastNameResult = validateName(appState.customer.lastName || '');
    lastNameValidationError.value = lastNameResult.isValid ? '' : lastNameResult.message || 'Last name is required';
    
    // Validate phone - required for international orders, optional for US/PR
    const isUSorPR = appState.shippingAddress.countryCode === 'US' || appState.shippingAddress.countryCode === 'PR';
    const phoneResult = validatePhone(appState.customer.phoneNumber || '', appState.shippingAddress.countryCode || 'US', isUSorPR);
    phoneValidationError.value = phoneResult.isValid ? '' : phoneResult.message || 'Invalid phone number';
    
    // Update overall form validity
    isValid.value = emailResult.isValid && firstNameResult.isValid && lastNameResult.isValid && phoneResult.isValid;
    
    // Notify parent component of validation state change
    if (updateValidity) {
      updateValidity(isValid.value);
    }
    
    return isValid.value;
  });
  
  // Validate form fields when inputs change and have already been touched
  useTask$(({ track }) => {
    track(() => appState.customer?.emailAddress);
    track(() => appState.customer?.firstName);
    track(() => appState.customer?.lastName);
    track(() => appState.customer?.phoneNumber);
    track(() => appState.shippingAddress.countryCode);
    
    if (emailTouched.value || firstNameTouched.value || lastNameTouched.value || phoneTouched.value) {
      validateCustomerForm();
    }
  });
  
  // Mark phone as touched if it has a value from login/prefill, so validation errors show
  useTask$(({ track }) => {
    track(() => appState.customer?.phoneNumber);
    
    if (appState.customer?.phoneNumber && !phoneTouched.value) {
      phoneTouched.value = true;
      // Immediately validate the phone number with the current country
      const countryCode = appState.shippingAddress.countryCode || 'US';
      const isPhoneOptional = countryCode === 'US' || countryCode === 'PR';
      const phoneResult = validatePhone(appState.customer.phoneNumber, countryCode, isPhoneOptional);
      if (!phoneResult.isValid) {
        phoneValidationError.value = phoneResult.message || 'Invalid phone number';
      }
    }
  });
  
  // Notify parent of validation status changes
  useTask$(({ track }) => {
    track(() => isValid.value);
    if (updateValidity) {
      updateValidity(isValid.value);
    }
  });

  // Simplified input handlers
  const handleEmailChange$ = $((value: string) => {
    if (!appState.customer) {
      appState.customer = { id: CUSTOMER_NOT_DEFINED_ID, emailAddress: '', firstName: '', lastName: '', phoneNumber: '' };
    }
    appState.customer.emailAddress = value;
  });

  const handleFirstNameChange$ = $((value: string) => {
    if (!appState.customer) {
      appState.customer = { id: CUSTOMER_NOT_DEFINED_ID, firstName: '', lastName: '', emailAddress: '', phoneNumber: '' };
    }
    appState.customer.firstName = value;
  });

  const handleLastNameChange$ = $((value: string) => {
    if (!appState.customer) {
      appState.customer = { id: CUSTOMER_NOT_DEFINED_ID, lastName: '', firstName: '', emailAddress: '', phoneNumber: '' };
    }
    appState.customer.lastName = value;
  });

  const handlePhoneChange$ = $((value: string) => {
    if (!appState.customer) {
      appState.customer = { id: CUSTOMER_NOT_DEFINED_ID, phoneNumber: '', firstName: '', lastName: '', emailAddress: '' };
    }
    // Filter input to only allow valid phone characters
    const filteredValue = filterPhoneInput(sanitizePhoneNumber(value));
    appState.customer.phoneNumber = filteredValue;
  });

  // Mark fields as touched on blur and run validation
  const handleEmailBlur$ = $(() => {
    emailTouched.value = true;
    validateCustomerForm();
  });

  const handleFirstNameBlur$ = $(() => {
    firstNameTouched.value = true;
    validateCustomerForm();
  });

  const handleLastNameBlur$ = $(() => {
    lastNameTouched.value = true;
    validateCustomerForm();
  });

  const handlePhoneBlur$ = $(() => {
    phoneTouched.value = true;
    validateCustomerForm();
  });

  return (
    <div>
      <form class="space-y-3">
        {/* Email and Phone side-by-side */}
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <input
              type="email"
              id="customer-info-email"
              value={appState.customer?.emailAddress}
              disabled={appState.customer?.id !== CUSTOMER_NOT_DEFINED_ID}
              placeholder="Email address *"
              onChange$={(_, el) => handleEmailChange$(el.value)}
              onBlur$={handleEmailBlur$}
              aria-invalid={!!(emailTouched.value && emailValidationError.value)}
              aria-describedby={emailTouched.value && emailValidationError.value ? 'customer-info-email-error' : undefined}
              class={`block w-full rounded-md shadow-xs sm:text-sm transition-colors duration-200 ${
                emailTouched.value && emailValidationError.value
                  ? 'border-red-300 focus:ring-red-500 focus:border-red-500'
                  : 'border-gray-300 focus:ring-primary-500 focus:border-primary-500'
              }`}
            />
            {emailTouched.value && emailValidationError.value && (
              <p id="customer-info-email-error" role="alert" class="mt-1 text-sm text-red-600">{emailValidationError.value}</p>
            )}
          </div>
          <div>
            <input
              type="tel"
              id="customer-info-phone"
              value={sanitizePhoneNumber(appState.customer?.phoneNumber)}
              placeholder={`Phone number${(appState.shippingAddress.countryCode === 'US' || appState.shippingAddress.countryCode === 'PR') ? ' (optional)' : ' *'}`}
              onChange$={(_, el) => handlePhoneChange$(el.value)}
              onBlur$={handlePhoneBlur$}
              aria-invalid={!!(phoneTouched.value && phoneValidationError.value)}
              aria-describedby={phoneTouched.value && phoneValidationError.value ? 'customer-info-phone-error' : undefined}
              class={`block w-full rounded-md shadow-xs sm:text-sm transition-colors duration-200 ${
                phoneTouched.value && phoneValidationError.value
                  ? 'border-red-300 focus:ring-red-500 focus:border-red-500'
                  : 'border-gray-300 focus:ring-primary-500 focus:border-primary-500'
              }`}
            />
            {phoneTouched.value && phoneValidationError.value && (
              <p id="customer-info-phone-error" role="alert" class="mt-1 text-sm text-red-600">{phoneValidationError.value}</p>
            )}
          </div>
        </div>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <input
              type="text"
              id="customer-info-firstName"
              value={appState.customer?.firstName}
              disabled={appState.customer?.id !== CUSTOMER_NOT_DEFINED_ID}
              placeholder="First name *"
              onChange$={(_, el) => handleFirstNameChange$(el.value)}
              onBlur$={handleFirstNameBlur$}
              aria-invalid={!!(firstNameTouched.value && firstNameValidationError.value)}
              aria-describedby={firstNameTouched.value && firstNameValidationError.value ? 'customer-info-firstName-error' : undefined}
              class={`block w-full rounded-md shadow-xs sm:text-sm transition-colors duration-200 ${
                firstNameTouched.value && firstNameValidationError.value
                  ? 'border-red-300 focus:ring-red-500 focus:border-red-500'
                  : 'border-gray-300 focus:ring-primary-500 focus:border-primary-500'
              }`}
            />
            {firstNameTouched.value && firstNameValidationError.value && (
              <p id="customer-info-firstName-error" role="alert" class="mt-1 text-sm text-red-600">{firstNameValidationError.value}</p>
            )}
          </div>

          <div>
            <input
              type="text"
              id="customer-info-lastName"
              value={appState.customer?.lastName}
              disabled={appState.customer?.id !== CUSTOMER_NOT_DEFINED_ID}
              placeholder="Last name *"
              onChange$={(_, el) => handleLastNameChange$(el.value)}
              onBlur$={handleLastNameBlur$}
              aria-invalid={!!(lastNameTouched.value && lastNameValidationError.value)}
              aria-describedby={lastNameTouched.value && lastNameValidationError.value ? 'customer-info-lastName-error' : undefined}
              class={`block w-full rounded-md shadow-xs sm:text-sm transition-colors duration-200 ${
                lastNameTouched.value && lastNameValidationError.value
                  ? 'border-red-300 focus:ring-red-500 focus:border-red-500'
                  : 'border-gray-300 focus:ring-primary-500 focus:border-primary-500'
              }`}
            />
            {lastNameTouched.value && lastNameValidationError.value && (
              <p id="customer-info-lastName-error" role="alert" class="mt-1 text-sm text-red-600">{lastNameValidationError.value}</p>
            )}
          </div>
        </div>
      </form>
    </div>
  );
});


