import { component$, Slot, useSignal, useOnWindow, $ } from '@qwik.dev/core';
import { useNavigate } from '@qwik.dev/router';

/**
 * Error Boundary for Checkout Components
 * Provides graceful error handling and recovery options
 */

interface CheckoutErrorBoundaryProps {
  // onError removed due to Qwik serialization constraints
  // Use signals or reactive patterns for error handling instead
}

export const CheckoutErrorBoundary = component$<CheckoutErrorBoundaryProps>(() => {
  const hasError = useSignal(false);
  const error = useSignal<Error | null>(null);
  const retryCount = useSignal(0);
  const navigate = useNavigate();

  // Handle retry functionality
  const handleRetry = $(() => {
    hasError.value = false;
    error.value = null;
    retryCount.value++;
    
    // Log retry attempt
    console.log(`🔄 Checkout retry attempt #${retryCount.value}`);
  });

  // Handle navigation back to cart
  const handleBackToCheckout = $(async () => {
    try {
      await navigate('/checkout');
    } catch (_navError) {
      // If navigation fails, at least clear the error
      hasError.value = false;
      window.location.href = '/checkout';
    }
  });

  // Handle navigation to home
  const handleGoHome = $(async () => {
    try {
      await navigate('/');
    } catch (_navError) {
      window.location.href = '/';
    }
  });

  // Error logging and monitoring
  const logError = $((errorToLog: Error) => {
    // Log to console for development
    console.error('🚨 Checkout Error Boundary caught error:', errorToLog);
    
    // Send to monitoring service (replace with your actual service)
    if (typeof window !== 'undefined' && (window as any).gtag) {
      (window as any).gtag('event', 'exception', {
        description: errorToLog.message,
        fatal: true,
        custom_map: {
          error_boundary: 'checkout',
          retry_count: retryCount.value
        }
      });
    }

    // Note: onError callback removed due to Qwik serialization constraints
    // Use signals or other reactive patterns for error handling instead
  });

  // T18: Global error handler via useOnWindow
  useOnWindow('error', $((event: Event) => {
    const e = event as ErrorEvent;
    const errorToHandle = new Error(e.message);
    error.value = errorToHandle;
    hasError.value = true;
    logError(errorToHandle);
  }));
  useOnWindow('unhandledrejection', $((event: Event) => {
    const e = event as PromiseRejectionEvent;
    const errorToHandle = new Error(
      e.reason instanceof Error ? e.reason.message : String(e.reason)
    );
    error.value = errorToHandle;
    hasError.value = true;
    logError(errorToHandle);
  }));

  // If there's an error, show the error UI
  if (hasError.value && error.value) {
    return (
      <div class="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
        <div class="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
          <div class="bg-white py-8 px-4 shadow-sm sm:rounded-lg sm:px-10">
            {/* Error Icon */}
            <div class="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
              <svg class="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>

            {/* Error Content */}
            <div class="text-center">
              <h2 class="text-lg font-medium text-gray-900 mb-2">
                Checkout Error
              </h2>
              
              <p class="text-sm text-gray-500 mb-6">
                We encountered an issue processing your checkout. Don't worry - your cart items are safe.
              </p>

              {/* Error Details (for development) */}
              {process.env.NODE_ENV === 'development' && (
                <div class="bg-gray-100 border border-gray-200 rounded-md p-3 mb-6 text-left">
                  <p class="text-xs font-mono text-gray-700">
                    <strong>Error:</strong> {error.value.message}
                  </p>
                  {error.value.stack && (
                    <details class="mt-2">
                      <summary class="text-xs text-gray-600 cursor-pointer">Stack Trace</summary>
                      <pre class="text-xs text-gray-600 mt-1 whitespace-pre-wrap">
                        {error.value.stack}
                      </pre>
                    </details>
                  )}
                </div>
              )}

              {/* Action Buttons */}
              <div class="space-y-3">
                <button
                  onClick$={handleRetry}
                  class="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-xs text-sm font-medium text-white bg-black hover:bg-gray-800 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-black"
                >
                  Try Again
                </button>
                
                <button
                  onClick$={handleBackToCheckout}
                  class="w-full flex justify-center py-2 px-4 border border-gray-300 rounded-md shadow-xs text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-black"
                >
                  Back to Checkout
                </button>
                
                <button
                  onClick$={handleGoHome}
                  class="w-full flex justify-center py-2 px-4 border border-gray-300 rounded-md shadow-xs text-sm font-medium text-gray-500 bg-white hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-gray-500"
                >
                  Continue Shopping
                </button>
              </div>

              {/* Help Text */}
              <p class="mt-6 text-xs text-gray-400">
                If this problem persists, please contact support with error code: CHK-{Date.now()}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Normal operation - render children
  return <Slot />;
});

export default CheckoutErrorBoundary;
