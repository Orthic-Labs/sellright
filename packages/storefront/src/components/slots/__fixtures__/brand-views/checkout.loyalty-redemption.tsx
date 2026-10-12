// Fixture view: the points-redemption control. It can only ask `onRedeemToggle$`.
import { component$, useSignal } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'checkout.loyalty-redemption'>>((props) => {
	const result = useSignal('');
	return (
		<div data-testid="view-loyalty" data-balance={String(props.balance)} data-min={String(props.minRedeemPoints)}>
			<span data-testid="view-loyalty-offer">{props.offer ? `${props.offer.points}:${props.offer.discountCents}` : 'none'}</span>
			<span data-testid="view-loyalty-applied">{props.applied ? `${props.applied.points}:${props.applied.discountCents}` : 'none'}</span>
			<button type="button" data-testid="view-loyalty-on" onClick$={async () => { const r = await props.onRedeemToggle$(true); result.value = r.ok ? 'ok' : r.reason; }}>on</button>
			<button type="button" data-testid="view-loyalty-off" onClick$={async () => { const r = await props.onRedeemToggle$(false); result.value = r.ok ? 'ok' : r.reason; }}>off</button>
			<span data-testid="view-loyalty-result">{result.value}</span>
		</div>
	);
});
