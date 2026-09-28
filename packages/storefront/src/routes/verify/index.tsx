import { component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import XCircleIcon from '~/components/icons/XCircleIcon';
import { verifyEmail } from '~/providers/shop/account/account';
import { createSEOHead } from '~/utils/seo';
import { theme } from '~/theme/theme.config';

export const head = createSEOHead({
	title: 'Verify Account',
	description: `Verify your ${theme.storeName} account.`,
	noindex: true,
});

export default component$(() => {
	const error = useSignal('');
	const loading = useSignal(true);
	const success = useSignal(false);

	// Native registration always collects the password up front, so — unlike
	// the old Vendure flow — verifying an email never needs a follow-up
	// "set your password" step. `verify-email` either succeeds or it doesn't.
	useVisibleTask$(async () => {
		const urlParams = new URLSearchParams(window.location.search);
		const token = urlParams.get('token');

		if (!token) {
			error.value = 'No verification token found in URL. Please check your email and click the verification link again.';
			loading.value = false;
			return;
		}

		const result = await verifyEmail(token);
		if (result.ok) {
			success.value = true;
			error.value = '';
			loading.value = false;
			setTimeout(() => {
				window.location.href = '/sign-in';
			}, 2000);
			return;
		}

		error.value = result.message;
		loading.value = false;
	});

	return (
		<div class="flex flex-col justify-center py-12 sm:px-6 lg:px-8">
			<div class="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
				<div class="bg-[#F9F7F4] py-8 px-4 shadow-sm sm:rounded-lg sm:px-10">
					{loading.value && (
						<div class="text-center">
							<div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-accent)] mb-4"></div>
							<h3 class="text-lg font-medium text-gray-900 mb-2">Verifying your account...</h3>
							<p class="text-sm text-gray-600">Please wait while we verify your email address.</p>
						</div>
					)}

					{success.value && (
						<div class="text-center">
							<div class="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-green-100 mb-4">
								<svg class="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
								</svg>
							</div>
							<h3 class="text-lg font-medium text-gray-900 mb-2">Email verified successfully!</h3>
							<p class="text-sm text-gray-600">Redirecting you to sign in...</p>
						</div>
					)}

					{error.value !== '' && !loading.value && !success.value && (
						<div class="rounded-md bg-red-50 p-4">
							<div class="flex">
								<div class="shrink-0">
									<XCircleIcon />
								</div>
								<div class="ml-3">
									<h3 class="text-sm font-medium text-red-800">
										We ran into a problem verifying your account!
									</h3>
									<p class="text-sm text-red-700 mt-2">{error.value}</p>
									<div class="mt-4">
										<a href="/sign-in" class="text-sm font-medium text-red-800 hover:text-red-700 underline">
											Back to sign in
										</a>
										<span class="text-sm text-red-700 mx-2">or</span>
										<a href="/" class="text-sm font-medium text-red-800 hover:text-red-700 underline">
											Return to homepage
										</a>
									</div>
								</div>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
});
