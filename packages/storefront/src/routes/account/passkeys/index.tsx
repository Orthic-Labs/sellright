import { $, component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import {
	deletePasskey,
	grantWithPasskey,
	listPasskeys,
	PASSKEY_INTENT_KEY,
	PASSKEY_UNSUPPORTED_MESSAGE,
	registerPasskey,
	requestGrantWithPassword,
	requestMailboxGrant,
	type PasskeyItem,
} from '~/providers/shop/account/passkeys';
import { createSEOHead } from '~/utils/seo';

const BTN =
	'inline-flex items-center justify-center px-4 py-2 text-sm font-medium rounded-md border border-transparent text-white bg-[var(--color-accent)] hover:bg-[#4F3B26] focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)] cursor-pointer disabled:opacity-60';
const BTN_SECONDARY = 'inline-flex items-center justify-center px-4 py-2 text-sm font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-[#F9F7F4] cursor-pointer disabled:opacity-60';
const INPUT = 'block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-[var(--color-accent)] focus:border-[var(--color-accent)] text-sm';

type Intent = '' | 'add' | 'remove';
type Step = 'idle' | 'grant' | 'label';

export default component$(() => {
	const items = useSignal<PasskeyItem[]>([]);
	const loaded = useSignal(false);
	const supported = useSignal(true);
	const busy = useSignal(false);
	const error = useSignal('');
	const notice = useSignal('');
	const intent = useSignal<Intent>('');
	const step = useSignal<Step>('idle');
	const targetId = useSignal('');
	const grant = useSignal('');
	const password = useSignal('');
	const label = useSignal('');
	const mailSent = useSignal(false);

	const refresh = $(async () => {
		const res = await listPasskeys();
		if (res.ok) items.value = res.items;
		else error.value = res.message;
		loaded.value = true;
	});

	useVisibleTask$(async () => {
		supported.value = browserSupportsWebAuthn();
		await refresh();
	});

	const reset = $(() => {
		intent.value = '';
		step.value = 'idle';
		targetId.value = '';
		grant.value = '';
		password.value = '';
		label.value = '';
		mailSent.value = false;
		busy.value = false;
	});

	const begin = $((kind: Intent, id: string) => {
		error.value = '';
		notice.value = '';
		intent.value = kind;
		targetId.value = id;
		mailSent.value = false;
		step.value = 'grant';
	});

	/** A grant is in hand: continue to the label prompt (add) or perform the removal (remove). */
	const onGrant = $(async (g: string) => {
		if (intent.value === 'remove') {
			const res = await deletePasskey(targetId.value, g);
			if (res.ok) notice.value = 'Passkey removed.';
			else error.value = res.message;
			await reset();
			await refresh();
			return;
		}
		grant.value = g;
		step.value = 'label';
		busy.value = false;
	});

	const withPassword = $(async () => {
		if (busy.value || !password.value) return;
		busy.value = true;
		error.value = '';
		const res = await requestGrantWithPassword(password.value);
		password.value = '';
		if (!res.ok) {
			error.value = res.message;
			busy.value = false;
			return;
		}
		await onGrant(res.grant);
	});

	const withPasskey = $(async () => {
		if (busy.value) return;
		busy.value = true;
		error.value = '';
		const res = await grantWithPasskey();
		if (!res.ok) {
			error.value = res.message;
			busy.value = false;
			return;
		}
		await onGrant(res.grant);
	});

	const withEmail = $(async () => {
		if (busy.value) return;
		busy.value = true;
		error.value = '';
		try {
			sessionStorage.setItem(PASSKEY_INTENT_KEY, JSON.stringify({ kind: intent.value, id: targetId.value }));
		} catch {
			// storage blocked: the confirm page then defaults to adding a passkey
		}
		const res = await requestMailboxGrant();
		busy.value = false;
		if (res.ok) mailSent.value = true;
		else error.value = res.message;
	});

	const submitLabel = $(async () => {
		const name = label.value.trim();
		if (busy.value || !grant.value) return;
		if (!name || name.length > 64) {
			error.value = 'Give this passkey a name of 1 to 64 characters.';
			return;
		}
		busy.value = true;
		error.value = '';
		const res = await registerPasskey(grant.value, name);
		if (res.ok) notice.value = 'Passkey added.';
		else error.value = res.message;
		await reset();
		await refresh();
	});

	const startAdd = $(() => begin('add', ''));
	const startRemove = $((id: string) => begin('remove', id));

	return (
		<div class="max-w-xl">
			<div class="bg-white rounded-lg shadow-soft border border-gray-100/50 overflow-hidden" data-testid="passkeys-page">
				<div class="p-6 border-b border-gray-100">
					<h2 class="text-lg font-heading font-medium text-gray-900">Passkeys</h2>
					<p class="mt-1 text-sm text-gray-600">Sign in with your fingerprint, face or device PIN instead of a password.</p>
				</div>
				<div class="p-6 space-y-5">
					{notice.value && (
						<p class="text-sm text-green-700" role="status" data-testid="passkeys-notice">
							{notice.value}
						</p>
					)}
					{error.value && (
						<p class="text-sm text-red-700" role="alert" data-testid="passkeys-error">
							{error.value}
						</p>
					)}
					{!supported.value && <p class="text-sm text-gray-600">{PASSKEY_UNSUPPORTED_MESSAGE}</p>}

					{loaded.value && items.value.length === 0 && <p class="text-sm text-gray-600">You have no passkeys yet.</p>}
					{items.value.length > 0 && (
						<ul class="divide-y divide-gray-100" data-testid="passkey-list">
							{items.value.map((p) => (
								<li key={p.id} class="py-3 flex items-start justify-between gap-4">
									<div class="min-w-0">
										<p class="text-sm font-medium text-gray-900 truncate">{p.label}</p>
										<p class="text-xs text-gray-500">
											{p.backedUp || p.deviceType === 'multiDevice' ? 'Synced across your devices' : 'This device only'}
											{' · '}Added {new Date(p.createdAt).toLocaleDateString()}
											{' · '}
											{p.lastUsedAt ? `Last used ${new Date(p.lastUsedAt).toLocaleDateString()}` : 'Never used'}
										</p>
									</div>
									<button type="button" class={BTN_SECONDARY} data-id={p.id} data-testid="passkey-remove" disabled={busy.value || step.value !== 'idle'} onClick$={(_, el) => startRemove(el.dataset.id ?? '')}>
										Remove
									</button>
								</li>
							))}
						</ul>
					)}

					{step.value === 'idle' && (
						<button type="button" class={BTN} disabled={!supported.value || busy.value} data-testid="passkey-add" onClick$={startAdd}>
							Add a passkey
						</button>
					)}

					{step.value === 'grant' && (
						<div class="rounded-md border border-gray-200 p-4 space-y-4" data-testid="passkey-grant">
							<p class="text-sm font-medium text-gray-900">{intent.value === 'remove' ? 'Confirm it is you to remove this passkey' : 'Confirm it is you to add a passkey'}</p>
							{mailSent.value ? (
								<p class="text-sm text-gray-700" role="status" data-testid="passkey-mail-sent">
									Check your email. If this account can use it, we sent a link that continues here. Open it in this same browser; it expires soon.
								</p>
							) : (
								<>
									<div>
										<label class="block text-sm font-medium text-gray-700 mb-1" for="passkey-password">
											Password
										</label>
										<input
											id="passkey-password"
											type="password"
											autoComplete="current-password"
											class={INPUT}
											value={password.value}
											onInput$={(_, el) => (password.value = el.value)}
											onKeyUp$={(ev) => {
												if (ev.key === 'Enter') withPassword();
											}}
										/>
										<button type="button" class={`${BTN} mt-2`} disabled={busy.value || !password.value} data-testid="passkey-grant-password" onClick$={withPassword}>
											Continue with password
										</button>
									</div>
									{items.value.length > 0 && (
										<button type="button" class={BTN_SECONDARY} disabled={busy.value} data-testid="passkey-grant-passkey" onClick$={withPasskey}>
											Use an existing passkey
										</button>
									)}
									<button type="button" class={BTN_SECONDARY} disabled={busy.value} data-testid="passkey-grant-email" onClick$={withEmail}>
										Email me a link instead
									</button>
								</>
							)}
							<button type="button" class="text-sm text-gray-600 underline cursor-pointer" onClick$={reset}>
								Cancel
							</button>
						</div>
					)}

					{step.value === 'label' && (
						<div class="rounded-md border border-gray-200 p-4 space-y-3" data-testid="passkey-label">
							<label class="block text-sm font-medium text-gray-700" for="passkey-label-input">
								Name this passkey
							</label>
							<input
								id="passkey-label-input"
								type="text"
								maxLength={64}
								class={INPUT}
								placeholder="For example: Work laptop"
								value={label.value}
								onInput$={(_, el) => (label.value = el.value)}
								onKeyUp$={(ev) => {
									if (ev.key === 'Enter') submitLabel();
								}}
							/>
							<div class="flex gap-3">
								<button type="button" class={BTN} disabled={busy.value} data-testid="passkey-save" onClick$={submitLabel}>
									{busy.value ? 'Waiting for your device…' : 'Create passkey'}
								</button>
								<button type="button" class={BTN_SECONDARY} disabled={busy.value} onClick$={reset}>
									Cancel
								</button>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
});

export const head = () =>
	createSEOHead({
		title: 'Passkeys',
		description: 'Manage the passkeys you use to sign in.',
		noindex: true,
	});
