import { component$, useContext, $, useSignal, type QRL, useOnDocument } from '@qwik.dev/core';
import { APP_STATE } from '~/constants';
import type { BillingAddress } from '~/types';
import { ValidationIcon } from '~/components/checkout/ValidationIcon';
import {
  validateBillingField,
  validateBillingFormValues,
  type ValidationErrors,
} from './billing-validation';

interface BillingAddressFormProps {
  billingAddress: BillingAddress;
  onUserInteraction$?: QRL<() => void>;
}

const BillingAddressForm = component$<BillingAddressFormProps>(({ billingAddress, onUserInteraction$ }) => {
  const appState = useContext(APP_STATE);
  
  const validationErrors = useSignal<ValidationErrors>({});
  const touchedFields = useSignal<Set<string>>(new Set());
  const validationTimer = useSignal<number | null>(null);
  const hasUserInteracted = useSignal(false);

  // Load billing address from localStorage — client-only init.
  // Falls back to legacy sessionStorage key for in-flight users mid-deploy.
  useOnDocument('qinit', $(() => {
    if (typeof localStorage === 'undefined') return;
    let storedGuestBilling = localStorage.getItem('guestBillingAddress');
    if (!storedGuestBilling && typeof sessionStorage !== 'undefined') {
      storedGuestBilling = sessionStorage.getItem('guestBillingAddress');
    }
    if (!storedGuestBilling) return;
    try {
      const guestData = JSON.parse(storedGuestBilling);
      if (guestData) {
        appState.billingAddress = {
          firstName: guestData.firstName || '',
          lastName: guestData.lastName || '',
          streetLine1: guestData.streetLine1 || '',
          streetLine2: guestData.streetLine2 || '',
          city: guestData.city || '',
          province: guestData.province || '',
          postalCode: guestData.postalCode || '',
          countryCode: guestData.countryCode || ''
        };
      }
    } catch (error) {
      console.warn('[BillingAddressForm] Failed to parse guest billing address from storage:', error);
    }
  }));

  // Handle field blur events
  const handleFieldBlur$ = $((fieldName: string, value: string) => {
    touchedFields.value = new Set([...touchedFields.value, fieldName]);

    const safeCountryCode = appState.billingAddress?.countryCode || billingAddress?.countryCode || 'US';
    const currentErrors = validateBillingField(fieldName, value, safeCountryCode, validationErrors.value);
    
    validationErrors.value = currentErrors;
    
    // Trigger complete form validation (debounced to 300ms for consistency)
    if (validationTimer.value) {
      clearTimeout(validationTimer.value);
    }
    validationTimer.value = setTimeout(() => {
      const firstName = appState.billingAddress?.firstName ?? '';
      const lastName = appState.billingAddress?.lastName ?? '';
      const streetLine1 = appState.billingAddress?.streetLine1 ?? '';
      const city = appState.billingAddress?.city ?? '';
      const province = appState.billingAddress?.province ?? '';
      const postalCode = appState.billingAddress?.postalCode ?? '';
      const countryCode = appState.billingAddress?.countryCode ?? 'US';
      
      validationErrors.value = validateBillingFormValues({
        firstName,
        lastName,
        streetLine1,
        city,
        province,
        postalCode,
        countryCode,
      }, validationErrors.value);
    }, 300) as unknown as number;
  });

  // Individual field validation
  const validateField$ = $((fieldName: string, value: string, countryCode?: string) => {
    const safeCountryCode = countryCode ?? appState.billingAddress?.countryCode ?? billingAddress.countryCode ?? 'US';
    const currentErrors = validateBillingField(fieldName, value, safeCountryCode, validationErrors.value);
    
    // Only update if errors actually changed
    if (JSON.stringify(validationErrors.value) !== JSON.stringify(currentErrors)) {
      validationErrors.value = currentErrors;
    }
  });

  // Complete form validation
  const validateForm$ = $(() => {
    const firstName = appState.billingAddress?.firstName ?? billingAddress?.firstName ?? '';
    const lastName = appState.billingAddress?.lastName ?? billingAddress?.lastName ?? '';
    const streetLine1 = appState.billingAddress?.streetLine1 ?? billingAddress?.streetLine1 ?? '';
    const city = appState.billingAddress?.city ?? billingAddress?.city ?? '';
    const province = appState.billingAddress?.province ?? billingAddress?.province ?? '';
    const postalCode = appState.billingAddress?.postalCode ?? billingAddress?.postalCode ?? '';
    const countryCode = appState.billingAddress?.countryCode ?? billingAddress?.countryCode ?? 'US';
    
    const errors = validateBillingFormValues({
      firstName,
      lastName,
      streetLine1,
      city,
      province,
      postalCode,
      countryCode,
    }, validationErrors.value);
    
    validationErrors.value = errors;
    return Object.keys(errors).length === 0;
  });
  
  const handleInputChange$ = $((field: string, value: string) => {
    // Notify parent component on first user interaction
    if (!hasUserInteracted.value && onUserInteraction$) {
      hasUserInteracted.value = true;
      onUserInteraction$();
    }
    
    // Initialize with default empty values if not already set
    if (!appState.billingAddress) {
      appState.billingAddress = {
        firstName: '',
        lastName: '',
        streetLine1: '',
        streetLine2: '',
        city: '',
        province: '',
        postalCode: '',
        countryCode: 'US'
      };
    }
    
    appState.billingAddress = {
      ...appState.billingAddress,
      [field]: value
    };

    // Save billing address to localStorage for persistence across tabs and browser restarts.
    // Only fires when this form is rendered, which only happens when "use different billing" is checked.
    if (typeof localStorage !== 'undefined' && appState.billingAddress) {
      try {
        const guestBillingData = {
          firstName: appState.billingAddress.firstName || '',
          lastName: appState.billingAddress.lastName || '',
          streetLine1: appState.billingAddress.streetLine1 || '',
          streetLine2: appState.billingAddress.streetLine2 || '',
          city: appState.billingAddress.city || '',
          province: appState.billingAddress.province || '',
          postalCode: appState.billingAddress.postalCode || '',
          countryCode: appState.billingAddress.countryCode || '',
          lastUpdated: Date.now()
        };
        localStorage.setItem('guestBillingAddress', JSON.stringify(guestBillingData));
      } catch (error) {
        console.warn('[BillingAddressForm] Failed to save guest billing address to localStorage:', error);
      }
    }
    
    // If the field has been touched, validate on change
    if (touchedFields.value.has(field)) {
      const countryCode = appState.billingAddress?.countryCode ?? billingAddress?.countryCode ?? 'US';
      validateField$(field, value, countryCode);
      
      // Debounced validation (standardized to 300ms)
      if (validationTimer.value) {
        clearTimeout(validationTimer.value);
      }
      validationTimer.value = setTimeout(() => {
        validateForm$();
      }, 300) as unknown as number;
    }
  });
  
  // CSS classes for form fields
  const getFieldClasses = (fieldName: string) => {
    const hasError = touchedFields.value.has(fieldName) && validationErrors.value[fieldName] && validationErrors.value[fieldName].length > 0;
    const baseClasses = "block w-full px-[14px] py-[11px] pr-10 text-[16px] rounded-[3px] border placeholder:text-[rgba(100,85,65,0.42)] focus:outline-hidden transition-colors duration-200 bg-white";
    const errorClasses = hasError
      ? "border-red-300 focus:border-red-500 focus:ring-red-500"
      : "border-[rgba(140,107,58,0.18)] focus:border-[rgba(140,107,58,0.4)] focus:ring-[rgba(140,107,58,0.25)]";
    return `${baseClasses} ${errorClasses}`;
  };
  
  const getSelectClasses = () => {
    return "block w-full px-[14px] py-[11px] text-[16px] rounded-[3px] border placeholder:text-[rgba(100,85,65,0.42)] focus:outline-hidden border-[rgba(140,107,58,0.18)] focus:border-[rgba(140,107,58,0.4)] focus:ring-[rgba(140,107,58,0.25)] transition-colors duration-200 bg-white appearance-none";
  };

  return (
    <div class="grid grid-cols-2 gap-4">
      {/* First Name and Last Name (2 fields on 1 line) */}
      <div class="relative">
        <label for="billingFirstName" class="sr-only">First name</label>
        <input
          type="text"
          name="firstName"
          id="billingFirstName"
          placeholder="First name"
          value={billingAddress?.firstName ?? ''}
          onInput$={(_, el) => handleInputChange$('firstName', el.value)}
          onBlur$={(_, el) => handleFieldBlur$('firstName', el.value)}
          class={getFieldClasses('firstName')}
          required
          aria-invalid={!!(touchedFields.value.has('firstName') && validationErrors.value.firstName)}
          aria-describedby={(touchedFields.value.has('firstName') && validationErrors.value.firstName) ? 'billingFirstName-error' : undefined}
        />
        <ValidationIcon
          touched={touchedFields.value.has('firstName')}
          error={validationErrors.value.firstName || ''}
          valid={touchedFields.value.has('firstName') && !validationErrors.value.firstName && !!(billingAddress?.firstName)}
          errorId={(touchedFields.value.has('firstName') && validationErrors.value.firstName) ? 'billingFirstName-error' : undefined}
        />
      </div>

      <div class="relative">
        <label for="billingLastName" class="sr-only">Last name</label>
        <input
          type="text"
          name="lastName"
          id="billingLastName"
          placeholder="Last name"
          value={billingAddress?.lastName ?? ''}
          onInput$={(_, el) => handleInputChange$('lastName', el.value)}
          onBlur$={(_, el) => handleFieldBlur$('lastName', el.value)}
          class={getFieldClasses('lastName')}
          required
          aria-invalid={!!(touchedFields.value.has('lastName') && validationErrors.value.lastName)}
          aria-describedby={(touchedFields.value.has('lastName') && validationErrors.value.lastName) ? 'billingLastName-error' : undefined}
        />
        <ValidationIcon
          touched={touchedFields.value.has('lastName')}
          error={validationErrors.value.lastName || ''}
          valid={touchedFields.value.has('lastName') && !validationErrors.value.lastName && !!(billingAddress?.lastName)}
          errorId={(touchedFields.value.has('lastName') && validationErrors.value.lastName) ? 'billingLastName-error' : undefined}
        />
      </div>

      {/* Street Address and Address Line 2 (on same line) */}
      <div class="relative">
        <label for="billingStreetLine1" class="sr-only">Street address</label>
        <input
          type="text"
          name="streetLine1"
          id="billingStreetLine1"
          placeholder="Street address"
          value={billingAddress?.streetLine1 ?? ''}
          onInput$={(_, el) => handleInputChange$('streetLine1', el.value)}
          onBlur$={(_, el) => handleFieldBlur$('streetLine1', el.value)}
          class={getFieldClasses('streetLine1')}
          required
          aria-invalid={!!(touchedFields.value.has('streetLine1') && validationErrors.value.streetLine1)}
          aria-describedby={(touchedFields.value.has('streetLine1') && validationErrors.value.streetLine1) ? 'billingStreetLine1-error' : undefined}
        />
        <ValidationIcon
          touched={touchedFields.value.has('streetLine1')}
          error={validationErrors.value.streetLine1 || ''}
          valid={touchedFields.value.has('streetLine1') && !validationErrors.value.streetLine1 && !!(billingAddress?.streetLine1)}
          errorId={(touchedFields.value.has('streetLine1') && validationErrors.value.streetLine1) ? 'billingStreetLine1-error' : undefined}
        />
      </div>

      <div>
        <label for="billingStreetLine2" class="sr-only">Apt, building, etc.</label>
        <input
          type="text"
          name="streetLine2"
          id="billingStreetLine2"
          placeholder="Apt, building, etc."
          value={billingAddress?.streetLine2 ?? ''}
          onInput$={(_, el) => handleInputChange$('streetLine2', el.value)}
          class={getFieldClasses('streetLine2')}
        />
      </div>

      {/* City */}
      <div class="relative">
        <label for="billingCity" class="sr-only">City</label>
        <input
          type="text"
          name="city"
          id="billingCity"
          placeholder="City"
          value={billingAddress?.city ?? ''}
          onInput$={(_, el) => handleInputChange$('city', el.value)}
          onBlur$={(_, el) => handleFieldBlur$('city', el.value)}
          class={getFieldClasses('city')}
          required
          aria-invalid={!!(touchedFields.value.has('city') && validationErrors.value.city)}
          aria-describedby={(touchedFields.value.has('city') && validationErrors.value.city) ? 'billingCity-error' : undefined}
        />
        <ValidationIcon
          touched={touchedFields.value.has('city')}
          error={validationErrors.value.city || ''}
          valid={touchedFields.value.has('city') && !validationErrors.value.city && !!(billingAddress?.city)}
          errorId={(touchedFields.value.has('city') && validationErrors.value.city) ? 'billingCity-error' : undefined}
        />
      </div>

      {/* State/Province */}
      <div class="relative">
        <label for="billingProvince" class="sr-only">State / Province</label>
        <input
          type="text"
          name="province"
          id="billingProvince"
          placeholder="State / Province"
          value={billingAddress?.province ?? ''}
          onInput$={(_, el) => handleInputChange$('province', el.value)}
          onBlur$={(_, el) => handleFieldBlur$('province', el.value)}
          class={getFieldClasses('province')}
          required
          aria-invalid={!!(touchedFields.value.has('province') && validationErrors.value.province)}
          aria-describedby={(touchedFields.value.has('province') && validationErrors.value.province) ? 'billingProvince-error' : undefined}
        />
        <ValidationIcon
          touched={touchedFields.value.has('province')}
          error={validationErrors.value.province || ''}
          valid={touchedFields.value.has('province') && !validationErrors.value.province && !!(billingAddress?.province)}
          errorId={(touchedFields.value.has('province') && validationErrors.value.province) ? 'billingProvince-error' : undefined}
        />
      </div>

      {/* Postal Code */}
      <div class="relative">
        <label for="billingPostalCode" class="sr-only">Postal code</label>
        <input
          type="text"
          inputMode="numeric"
          name="postalCode"
          id="billingPostalCode"
          placeholder="Postal code"
          value={billingAddress?.postalCode ?? ''}
          onInput$={(_, el) => handleInputChange$('postalCode', el.value)}
          onBlur$={(_, el) => handleFieldBlur$('postalCode', el.value)}
          class={getFieldClasses('postalCode')}
          required
          aria-invalid={!!(touchedFields.value.has('postalCode') && validationErrors.value.postalCode)}
          aria-describedby={(touchedFields.value.has('postalCode') && validationErrors.value.postalCode) ? 'billingPostalCode-error' : undefined}
        />
        <ValidationIcon
          touched={touchedFields.value.has('postalCode')}
          error={validationErrors.value.postalCode || ''}
          valid={touchedFields.value.has('postalCode') && !validationErrors.value.postalCode && !!(billingAddress?.postalCode)}
          errorId={(touchedFields.value.has('postalCode') && validationErrors.value.postalCode) ? 'billingPostalCode-error' : undefined}
        />
      </div>

      {/* Country */}
      <div class="relative">
        <label for="billingCountryCode" class="sr-only">Country</label>
        <select
          id="billingCountryCode"
          name="countryCode"
          value={billingAddress?.countryCode || appState.billingAddress?.countryCode || appState.shippingAddress?.countryCode || 'US'}
          onChange$={(_, el) => {
            // console.log(`📍 [BillingAddressForm] Billing country dropdown changed to: ${el.value}`);
            handleInputChange$('countryCode', el.value);
          }}
          class={getSelectClasses()}
          required
          aria-invalid={!!(touchedFields.value.has('countryCode') && validationErrors.value.countryCode)}
          aria-describedby={(touchedFields.value.has('countryCode') && validationErrors.value.countryCode) ? 'billingCountryCode-error' : undefined}
          onMount$={() => {
            // console.log(`📍 [BillingAddressForm] Billing dropdown mounted`);
          }}
        >
          <option value="" disabled>Select a country</option>
          {(appState.availableCountries && appState.availableCountries.length > 0) ?
            appState.availableCountries.map((country) => {
              const currentCountryCode = billingAddress?.countryCode || appState.billingAddress?.countryCode || appState.shippingAddress?.countryCode || 'US';
              return (
                <option
                  key={country.code}
                  value={country.code}
                  selected={country.code === currentCountryCode}
                >
                  {country.name}
                </option>
              );
            }) :
            <option value="US" selected={true}>United States</option>
          }
        </select>
        {/* Custom dropdown arrow */}
        <div class="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
          <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
          </svg>
        </div>
        {touchedFields.value.has('countryCode') && validationErrors.value.countryCode && (
          <p id="billingCountryCode-error" role="alert" class="mt-1 text-sm text-red-600">{validationErrors.value.countryCode}</p>
        )}
      </div>
    </div>
  );
});

export default BillingAddressForm;
