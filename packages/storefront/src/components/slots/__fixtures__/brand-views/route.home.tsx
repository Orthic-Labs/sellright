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
				// Detachment probe (brand-views.spec.ts): record what arrived, then write to the received object. The platform's own
				// result (a retained module constant for `busy`) must stay pristine for the next call.
				const w = window as unknown as { __srResults?: { objs: object[]; seen: { ok: boolean; reason?: string }[] } };
				const log = (w.__srResults ??= { objs: [], seen: [] });
				log.objs.push(r);
				log.seen.push(r.ok ? { ok: true } : { ok: false, reason: r.reason });
				try { (r as { reason?: string }).reason = 'mutated'; (r as { extra?: number }).extra = 1; } catch { /* frozen in dev builds */ }
			}}>subscribe</button>
			<span data-testid="view-home-status">{props.newsletter.status}</span>
			<span data-testid="view-home-message">{props.newsletter.message ?? ''}</span>
			<span data-testid="view-home-outcome">{outcome.value}</span>
		</main>
	);
});
