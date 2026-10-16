import { component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { consumeMagicLink } from '~/providers/shop/account/account';
import { createSEOHead } from '~/utils/seo';

export const head = () =>
	createSEOHead({ title: 'Signing you in', description: 'Completing your sign-in.', noindex: true });

/**
 * Landing page of the emailed sign-in link (the API builds `${storefront}/account/magic-link?token=...`). The token is
 * single-use and is exchanged here, in the browser, so the API can set the session cookies on the shopper's own
 * origin; on success the shopper is sent to their account, otherwise they get a way back to /sign-in.
 */
export default component$(() => {
	const state = useSignal<'working' | 'failed'>('working');
	const message = useSignal('');

	useVisibleTask$(async () => {
		const token = new URLSearchParams(window.location.search).get('token');
		if (!token) {
			message.value = 'This sign-in link is incomplete. Request a new one from the sign-in page.';
			state.value = 'failed';
			return;
		}
		const result = await consumeMagicLink(token);
		if (result.ok) {
			window.location.replace('/account');
			return;
		}
		message.value = result.code === 'invalid_token' ? 'This sign-in link is invalid, expired, or already used.' : result.message;
		state.value = 'failed';
	});

	return (
		<div class="flex flex-col justify-center py-12 sm:px-6 lg:px-8">
			<div class="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
				<div class="bg-[#F9F7F4] py-8 px-4 shadow-sm sm:rounded-lg sm:px-10 text-center" data-testid="magic-link-page">
					{state.value === 'working' && (
						<>
							<div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-accent)] mb-4"></div>
							<h1 class="text-lg font-medium text-gray-900 mb-2">Signing you in...</h1>
						</>
					)}
					{state.value === 'failed' && (
						<>
							<h1 class="text-lg font-medium text-gray-900 mb-2">We could not sign you in</h1>
							<p class="text-sm text-gray-600 mb-6" role="alert">{message.value}</p>
							<a href="/sign-in" class="text-sm text-[var(--color-accent)] underline">Back to sign in</a>
						</>
					)}
				</div>
			</div>
		</div>
	);
});
