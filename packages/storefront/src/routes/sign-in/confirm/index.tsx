import { $, component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import XCircleIcon from '~/components/icons/XCircleIcon';
import { confirmFederatedSignIn } from '~/providers/shop/account/google-auth';
import { createSEOHead } from '~/utils/seo';

export const head = createSEOHead({
	title: 'Confirm Sign-In',
	description: 'Confirm your sign-in.',
	noindex: true,
});

/**
 * Landing page for the link mailed when a sign-in provider (Google) could not vouch for the address. It never redeems
 * on load — mail scanners and link previews fetch URLs — only on an explicit click. The link works only in the browser
 * that started the sign-in (the API checks a cookie set then).
 */
export default component$(() => {
	const token = useSignal('');
	const error = useSignal('');
	const busy = useSignal(false);

	useVisibleTask$(() => {
		token.value = new URLSearchParams(window.location.search).get('token') ?? '';
		if (!token.value) error.value = 'No sign-in token found in the URL. Please click the link in your email again.';
	});

	const confirm = $(async () => {
		if (busy.value || !token.value) return;
		busy.value = true;
		error.value = '';
		const result = await confirmFederatedSignIn(token.value);
		if (result.ok) {
			window.location.href = '/account';
			return;
		}
		error.value = result.message;
		busy.value = false;
	});

	return (
		<div class="flex flex-col justify-center py-12 sm:px-6 lg:px-8">
			<div class="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
				<div class="bg-[#F9F7F4] py-8 px-4 shadow-sm sm:rounded-lg sm:px-10">
					<h3 class="text-lg font-medium text-gray-900 mb-2">Confirm your sign-in</h3>
					<p class="text-sm text-gray-600 mb-4">
						Only continue if you just tried to sign in. If you did not, close this page: nothing happens unless you confirm.
					</p>
					{error.value !== '' && (
						<div class="rounded-md bg-red-50 p-4 mb-4">
							<div class="flex">
								<div class="shrink-0">
									<XCircleIcon />
								</div>
								<div class="ml-3">
									<p class="text-sm text-red-700">{error.value}</p>
									<a href="/sign-in" class="text-sm text-red-700 underline mt-2 inline-block">Back to sign in</a>
								</div>
							</div>
						</div>
					)}
					<button type="button" id="confirm-sign-in" class="w-full rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={busy.value || !token.value} onClick$={confirm}>
						{busy.value ? 'Signing you in...' : 'Confirm sign-in'}
					</button>
				</div>
			</div>
		</div>
	);
});
