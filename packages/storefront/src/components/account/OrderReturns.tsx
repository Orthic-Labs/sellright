import { $, component$, useSignal, useStore, useVisibleTask$ } from '@qwik.dev/core';
import { getOrderReturns, requestOrderReturn } from '~/services/customer';
import type { OrderReturns } from '~/sellright/types/account';

const STATUS_LABEL: Record<OrderReturns['items'][number]['status'], { label: string; hint: string }> = {
	requested: { label: 'Return requested', hint: 'We are reviewing your request.' },
	approved: { label: 'Return approved', hint: 'Your refund is being processed.' },
	received: { label: 'Return received', hint: 'We have your items and are processing your refund.' },
	refunded: { label: 'Refunded', hint: 'Your refund has been issued to your original payment method.' },
	rejected: { label: 'Return not approved', hint: 'Contact us if you have questions about this decision.' },
};

const FIELD = 'border border-gray-300 rounded-sm py-2 px-2 text-sm bg-white';

/**
 * Account order page -> Returns. Read live from the API every time (what can still be returned, and each request's
 * status as the merchant last set it); nothing about eligibility is decided in the browser.
 */
export const OrderReturnsPanel = component$<{ code: string }>(({ code }) => {
	const data = useSignal<OrderReturns | null>(null);
	const open = useSignal(false);
	const qty = useStore<Record<string, number>>({});
	const reason = useSignal('');
	const error = useSignal('');
	const sending = useSignal(false);
	const justSent = useSignal(false);

	const reload = $(async () => {
		data.value = await getOrderReturns(code);
	});

	useVisibleTask$(async () => {
		try {
			await reload();
		} catch {
			data.value = null;
		}
	});

	const submit = $(async () => {
		error.value = '';
		const lines = Object.entries(qty).filter(([, n]) => n > 0).map(([sku, quantity]) => ({ sku, quantity }));
		if (lines.length === 0) { error.value = 'Choose at least one item to return.'; return; }
		if (reason.value.trim().length < 3) { error.value = 'Tell us briefly why you are returning it.'; return; }
		sending.value = true;
		const res = await requestOrderReturn(code, { lines, reason: reason.value.trim() });
		sending.value = false;
		if (!res.ok) { error.value = res.message; await reload(); return; }
		open.value = false;
		justSent.value = true;
		reason.value = '';
		for (const k of Object.keys(qty)) delete qty[k];
		await reload();
	});

	const d = data.value;
	if (!d || (d.items.length === 0 && d.returnable.length === 0)) return null;

	return (
		<div class="bg-gray-100 p-6" data-testid="order-returns">
			<p class="mb-3 text-gray-600 text-sm">Returns</p>
			{d.items.map((r) => (
				<div key={r.id} class="mb-3 text-sm" data-testid="return-request">
					<p class="font-medium">
						<span data-testid="return-status">{STATUS_LABEL[r.status].label}</span>
						<span class="text-gray-500 font-normal"> · {r.lines.map((l) => `${l.quantity} × ${l.name}`).join(', ')}</span>
					</p>
					<p class="text-gray-600">{STATUS_LABEL[r.status].hint}</p>
				</div>
			))}
			{justSent.value && <p class="text-sm text-gray-700 mb-3" role="status">Thanks, your return request was sent.</p>}

			{d.returnable.length > 0 && !open.value && (
				<button
					type="button"
					class="px-4 py-2 text-sm font-medium text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] min-h-[44px] cursor-pointer"
					onClick$={() => { open.value = true; justSent.value = false; }}
				>
					Request a return
				</button>
			)}

			{open.value && (
				<form class="grid gap-3 max-w-md" preventdefault:submit onSubmit$={submit} aria-label="Request a return">
					{d.returnable.map((l) => (
						<label key={l.sku} class="flex items-center justify-between gap-3 text-sm text-gray-800">
							<span>{l.name} <span class="text-xs text-gray-500 font-mono">{l.sku}</span></span>
							<select
								class={FIELD}
								aria-label={`Quantity of ${l.name} to return`}
								data-sku={l.sku}
								onChange$={(_, el) => { qty[el.dataset.sku ?? ''] = Number(el.value); }}
							>
								{Array.from({ length: l.quantity + 1 }, (_, i) => <option key={`q${i}`} value={String(i)}>{String(i)}</option>)}
							</select>
						</label>
					))}
					<label class="grid gap-1 text-sm text-gray-800">Reason for the return
						<textarea class={FIELD} rows={3} maxLength={2000} value={reason.value} onInput$={(_, el) => { reason.value = el.value; }} />
					</label>
					{error.value && <p class="text-sm text-red-700" role="alert">{error.value}</p>}
					<div class="flex gap-3">
						<button type="submit" disabled={sending.value} class="px-4 py-2 text-sm font-medium text-white bg-[var(--color-accent)] disabled:opacity-60 min-h-[44px] cursor-pointer">
							{sending.value ? 'Sending...' : 'Send return request'}
						</button>
						<button type="button" class="px-4 py-2 text-sm border border-gray-400 min-h-[44px] cursor-pointer" onClick$={() => { open.value = false; error.value = ''; }}>Cancel</button>
					</div>
				</form>
			)}
		</div>
	);
});
