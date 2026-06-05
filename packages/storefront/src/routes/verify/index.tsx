import { $, component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import XCircleIcon from '~/components/icons/XCircleIcon';
import { verifyCustomerAccountMutation } from '~/providers/shop/account/account';
import { createSEOHead } from '~/utils/seo';

export const head = createSEOHead({
	title: 'Verify Account',
	description: 'Verify your Damned Designs account.',
	noindex: true,
});

export default component$(() => {
	const error = useSignal('');
	const loading = useSignal(true);
	const success = useSignal(false);
	const needsPassword = useSignal(false);
	const token = useSignal('');
	const password = useSignal('');
	const confirmPassword = useSignal('');
	const submitting = useSignal(false);

	const runVerify = $(async (pwd?: string) => {
		try {
			const { verifyCustomerAccount } = await verifyCustomerAccountMutation(token.value, pwd);

			if (verifyCustomerAccount.__typename === 'CurrentUser') {
				success.value = true;
				needsPassword.value = false;
				error.value = '';
				loading.value = false;
				setTimeout(() => {
					window.location.href = '/account';
				}, 2000);
				return;
			}

			const errCode = (verifyCustomerAccount as any).errorCode as string | undefined;
			const errMsg = (verifyCustomerAccount as any).message as string | undefined;

			if (errCode === 'MISSING_PASSWORD_ERROR' || /password must be provided/i.test(errMsg || '')) {
				needsPassword.value = true;
				error.value = '';
				loading.value = false;
				return;
			}

			if (errCode === 'PASSWORD_VALIDATION_ERROR') {
				needsPassword.value = true;
				error.value = errMsg || 'Password does not meet requirements.';
				loading.value = false;
				return;
			}

			error.value = errMsg || 'Verification failed. The token may be invalid or expired.';
			loading.value = false;
		} catch (err) {
			error.value = 'An error occurred during verification. Please try again or contact support if the problem persists.';
			loading.value = false;
			console.error('Verification error:', err);
		}
	});

	useVisibleTask$(async () => {
		const urlParams = new URLSearchParams(window.location.search);
		const t = urlParams.get('token');

		if (!t) {
			error.value = 'No verification token found in URL. Please check your email and click the verification link again.';
			loading.value = false;
			return;
		}

		token.value = t;
		await runVerify();
	});

	const submitPassword = $(async () => {
		if (submitting.value) return;
		error.value = '';
		if (!password.value || password.value.length < 6) {
			error.value = 'Password must be at least 6 characters long.';
			return;
		}
		if (password.value !== confirmPassword.value) {
			error.value = 'Passwords do not match.';
			return;
		}
		submitting.value = true;
		loading.value = true;
		await runVerify(password.value);
		submitting.value = false;
	});

	return (
		<div class="flex flex-col justify-center py-12 sm:px-6 lg:px-8">
			<div class="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
				<div class="bg-[#F9F7F4] py-8 px-4 shadow-sm sm:rounded-lg sm:px-10">
					{loading.value && (
						<div class="text-center">
							<div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#965341] mb-4"></div>
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
							<p class="text-sm text-gray-600">Redirecting you to your account...</p>
						</div>
					)}

					{needsPassword.value && !loading.value && !success.value && (
						<div>
							<div class="text-center mb-6">
								<h3 class="text-lg font-medium text-gray-900 mb-2">Set your password</h3>
								<p class="text-sm text-gray-600">To finish verifying your account, please set a password.</p>
							</div>
							<div class="space-y-4">
								<div>
									<label class="block text-sm font-medium text-gray-700">Password</label>
									<input
										type="password"
										autoComplete="new-password"
										value={password.value}
										onInput$={(_, el) => (password.value = el.value)}
										class="mt-1 appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs placeholder-gray-400 focus:outline-hidden focus:ring-2 focus:ring-gray-500 focus:border-gray-500 sm:text-sm bg-white"
									/>
								</div>
								<div>
									<label class="block text-sm font-medium text-gray-700">Confirm Password</label>
									<input
										type="password"
										autoComplete="new-password"
										value={confirmPassword.value}
										onInput$={(_, el) => (confirmPassword.value = el.value)}
										onKeyUp$={(ev) => {
											if (ev.key === 'Enter') submitPassword();
										}}
										class="mt-1 appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs placeholder-gray-400 focus:outline-hidden focus:ring-2 focus:ring-gray-500 focus:border-gray-500 sm:text-sm bg-white"
									/>
								</div>
								{error.value !== '' && (
									<div class="rounded-md bg-red-50 p-3">
										<p class="text-sm text-red-700">{error.value}</p>
									</div>
								)}
								<button
									onClick$={submitPassword}
									disabled={submitting.value}
									class="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[#965341] hover:bg-[#4F3B26] focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-[#965341] transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
								>
									{submitting.value ? 'Verifying...' : 'Verify Account'}
								</button>
							</div>
						</div>
					)}

					{error.value !== '' && !needsPassword.value && (
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
											Try registering again
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
