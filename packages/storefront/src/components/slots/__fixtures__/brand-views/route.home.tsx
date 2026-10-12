// Fixture view: the homepage with the newsletter form driven by the platform's `onSubscribe$`.
import { component$, useSignal } from '@qwik.dev/core';
import { Link, TurnstileMount, formatMoney } from '~/platform/views';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'route.home'>>((props) => {
	const email = useSignal('');
	const outcome = useSignal('');
	return (
		<main data-testid="view-home">
			<h1>{props.identity.tagline}</h1>
			<ul data-testid="view-home-featured">
				{props.featured.map((p) => (
					<li key={p.slug}><Link href={p.href}>{p.name}</Link> {formatMoney(p.priceCents, p.currencyCode)}</li>
				))}
			</ul>
			<input data-testid="view-home-email" type="email" value={email.value} onInput$={(_, el) => { email.value = el.value; }} />
			<TurnstileMount for="newsletter" />
			<button type="button" data-testid="view-home-subscribe" onClick$={async () => {
				const r = await props.onSubscribe$(email.value, '');
				outcome.value = r.ok ? 'ok' : r.reason;
			}}>subscribe</button>
			<span data-testid="view-home-status">{props.newsletter.status}</span>
			<span data-testid="view-home-message">{props.newsletter.message ?? ''}</span>
			<span data-testid="view-home-outcome">{outcome.value}</span>
		</main>
	);
});
