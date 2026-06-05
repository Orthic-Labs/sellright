import { component$, Slot, useSignal, useOnWindow, $ } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';

interface ErrorBoundaryProps {
  fallback?: any;
  // onError removed due to Qwik serialization constraints
}

/**
 * Error Boundary Component for Qwik
 * Provides graceful error handling for checkout flow
 */
export const ErrorBoundary = component$<ErrorBoundaryProps>(({ fallback }) => {
  const hasError = useSignal(false);
  const error = useSignal<Error | null>(null);

  // T18: Error boundary via useOnWindow
  useOnWindow('error', $((event: Event) => {
    const e = event as ErrorEvent;
    console.error('ErrorBoundary caught error:', e.error);
    error.value = e.error;
    hasError.value = true;
  }));
  useOnWindow('unhandledrejection', $((event: Event) => {
    const e = event as PromiseRejectionEvent;
    console.error('ErrorBoundary caught unhandled promise rejection:', e.reason);
    const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
    error.value = err;
    hasError.value = true;
  }));

  if (hasError.value) {
    if (fallback) {
      return fallback;
    }

    return (
      <div class="min-h-screen flex items-center justify-center bg-gray-50">
        <div class="max-w-md w-full bg-white shadow-lg rounded-lg p-6">
          <div class="flex items-center mb-4">
            <div class="shrink-0">
              <svg class="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 19.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <div class="ml-3">
              <h3 class="text-sm font-medium text-gray-800">
                Something went wrong
              </h3>
            </div>
          </div>
          
          <div class="mt-2">
            <div class="text-sm text-gray-600">
              We encountered an error while processing your request. Please try refreshing the page or contact support if the problem persists.
            </div>
          </div>

          {error.value && (
            <details class="mt-4">
              <summary class="cursor-pointer text-sm text-gray-500 hover:text-gray-700">
                Technical details
              </summary>
              <div class="mt-2 text-xs text-red-600 font-mono bg-red-50 p-2 rounded-sm">
                {error.value.message}
              </div>
            </details>
          )}

          <div class="mt-6 flex space-x-3">
            <button
              onClick$={() => {
                hasError.value = false;
                error.value = null;
              }}
              class="flex-1 bg-indigo-600 text-white text-sm font-medium py-2 px-4 rounded-md hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
            >
              Try Again
            </button>
            <button
              onClick$={() => window.location.reload()}
              class="flex-1 bg-gray-300 text-gray-700 text-sm font-medium py-2 px-4 rounded-md hover:bg-gray-400 focus:outline-hidden focus:ring-2 focus:ring-gray-500"
            >
              Refresh Page
            </button>
          </div>

          <div class="mt-4 text-center">
            <Link 
              href="/" 
              class="text-sm text-indigo-600 hover:text-indigo-800"
            >
              Return to Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <Slot />;
});
