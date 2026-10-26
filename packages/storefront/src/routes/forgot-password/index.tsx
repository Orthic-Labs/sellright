import { $, component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { XCircleIcon } from '~/platform/gateway';
import { passwordResetFailureMessage, requestPasswordReset } from '~/providers/shop/account/account';
import { createSEOHead } from '~/utils/seo';
import { theme } from '~/theme/theme.config';
import { mountTurnstile, resetTurnstile, TURNSTILE_SITE_KEY } from '~/utils/turnstile-widget';

export default component$(() => {
	const email = useSignal('');
	const error = useSignal('');
	const success = useSignal(false);
	const turnstileToken = useSignal('');

	// The API verifies Turnstile on forgot-password when it is enforced; no-op without a site key.
	useVisibleTask$(() => {
		mountTurnstile('forgot-turnstile', (t) => { turnstileToken.value = t; }, () => { turnstileToken.value = ''; });
	});

	const reset = $(async () => {
		success.value = false;
		if (!email.value.trim()) {
			error.value = 'Please enter your email address.';
			return;
		}
		if (TURNSTILE_SITE_KEY && !turnstileToken.value) {
			error.value = 'Please complete the security check.';
			return;
		}
		// Tokens are single-use: take it and re-arm the widget for the next attempt.
		const token = turnstileToken.value;
		turnstileToken.value = '';
		if (TURNSTILE_SITE_KEY) resetTurnstile();
		error.value = '';
		// The API answers 200 whether or not an account exists, so only a 200 is "sent"; a 403/429/transport
		// failure is shown as such (previous-platform parity, #389).
		const result = await requestPasswordReset(email.value, token || undefined);
		if (result.ok) success.value = true;
		else error.value = passwordResetFailureMessage(result);
	});
	return (
		<div class="flex flex-col justify-center py-12 sm:px-6 lg:px-8 bg-white">
			<div class="sm:mx-auto sm:w-full sm:max-w-md">
				<h2 class="mt-6 text-center text-lg sm:text-xl font-semibold text-gray-900 whitespace-nowrap">Forgot password</h2>
			</div>
			<div class="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
				<div class="bg-[#F9F7F4] py-8 px-4 shadow-sm sm:rounded-lg sm:px-10">
					{success.value && (
						<div class="mt-6 mb-6 bg-yellow-50 border border-yellow-400 text-yellow-800 rounded-sm p-4 text-center text-sm">
							<p>Password reset email sent to {email.value}</p>
						</div>
					)}
					<div class="mt-8 space-y-6">
						<div>
							<label class="block text-sm font-medium text-gray-700">Email</label>
							<div class="mt-1">
								<input
									type="email"
									value={email.value}
									required
									placeholder="Enter email..."
									onInput$={(_, el) => (email.value = el.value)}
									onKeyUp$={(ev, el) => {
										error.value = '';
										if (ev.key === 'Enter' && !!el.value) {
											reset();
										}
									}}
									class="appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs placeholder-gray-400 focus:outline-hidden focus:ring-[var(--color-accent)] focus:border-[var(--color-accent)] sm:text-sm"
								/>
							</div>
						</div>
						{TURNSTILE_SITE_KEY && <div id="forgot-turnstile" class="min-h-[65px] flex justify-center"></div>}
						{error.value !== '' && (
							<div class="rounded-md bg-red-50 p-4">
								<div class="flex">
									<div class="shrink-0">
										<XCircleIcon />
									</div>
									<div class="ml-3">
										<p class="text-sm text-red-700">{error.value}</p>
									</div>
								</div>
							</div>
						)}
						<div>
							<button
								class="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[var(--color-accent)] hover:bg-[#4F3B26] focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)] transition-colors cursor-pointer"
								onClick$={reset}
							>
								Reset password
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
});

export const head = () => {
	return createSEOHead({
		title: 'Forgot Password',
		description: `Reset your ${theme.storeName} account password.`,
		noindex: true,
	});
};
