import { $, component$, useSignal, useStyles$, QRL, useContext, useOnWindow, useVisibleTask$ } from '@qwik.dev/core';
import { loginMutation, registerCustomerAccountMutation, requestPasswordResetMutation } from '~/providers/shop/account/account';
import { checkCustomerEmail } from '~/providers/shop/account/check-email';
import { getActiveCustomerQuery } from '~/providers/shop/customer/customer';
import { APP_STATE } from '~/constants';
import { ActiveCustomer } from '~/types';
import { LocalAddressService } from '~/services/LocalAddressService';
import { clearCustomerCacheAfterMutation } from '~/providers/shop/customer/customer';
import { registerCustomerFromSignup } from './signup-flow';
import { AuthError } from './AuthError';

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';

export interface LoginModalProps {
  isOpen: boolean;
  onClose$: QRL<() => void>;
  onLoginSuccess$?: QRL<() => void>;
}

type Step = 'email' | 'signin' | 'signup' | 'success' | 'reset-sent';

export default component$<LoginModalProps>(({
  isOpen,
  onClose$,
  onLoginSuccess$
}) => {
  useStyles$(`body.login-modal-open { overflow: hidden !important; }`);
  const appState = useContext(APP_STATE);

  const step = useSignal<Step>('email'), email = useSignal(''), password = useSignal(''), confirmPassword = useSignal('');
  const firstName = useSignal(''), lastName = useSignal('');
  const rememberMe = useSignal(true), error = useSignal(''), loading = useSignal(false);
  const turnstileToken = useSignal(''), honeypot = useSignal(''), turnstileLoaded = useSignal(false);

  useVisibleTask$(({ track }) => {
    track(() => isOpen);
    if (!isOpen || !TURNSTILE_SITE_KEY || turnstileLoaded.value) return;
    if ((window as any).turnstile) {
      setTimeout(() => {
        const container = document.getElementById('modal-turnstile');
        if (container && (window as any).turnstile) {
          (window as any).turnstile.render(container, {
            sitekey: TURNSTILE_SITE_KEY,
            theme: 'light',
            callback: (token: string) => { turnstileToken.value = token; },
            'expired-callback': () => { turnstileToken.value = ''; },
          });
        }
      }, 100);
      turnstileLoaded.value = true;
      return;
    }
    (window as any).onModalTurnstileLoad = () => {
      const container = document.getElementById('modal-turnstile');
      if (container && (window as any).turnstile) {
        (window as any).turnstile.render(container, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: 'light',
          callback: (token: string) => { turnstileToken.value = token; },
          'expired-callback': () => { turnstileToken.value = ''; },
        });
      }
      turnstileLoaded.value = true;
    };
    if (!document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')) {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onModalTurnstileLoad';
      script.async = true;
      document.head.appendChild(script);
    } else {
      setTimeout(() => {
        if ((window as any).turnstile) {
          (window as any).onModalTurnstileLoad();
        }
      }, 500);
    }
  });

  useOnWindow('keydown', $(async (event: Event) => {
    if (!isOpen) return;
    if ((event as KeyboardEvent).key === 'Escape') {
      resetAndClose();
      await onClose$();
    }
  }));

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const resetAndClose = $(() => {
    email.value = '';
    password.value = '';
    confirmPassword.value = '';
    firstName.value = '';
    lastName.value = '';
    error.value = '';
    step.value = 'email';
  });

  const handleEmailContinue = $(async () => {
    error.value = '';
    const trimmed = email.value.trim();
    if (!trimmed) { error.value = 'Please enter your email address.'; return; }
    if (!emailRegex.test(trimmed)) { error.value = 'Please enter a valid email address.'; return; }
    if (TURNSTILE_SITE_KEY && !turnstileToken.value) { error.value = 'Please complete the security check.'; return; }
    loading.value = true;
    const exists = await checkCustomerEmail(trimmed, turnstileToken.value, honeypot.value);
    loading.value = false;
    step.value = exists ? 'signin' : 'signup';
  });

  const handleSignIn = $(async () => {
    error.value = '';
    if (!password.value.trim()) { error.value = 'Please enter your password.'; return; }
    loading.value = true;
    try {
      const { login } = await loginMutation(email.value.trim(), password.value, rememberMe.value);
      if (login.__typename === 'CurrentUser') {
        try {
          const customerData = await getActiveCustomerQuery();
          if (customerData) {
            appState.customer = {
              title: customerData.title ?? '',
              firstName: customerData.firstName,
              id: customerData.id,
              lastName: customerData.lastName,
              emailAddress: customerData.emailAddress,
              phoneNumber: customerData.phoneNumber ?? '',
            } as ActiveCustomer;
            try {
              clearCustomerCacheAfterMutation();
              await LocalAddressService.syncFromVendure(customerData.id);
              const addresses = LocalAddressService.getAddresses();
              appState.addressBook = addresses;
              if (addresses.length > 0 && !appState.shippingAddress.streetLine1) {
                const defaultShipping = addresses.find(a => a.defaultShippingAddress) || addresses[0];
                if (defaultShipping) {
                  appState.shippingAddress = {
                    id: defaultShipping.id,
                    fullName: defaultShipping.fullName,
                    streetLine1: defaultShipping.streetLine1,
                    streetLine2: defaultShipping.streetLine2 || '',
                    city: defaultShipping.city,
                    province: defaultShipping.province,
                    postalCode: defaultShipping.postalCode,
                    countryCode: defaultShipping.countryCode,
                    phoneNumber: defaultShipping.phoneNumber || '',
                    company: defaultShipping.company || '',
                  };
                }
              }
            } catch (addrErr) {
              console.warn('[LoginModal] Address sync after login failed:', addrErr);
            }
          }
        } catch (e) {
          console.error('Failed to update customer data:', e);
        }
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.removeItem('guestCheckoutData');
        }
        resetAndClose();
        await onClose$();
        if (onLoginSuccess$) await onLoginSuccess$();
      } else {
        const msg = (login as any).message?.toLowerCase() || '';
        if (msg.includes('verify') || msg.includes('verification')) {
          error.value = 'Please verify your email address first. Check your inbox for a verification link.';
        } else {
          error.value = 'Invalid email or password.';
        }
      }
    } catch {
      error.value = 'An error occurred. Please try again.';
    }
    loading.value = false;
  });

  const handleSignUp = $(async () => {
    error.value = '';
    loading.value = true;
    const result = await registerCustomerFromSignup({
      email: email.value,
      password: password.value,
      confirmPassword: confirmPassword.value,
      firstName: firstName.value,
      lastName: lastName.value,
      errorMessage: 'An error occurred. Please try again.',
    });
    if (result.step) step.value = result.step;
    if (result.error) error.value = result.error;
    loading.value = false;
  });

  const handleForgotPassword = $(async () => {
    error.value = '';
    loading.value = true;
    try {
      const result = await requestPasswordResetMutation(email.value.trim());
      if (result?.__typename === 'Success') {
        step.value = 'reset-sent';
      } else {
        await registerCustomerAccountMutation({
          input: { emailAddress: email.value.trim(), firstName: '', lastName: '' },
        });
        step.value = 'reset-sent';
      }
    } catch {
      step.value = 'reset-sent';
    }
    loading.value = false;
  });

  const handleBack = $(() => {
    error.value = '';
    password.value = '';
    confirmPassword.value = '';
    firstName.value = '';
    lastName.value = '';
    step.value = 'email';
  });

  if (!isOpen) return null;

  return (
    <div
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.8)' }}
      onClick$={$(async (e: MouseEvent) => {
        if (e.target === e.currentTarget) {
          resetAndClose();
          await onClose$();
        }
      })}
    >
      <div class="relative w-full max-w-md mx-4">
        <div class="bg-[#FDFAF6] rounded-[3px] border border-[#D8D1C7] shadow-none overflow-hidden">
          <div class="px-6 py-6">

            {step.value === 'email' && (
              <div class="space-y-4 font-body">
                <div class="text-center mb-2">
                  <h2 class="text-xl font-bold text-gray-900">Welcome</h2>
                  <p class="mt-1 text-sm text-gray-600">Enter your email to continue</p>
                </div>
                <input
                  type="text" name="website" autoComplete="off" tabIndex={-1} aria-hidden="true"
                  class="!absolute !-left-[9999px] !top-0 !h-0 !w-0 !overflow-hidden"
                  value={honeypot.value}
                  onInput$={(_, el) => (honeypot.value = el.value)}
                />
                <input
                  type="email" autoComplete="email" autoFocus
                  value={email.value}
                  onInput$={(_, el) => (email.value = el.value)}
                  onKeyUp$={(ev) => { if (ev.key === 'Enter') handleEmailContinue(); }}
                  class="appearance-none block w-full px-4 py-3 border border-[#D8D1C7] rounded-[3px] placeholder-gray-400 focus:outline-hidden focus:ring-0 focus:border-[#141210] sm:text-base bg-white"
                  placeholder="you@example.com"
                />
                <div id="modal-turnstile" class="min-h-[65px] flex justify-center"></div>
                {error.value && (
                  <AuthError message={error.value} />
                )}
                <button
                  onClick$={handleEmailContinue} disabled={loading.value}
                  class="w-full flex justify-center py-3 px-4 border border-transparent rounded-[3px] text-sm font-medium text-[#FDFAF6] bg-[#141210] hover:opacity-90 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {loading.value ? 'Checking...' : 'Continue'}
                </button>
                <div class="text-center">
                  <button type="button" onClick$={$(async () => { resetAndClose(); await onClose$(); })}
                    class="text-sm text-gray-500 hover:text-gray-700 cursor-pointer">Close</button>
                </div>
              </div>
            )}

            {step.value === 'signin' && (
              <div class="space-y-4 font-body">
                <div class="text-center mb-2">
                  <h2 class="text-xl font-bold text-gray-900">Welcome back</h2>
                  <p class="mt-1 text-sm text-gray-600">{email.value}</p>
                  <button onClick$={handleBack} class="text-xs text-gray-500 hover:text-gray-700 underline mt-1 cursor-pointer">
                    Use a different email
                  </button>
                </div>
                <input
                  type="password" autoComplete="current-password" autoFocus
                  value={password.value}
                  onInput$={(_, el) => (password.value = el.value)}
                  onKeyUp$={(ev) => { if (ev.key === 'Enter') handleSignIn(); }}
                  class="appearance-none block w-full px-4 py-3 border border-[#D8D1C7] rounded-[3px] placeholder-gray-400 focus:outline-hidden focus:ring-0 focus:border-[#141210] sm:text-base bg-white"
                  placeholder="Enter your password"
                />
                <div class="flex items-center justify-between">
                  <label class="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input type="checkbox" checked onChange$={(_, el) => (rememberMe.value = el.checked)}
                      class="h-4 w-4 text-[#965341] focus:ring-[#965341] border-gray-300 rounded-sm" />
                    Remember me
                  </label>
                  <button onClick$={handleForgotPassword} disabled={loading.value}
                    class="text-sm text-gray-600 hover:text-gray-800 cursor-pointer underline">
                    Forgot password?
                  </button>
                </div>
                {error.value && (
                  <AuthError message={error.value} />
                )}
                <button onClick$={handleSignIn} disabled={loading.value}
                  class="w-full flex justify-center py-3 px-4 border border-transparent rounded-[3px] text-sm font-medium text-[#FDFAF6] bg-[#141210] hover:opacity-90 transition-colors cursor-pointer disabled:opacity-50">
                  {loading.value ? 'Signing in...' : 'Sign In'}
                </button>
                <div class="text-center">
                  <button type="button" onClick$={$(async () => { resetAndClose(); await onClose$(); })}
                    class="text-sm text-gray-500 hover:text-gray-700 cursor-pointer">Close</button>
                </div>
              </div>
            )}

            {step.value === 'signup' && (
              <div class="space-y-4 font-body">
                <div class="text-center mb-2">
                  <h2 class="text-xl font-bold text-gray-900">Create your account</h2>
                  <p class="mt-1 text-sm text-gray-600">{email.value}</p>
                  <button onClick$={handleBack} class="text-xs text-gray-500 hover:text-gray-700 underline mt-1 cursor-pointer">
                    Use a different email
                  </button>
                </div>
                <div class="grid grid-cols-2 gap-4">
                  <input type="text" autoComplete="given-name" autoFocus
                    value={firstName.value} onInput$={(_, el) => (firstName.value = el.value)}
                    class="appearance-none block w-full px-3 py-2 border border-[#D8D1C7] rounded-[3px] placeholder-gray-400 focus:outline-hidden focus:ring-0 focus:border-[#141210] sm:text-sm bg-white"
                    placeholder="First name" />
                  <input type="text" autoComplete="family-name"
                    value={lastName.value} onInput$={(_, el) => (lastName.value = el.value)}
                    class="appearance-none block w-full px-3 py-2 border border-[#D8D1C7] rounded-[3px] placeholder-gray-400 focus:outline-hidden focus:ring-0 focus:border-[#141210] sm:text-sm bg-white"
                    placeholder="Last name" />
                </div>
                <input type="password" autoComplete="new-password"
                  value={password.value} onInput$={(_, el) => (password.value = el.value)}
                  class="appearance-none block w-full px-4 py-3 border border-[#D8D1C7] rounded-[3px] placeholder-gray-400 focus:outline-hidden focus:ring-0 focus:border-[#141210] sm:text-base bg-white"
                  placeholder="Create a password" />
                <input type="password" autoComplete="new-password"
                  value={confirmPassword.value} onInput$={(_, el) => (confirmPassword.value = el.value)}
                  onKeyUp$={(ev) => { if (ev.key === 'Enter') handleSignUp(); }}
                  class="appearance-none block w-full px-4 py-3 border border-[#D8D1C7] rounded-[3px] placeholder-gray-400 focus:outline-hidden focus:ring-0 focus:border-[#141210] sm:text-base bg-white"
                  placeholder="Confirm password" />
                {error.value && (
                  <AuthError message={error.value} />
                )}
                <button onClick$={handleSignUp} disabled={loading.value}
                  class="w-full flex justify-center py-3 px-4 border border-transparent rounded-[3px] text-sm font-medium text-[#FDFAF6] bg-[#141210] hover:opacity-90 transition-colors cursor-pointer disabled:opacity-50">
                  {loading.value ? 'Creating account...' : 'Create Account'}
                </button>
                <div class="text-center">
                  <button type="button" onClick$={$(async () => { resetAndClose(); await onClose$(); })}
                    class="text-sm text-gray-500 hover:text-gray-700 cursor-pointer">Close</button>
                </div>
              </div>
            )}

            {step.value === 'success' && (
              <div class="text-center py-4">
                <div class="bg-[#F7F2EA] border border-[#D8D1C7] rounded-[3px] p-6">
                  <svg class="w-12 h-12 text-[#B87333] mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                  <h3 class="text-lg font-semibold text-[#111110] mb-2">Check your email</h3>
                  <p class="text-gray-600 mb-4">
                    We sent a verification link to <span class="font-medium">{email.value}</span>. Click the link to activate your account.
                  </p>
                  <button onClick$={handleBack}
                    class="text-sm font-medium text-[#965341] hover:text-[#111110] cursor-pointer">
                    Back to sign in →
                  </button>
                </div>
              </div>
            )}

            {step.value === 'reset-sent' && (
              <div class="text-center py-4">
                <div class="bg-[#F7F2EA] border border-[#D8D1C7] rounded-[3px] p-6">
                  <svg class="w-12 h-12 text-[#B87333] mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  <h3 class="text-lg font-semibold text-[#111110] mb-2">Check your email</h3>
                  <p class="text-gray-600 mb-4">
                    If an account exists for <span class="font-medium">{email.value}</span>, we've sent instructions to reset your password.
                  </p>
                  <button onClick$={$(async () => { resetAndClose(); await onClose$(); })}
                    class="text-sm font-medium text-[#965341] hover:text-[#111110] cursor-pointer">
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
