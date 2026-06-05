import { component$ } from '@qwik.dev/core';
import { Link, useLocation, routeLoader$, type RequestHandler } from '@qwik.dev/router';
import { createSEOHead } from '~/utils/seo';

export const onGet: RequestHandler = async ({ status, url }) => {
	// Return proper 404 status for catchall routes (prevents Google soft 404s)
	// Skip for legacy redirect paths — they throw redirect() before reaching here
	if (!url.pathname.startsWith('/order-status')) {
		status(404);
	}
};

// Handle legacy redirects before showing 404
export const useLegacyRedirects = routeLoader$(({ url, redirect }) => {
        // Handle legacy /order-status emails
        if (url.pathname.startsWith('/order-status')) {
                const orderCode = url.searchParams.get('orderCode');
                if (orderCode) {
                        throw redirect(301, `/track-order?orderCode=${orderCode}`);
                }
                throw redirect(301, '/track-order');
        }

        // Handle legacy modal query parameters from the homepage
        if (url.pathname === '/' && url.searchParams.get('trackOrder') === 'true') {
                const orderCode = url.searchParams.get('orderCode');
                const email = url.searchParams.get('email');
                
                if (orderCode && email) {
                        throw redirect(301, `/track-order?orderCode=${orderCode}&email=${encodeURIComponent(email)}`);
                } else if (orderCode) {
                        throw redirect(301, `/track-order?orderCode=${orderCode}`);
                }
                throw redirect(301, '/track-order');
        }
});

export const head = createSEOHead({
	title: '404 - Page Not Found',
	description: 'The page you are looking for could not be found.',
	noindex: true,
});

export default component$(() => {
        useLegacyRedirects();
        const location = useLocation();
        const currentPath = location.url.pathname;

	return (
		<div class="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
			<div class="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
				<div class="bg-white py-8 px-4 shadow-sm sm:rounded-lg sm:px-10">
					{/* 404 Icon */}
					<div class="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
						<svg class="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
						</svg>
					</div>

					{/* Error Content */}
					<div class="text-center">
						<h1 class="text-2xl font-bold text-gray-900 mb-2">
							Page Not Found
						</h1>
						
						<p class="text-sm text-gray-500 mb-6">
							Sorry, we couldn't find the page you're looking for.
						</p>

						{currentPath.startsWith('/products/') && (
							<p class="text-xs text-gray-400 mb-6">
								The product you're looking for may have been moved or is no longer available.
							</p>
						)}

						{/* Action Buttons */}
						<div class="space-y-3">
							<Link
								href="/"
								class="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-xs text-sm font-medium text-white bg-black hover:bg-gray-800 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-black"
							>
								Return to Home
							</Link>
							
							<Link
								href="/shop"
								class="w-full flex justify-center py-2 px-4 border border-gray-300 rounded-md shadow-xs text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-black"
							>
								Browse Products
							</Link>
						</div>

						{/* Path Information for debugging */}
						{import.meta.env.DEV && (
							<div class="mt-6 text-xs text-gray-400">
								Path: {currentPath}
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
});