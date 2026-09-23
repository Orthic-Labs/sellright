import { component$, $, useSignal, useVisibleTask$, useContext } from '@qwik.dev/core';
import type { QRL } from '@qwik.dev/core';
import type { VerificationProgram } from './types';
import { APP_STATE, CUSTOMER_NOT_DEFINED_ID } from '~/constants';
import { SheerIdService } from './SheerIdService';

interface SheerIdModalProps {
  isOpen: boolean;
  program: VerificationProgram | null;
  onClose$: QRL<() => void>;
  onVerificationComplete$?: QRL<(success: boolean) => void>;
}

export default component$<SheerIdModalProps>(({ isOpen, program, onClose$, onVerificationComplete$: _onVerificationComplete$ }) => {
  if (!isOpen || !program) return null;

  const appState = useContext(APP_STATE);
  const verificationStatus = useSignal<'pending' | 'success' | 'failed' | null>(null);
  const showSuccessMessage = useSignal(false);
  const sheerIdError = useSignal<string>();

  // Get current customer ID
  const customerId = appState.customer?.id !== CUSTOMER_NOT_DEFINED_ID ? appState.customer?.id : null;

  const closeModal = $(() => {
    onClose$();
    // Reset status when closing
    verificationStatus.value = null;
    showSuccessMessage.value = false;
  });

  const handleVerificationSuccess = $((_response: any) => {
    verificationStatus.value = 'success';
    showSuccessMessage.value = true;

    // Auto-close modal after success (optional, following existing logic)
    setTimeout(() => {
      closeModal();
    }, 5000);
  });

  const handleVerificationError = $((error: string) => {
    verificationStatus.value = 'failed';
    sheerIdError.value = error;
  });

  // Reset state when modal opens/closes
  useVisibleTask$(({ track }) => {
    track(() => isOpen);

    if (!isOpen) {
      // Reset state when modal closes
      verificationStatus.value = null;
      showSuccessMessage.value = false;
      sheerIdError.value = undefined;
    }
  });

  return (
    <div 
      style="position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.9);backdrop-filter:blur(4px);padding:1rem;"
      onClick$={$(async (e) => {
        if (e.target === e.currentTarget) {
          await closeModal();
        }
      })}
    >
      <div class="relative bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div class="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 class="text-xl font-semibold text-gray-900">
              {program.name} Verification
            </h2>
            <p class="text-sm text-gray-600 mt-1">
              Complete verification to unlock your {program.discountPercent}% discount
            </p>
          </div>
          <button
            onClick$={closeModal}
            class="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Close modal"
          >
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* SheerID Service or Success Message */}
        <div class="flex-1 overflow-y-auto">
          {showSuccessMessage.value ? (
            <div class="flex flex-col items-center justify-center h-[600px] bg-green-50">
              <div class="text-center">
                <div class="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-green-100 mb-4">
                  <svg class="h-8 w-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h3 class="text-lg font-medium text-gray-900 mb-2">Verification Successful!</h3>
                <p class="text-sm text-gray-600 mb-4">
                  Your {program.discountPercent}% discount has been applied to your account.
                </p>
                <p class="text-xs text-gray-500">
                  This window will close automatically in a few seconds...
                </p>
              </div>
            </div>
          ) : sheerIdError.value ? (
            <div class="flex flex-col items-center justify-center h-[600px] bg-red-50">
              <div class="text-center max-w-md">
                <div class="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-red-100 mb-4">
                  <svg class="h-8 w-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                </div>
                <h3 class="text-lg font-medium text-gray-900 mb-2">Unable to Load Verification</h3>
                <p class="text-sm text-gray-600 mb-4">
                  {sheerIdError.value}
                </p>
                <button
                  onClick$={closeModal}
                  class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                >
                  Close and Try Again
                </button>
              </div>
            </div>
          ) : (
            <div class="p-6">
              <SheerIdService
                program={program}
                customerId={customerId}
                onVerificationSuccess$={handleVerificationSuccess}
                onVerificationError$={handleVerificationError}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div class="flex-shrink-0 flex justify-between items-center p-6 border-t border-gray-200 bg-gray-50">
          <button
            onClick$={closeModal}
            class="text-sm text-gray-600 hover:text-gray-800 transition-colors"
          >
            ← Back to Categories
          </button>
          {verificationStatus.value === 'success' ? (
            <p class="text-xs text-green-600 font-medium">
              ✓ Verification successful! Discount applied.
            </p>
          ) : verificationStatus.value === 'failed' ? (
            <p class="text-xs text-red-600">
              ✗ Verification failed. Please try again.
            </p>
          ) : (
            <p class="text-xs text-gray-500">
              Your verification will be processed automatically. You can close this window once complete.
            </p>
          )}
        </div>
      </div>
    </div>
  );
});
