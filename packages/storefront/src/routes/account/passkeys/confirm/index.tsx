import { $, component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { confirmMailboxGrant, deletePasskey, PASSKEY_INTENT_KEY, registerPasskey } from '~/providers/shop/account/passkeys';
import { createSEOHead } from '~/utils/seo';

const BTN =
	'w-full flex justify-center items-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[var(--color-accent)] hover:bg-[#4F3B26] focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)] cursor-pointer disabled:opacity-60';
const INPUT = 'block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-[var(--color-accent)] focus:border-[var(--color-accent)] text-sm';

/**
 * Landing page for the emailed passkey confirmation link. It never redeems on load (mail scanners fetch URLs), only on a
 * click. It then finishes what the shopper started on /account/passkeys: naming and creating a new passkey, or removing one.
 */
export default component$(() => {
	const token = useSignal('');
	const grant = useSignal('');
	const kind = useSignal<'add' | 'remove'>('add');
	const targetId = useSignal('');
	const label = useSignal('');
	const error = useSignal('');
	const busy = useSignal(false);
	const terminal = useSignal(false);

	useVisibleTask$(() => {
		token.value = new URLSearchParams(window.location.search).get('token') ?? '';
		if (!token.value) {
			error.value = 'No token found in the URL. Please click the link in your email again.';
			terminal.value = true;
		}
		try {
			const raw = sessionStorage.getItem(PASSKEY_INTENT_KEY);
			const parsed = raw ? (JSON.parse(raw) as { kind?: string; id?: string }) : undefined;
			if (parsed?.kind === 'remove' && parsed.id) {
				kind.value = 'remove';
				targetId.value = parsed.id;
			}
		} catch {
			// no stored intent: default to adding a passkey
		}
	});

	const confirm = $(async () => {
		if (busy.value || terminal.value || !token.value) return;
		busy.value = true;
		error.value = '';
		const res = await confirmMailboxGrant(token.value);
		if (!res.ok) {
			error.value = res.message;
			terminal.value = res.code === 'CEREMONY_INVALID';
			busy.value = false;
			return;
		}
		if (kind.value === 'remove') {
			const done = await deletePasskey(targetId.value, res.grant);
			if (!done.ok) {
				error.value = done.message;
				busy.value = false;
				return;
			}
			try {
				sessionStorage.removeItem(PASSKEY_INTENT_KEY);
			} catch {
				// ignore
			}
			window.location.href = '/account/passkeys';
			return;
		}
		grant.value = res.grant;
		busy.value = false;
	});

	const create = $(async () => {
		const name = label.value.trim();
		if (busy.value || !grant.value) return;
		if (!name || name.length > 64) {
			error.value = 'Give this passkey a name of 1 to 64 characters.';
			return;
		}
		busy.value = true;
		error.value = '';
		const res = await registerPasskey(grant.value, name);
		if (!res.ok) {
			error.value = res.message;
			busy.value = false;
			return;
		}
		try {
			sessionStorage.removeItem(PASSKEY_INTENT_KEY);
		} catch {
			// ignore
		}
		window.location.href = '/account/passkeys';
	});

	return (
		<div class="max-w-md mx-auto">
			<div class="bg-white rounded-lg shadow-soft border border-gray-100/50 p-6 space-y-4" data-testid="passkey-confirm">
				<h2 class="text-lg font-heading font-medium text-gray-900">{kind.value === 'remove' ? 'Confirm passkey removal' : 'Add a passkey'}</h2>
				{!grant.value && <p class="text-sm text-gray-600">Only continue if you just asked for this. If you did not, close this page: nothing happens unless you confirm.</p>}
				{error.value && (
					<p class="text-sm text-red-700" role="alert">
						{error.value}
					</p>
				)}
				{terminal.value ? (
					<a href="/account/passkeys" class={BTN}>
						Back to passkeys
					</a>
				) : grant.value ? (
					<div class="space-y-3" data-testid="passkey-confirm-label">
						<label class="block text-sm font-medium text-gray-700" for="passkey-confirm-label-input">
							Name this passkey
						</label>
						<input id="passkey-confirm-label-input" type="text" maxLength={64} class={INPUT} value={label.value} onInput$={(_, el) => (label.value = el.value)} />
						<button type="button" class={BTN} disabled={busy.value} onClick$={create}>
							{busy.value ? 'Waiting for your device…' : 'Create passkey'}
						</button>
					</div>
				) : (
					<button type="button" id="confirm-passkey-link" class={BTN} disabled={busy.value} onClick$={confirm}>
						{busy.value ? 'Confirming…' : 'Confirm'}
					</button>
				)}
			</div>
		</div>
	);
});

export const head = () =>
	createSEOHead({
		title: 'Confirm Passkey Request',
		description: 'Confirm a passkey request.',
		noindex: true,
	});
