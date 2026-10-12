// Fixture view: the contact page with the platform-managed form.
import { component$, useSignal } from '@qwik.dev/core';
import { TurnstileMount } from '~/platform/views';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'route.contact'>>((props) => {
	const name = useSignal('');
	const email = useSignal('');
	const message = useSignal('');
	const outcome = useSignal('');
	return (
		<main data-testid="view-contact">
			<input data-testid="view-contact-name" value={name.value} onInput$={(_, el) => { name.value = el.value; }} />
			<input data-testid="view-contact-email" type="email" value={email.value} onInput$={(_, el) => { email.value = el.value; }} />
			<textarea data-testid="view-contact-message" value={message.value} onInput$={(_, el) => { message.value = el.value; }} />
			<TurnstileMount for="contact" />
			<button type="button" data-testid="view-contact-send" onClick$={async () => {
				const r = await props.onSubmit$(name.value, email.value, 'GENERAL', message.value, '');
				outcome.value = r.ok ? 'ok' : r.reason;
			}}>send</button>
			<span data-testid="view-contact-status">{props.form.status}</span>
			<span data-testid="view-contact-message-out">{props.form.message ?? ''}</span>
			<span data-testid="view-contact-outcome">{outcome.value}</span>
		</main>
	);
});
