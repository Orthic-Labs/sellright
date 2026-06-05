import { component$ } from '@qwik.dev/core';
import type { RequestHandler } from '@qwik.dev/router';
import { createSEOHead } from '~/utils/seo';

export default component$(() => {
  // T33: Server-side onGet below handles the redirect.
  // No client-side UVT needed — never reaches client.
  return (
    <div class="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div class="sm:mx-auto sm:w-full sm:max-w-md">
        <div class="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10">
          <div class="text-center">
            <div class="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-primary-100 mb-4">
              <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
            </div>
            <h2 class="text-lg font-medium text-gray-900 mb-2">
              Redirecting...
            </h2>
            <p class="text-sm text-gray-600">
              Taking you back to checkout
            </p>
          </div>
        </div>
      </div>
    </div>
  );

});

export const onGet: RequestHandler = async ({ headers, send }) => {
  // Server-side redirect to avoid any blank page before client hydration
  headers.set('Location', '/checkout');
  send(302, '');
};

export const head = () => {
  return createSEOHead({
    title: 'Payment - Damned Designs',
    description: 'Payment processing page',
    noindex: true,
  });
};
