import { $, component$, useId, useSignal, useStylesScoped$, useVisibleTask$ } from '@qwik.dev/core';
import { requestRestock } from '~/providers/shop/waitlist/waitlist';
import { submitRestock } from '~/platform/controllers/restock-form';
import type { FormStatus } from '~/platform/controllers/forms';
import { mountTurnstile, resetTurnstile, TURNSTILE_SITE_KEY } from '~/utils/turnstile-widget';

export interface RestockFormProps { productId: string; productName: string }

/** Opt-in shared form: brands mount this primitive inside their pdp.waitlist slot. */
export const RestockForm = component$<RestockFormProps>((props) => {
	const email = useSignal('');
	const honeypot = useSignal('');
	const token = useSignal('');
	const widgetId = useSignal<string>();
	const disposed = useSignal(false);
	const status = useSignal<FormStatus>('idle');
	const message = useSignal('');
	const formId = useId();
	const containerId = `sr-restock-${formId}`;
	useStylesScoped$(`.sr-restock{border:1px solid var(--rule);padding:20px;margin:20px 0;scroll-margin:100px 0}.sr-restock-title{display:block;margin-bottom:16px}.sr-restock-fields{display:flex;flex-wrap:wrap;gap:10px}.sr-restock-input{flex:1;min-width:160px;min-height:44px;border:1px solid var(--rule);background:var(--white);color:var(--ink);padding:10px}.sr-restock-submit{min-height:44px;padding:10px 18px;background:var(--ink);color:var(--white);border:0;cursor:pointer}.sr-restock-submit:disabled{opacity:.5;cursor:default}.sr-restock-hp{position:absolute;left:-9999px}.sr-restock-error{margin-top:10px}.sr-restock-alt{display:inline-block;margin-top:14px;color:var(--mid)}`);
	useVisibleTask$(({ cleanup }) => {
		disposed.value = false;
		const removeWidget = mountTurnstile(containerId, (value) => { token.value = value; }, () => { token.value = ''; }, (id) => { widgetId.value = id; });
		cleanup(() => { disposed.value = true; token.value = ''; removeWidget(); });
	});
	const submit = $(async () => {
		if (disposed.value) return;
		await submitRestock({
			getStatus: () => status.value,
			setStatus: (value) => { if (!disposed.value) status.value = value; },
			setMessage: (value) => { if (!disposed.value) message.value = value; },
			getToken: () => token.value,
			clearToken: () => { token.value = ''; },
			resetWidget: () => { if (widgetId.value !== undefined) resetTurnstile(widgetId.value); },
			turnstileRequired: !!TURNSTILE_SITE_KEY,
		}, requestRestock, props.productId, email.value, honeypot.value);
	});
	return (
		<section class="sr-restock" aria-label="Back-in-stock notification">
			<strong class="sr-restock-title">Join the waitlist for the next batch</strong>
			{status.value === 'success' ? (
				<p role="status">We'll email you when <strong>{props.productName}</strong> is back in stock.</p>
			) : (
				<form preventdefault:submit onSubmit$={submit}>
					<div class="sr-restock-fields">
						<input type="email" required maxLength={320} autoComplete="email" class="sr-restock-input" aria-label="Email for back-in-stock alert" placeholder="you@email.com" value={email.value} onInput$={(_, el) => { email.value = el.value; }} />
						<input type="text" class="sr-restock-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={honeypot.value} onInput$={(_, el) => { honeypot.value = el.value; }} />
						<button type="submit" class="sr-restock-submit" disabled={status.value === 'sending' || (!!TURNSTILE_SITE_KEY && !token.value)}>{status.value === 'sending' ? 'Adding…' : 'Notify me'}</button>
					</div>
					<div id={containerId} />
					{status.value === 'error' && <p role="alert" class="sr-restock-error">{message.value}</p>}
				</form>
			)}
			<a href="/shop/" class="sr-restock-alt">Explore what's in stock →</a>
		</section>
	);
});
