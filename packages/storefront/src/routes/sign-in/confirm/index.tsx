import { $, component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import XCircleIcon from '~/components/icons/XCircleIcon';
import { confirmFederatedSignIn } from '~/providers/shop/account/google-auth';
import { createSEOHead } from '~/utils/seo';

export const head = createSEOHead({
	title: 'Confirm Sign-In',
	description: 'Confirm your sign-in.',
	noindex: true,
});

// Same primary button as the /sign-in card.
const PRIMARY =
	'w-full flex justify-center items-center gap-2 py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[var(--color-accent)] hover:bg-[#4F3B26] focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)] transition-colors cursor-pointer';

/**
 * Landing page for the link mailed when a sign-in provider (Google or Apple) could not vouch for the address. It never
 * redeems on load — mail scanners and link previews fetch URLs — only on an explicit click. The link works only in the
 * browser that started the sign-in (the API checks a cookie set then). After a terminal failure the only action offered
 * is the way back to sign-in.
 */
export default component$(() => {
	const token = useSignal('');
	const error = useSignal('');
	const busy = useSignal(false);
	/** The link can never work (no token, expired/used/other browser, blocked account): hide Confirm, offer Back to sign in. */
	const terminal = useSignal(false);

	useVisibleTask$(() => {
		token.value = new URLSearchParams(window.location.search).get('token') ?? '';
		if (!token.value) {
			error.value = 'No sign-in token found in the URL. Please click the link in your email again.';
			terminal.value = true;
		}
	});

	const confirm = $(async () => {
		if (busy.value || terminal.value || !token.value) return;
		busy.value = true;
		error.value = '';
		const result = await confirmFederatedSignIn(token.value);
		if (result.ok) {
			window.location.href = '/account';
			return;
		}
		error.value = result.message;
		terminal.value = 'terminal' in result && result.terminal === true;
		busy.value = false;
	});

	return (
		<div class="min-h-screen bg-gray-50 flex items-start justify-center py-16 px-4 sm:px-6 lg:px-8">
			<div class="w-full max-w-md">
				<div class="bg-[#F9F7F4] rounded-2xl p-8 shadow-sm">
					<div class="text-center mb-8">
						<h1 class="text-2xl font-bold text-gray-900">Confirm your sign-in</h1>
						<p class="mt-2 text-sm text-gray-600">Only continue if you just tried to sign in. If you did not, close this page: nothing happens unless you confirm.</p>
					</div>
					{error.value !== '' && (
						<div class="rounded-md bg-red-50 p-4 mb-5" role="alert">
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
					{terminal.value ? (
						<a href="/sign-in" id="back-to-sign-in" class={PRIMARY}>
							Back to sign in
						</a>
					) : (
						<button type="button" id="confirm-sign-in" class={PRIMARY} aria-busy={busy.value} aria-disabled={busy.value || !token.value} onClick$={confirm}>
							{busy.value ? (
								<>
									<svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
										<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
										<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
									</svg>
									Signing you in…
								</>
							) : (
								'Confirm sign-in'
							)}
						</button>
					)}
				</div>
			</div>
		</div>
	);
});
