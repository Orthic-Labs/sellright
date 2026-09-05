import { $, component$, type QRL, type Signal } from '@qwik.dev/core';
import { CUSTOMER_NOT_DEFINED_ID } from '~/constants';
import AddressForm from '~/components/address-form/AddressForm';
import BillingAddressForm from '~/components/billing-address-form/BillingAddressForm';
import { sanitizePhoneNumber } from '~/utils/validation';
import { ValidationIcon } from './ValidationIcon';

type CheckoutAddressesViewProps = {
  appState: any;
  error: Signal<string>;
  openLoginModal: QRL<() => void>;
  phonePlaceholder: Signal<string>;
  useDifferentBilling: Signal<boolean>;
  billingHasBeenActivated: Signal<boolean>;
  emailValidationError: Signal<string>;
  emailTouched: Signal<boolean>;
  firstNameValidationError: Signal<string>;
  firstNameTouched: Signal<boolean>;
  lastNameValidationError: Signal<string>;
  lastNameTouched: Signal<boolean>;
  phoneValidationError: Signal<string>;
  phoneTouched: Signal<boolean>;
  handleEmailChange$: QRL<(value: string) => void>;
  handleEmailBlur$: QRL<() => void>;
  handlePhoneChange$: QRL<(value: string) => void>;
  handlePhoneBlur$: QRL<() => void>;
  handleFirstNameChange$: QRL<(value: string) => void>;
  handleFirstNameBlur$: QRL<() => void>;
  handleLastNameChange$: QRL<(value: string) => void>;
  handleLastNameBlur$: QRL<() => void>;
};

export const CheckoutAddressesView = component$<CheckoutAddressesViewProps>((props) => {
  const {
    appState, error, openLoginModal, phonePlaceholder, useDifferentBilling, billingHasBeenActivated,
    emailValidationError, emailTouched, firstNameValidationError, firstNameTouched,
    lastNameValidationError, lastNameTouched, phoneValidationError, phoneTouched,
    handleEmailChange$, handleEmailBlur$, handlePhoneChange$, handlePhoneBlur$,
    handleFirstNameChange$, handleFirstNameBlur$, handleLastNameChange$, handleLastNameBlur$,
  } = props;

  return (
    <div class="space-y-4 CheckoutAddresses">
      {error.value && (
        <div class="p-4 bg-red-50 border border-red-200 rounded-md">
          <p class="text-sm text-red-800">{error.value}</p>
        </div>
      )}

      <div class="flex items-center justify-between mb-4">
        <h3 class="text-[30px] leading-none md:text-[34px] font-heading font-normal tracking-wide text-[#1A1A1A] flex-1 text-center md:text-left md:flex-none">
          Shipping Details
        </h3>

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

      <section>
        <div class="space-y-4">
          <div class="grid grid-cols-2 gap-4">
            <div class="relative">
              <label for="checkout-email" class="sr-only">Email address</label>
              <input
                id="checkout-email"
                type="email"
                value={appState.customer?.emailAddress}
                placeholder="Email address"
                aria-label="Email address"
                onChange$={(_, el) => handleEmailChange$(el.value)}
                onBlur$={handleEmailBlur$}
                aria-invalid={!!(emailTouched.value && emailValidationError.value)}
                aria-describedby={emailTouched.value && emailValidationError.value ? 'checkout-email-error' : undefined}
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
                errorId={emailTouched.value && emailValidationError.value ? 'checkout-email-error' : undefined}
              />
            </div>
            <div class="relative">
              <label for="checkout-phone" class="sr-only">Phone number</label>
              <input
                id="checkout-phone"
                type="tel"
                value={sanitizePhoneNumber(appState.shippingAddress?.phoneNumber)}
                placeholder={phonePlaceholder.value}
                aria-label="Phone number"
                onChange$={(_, el) => handlePhoneChange$(el.value)}
                onBlur$={handlePhoneBlur$}
                aria-invalid={!!(phoneTouched.value && phoneValidationError.value)}
                aria-describedby={phoneTouched.value && phoneValidationError.value ? 'checkout-phone-error' : undefined}
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
                errorId={phoneTouched.value && phoneValidationError.value ? 'checkout-phone-error' : undefined}
              />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="relative">
              <label for="checkout-first-name" class="sr-only">First name</label>
              <input
                id="checkout-first-name"
                type="text"
                value={appState.customer?.firstName}
                placeholder="First name"
                aria-label="First name"
                onChange$={(_, el) => handleFirstNameChange$(el.value)}
                onBlur$={handleFirstNameBlur$}
                aria-invalid={!!(firstNameTouched.value && firstNameValidationError.value)}
                aria-describedby={firstNameTouched.value && firstNameValidationError.value ? 'checkout-first-name-error' : undefined}
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
                errorId={firstNameTouched.value && firstNameValidationError.value ? 'checkout-first-name-error' : undefined}
              />
            </div>

            <div class="relative">
              <label for="checkout-last-name" class="sr-only">Last name</label>
              <input
                id="checkout-last-name"
                type="text"
                value={appState.customer?.lastName}
                placeholder="Last name"
                aria-label="Last name"
                onChange$={(_, el) => handleLastNameChange$(el.value)}
                onBlur$={handleLastNameBlur$}
                aria-invalid={!!(lastNameTouched.value && lastNameValidationError.value)}
                aria-describedby={lastNameTouched.value && lastNameValidationError.value ? 'checkout-last-name-error' : undefined}
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
                errorId={lastNameTouched.value && lastNameValidationError.value ? 'checkout-last-name-error' : undefined}
              />
            </div>
          </div>
        </div>
      </section>

      <section>
        <AddressForm
          shippingAddress={appState.shippingAddress}
          isReviewMode={false}
        />
      </section>

      <section>
        <button
          type="button"
          onClick$={$(() => {
            const next = !useDifferentBilling.value;
            useDifferentBilling.value = next;
            if (!next) {
              billingHasBeenActivated.value = false;
            }
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
    </div>
  );
});
