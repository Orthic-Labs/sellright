// Fixture: data props (productId, productName, soldOut) reach the slot, and a handler declared inside the slot runs
// after resume (its own signal + onClick$ QRL).
import { component$, useSignal } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'pdp.waitlist'>>(({ productId, productName, soldOut }) => {
	const clicks = useSignal(0);
	return (
		<div data-testid="slot-pdp-waitlist" data-sold-out={String(soldOut)} data-product-id={String(productId)}>
			<span data-testid="slot-pdp-waitlist-name">{`fixture-waitlist:${productName}`}</span>
			<button type="button" data-testid="slot-pdp-waitlist-button" onClick$={() => { clicks.value++; }}>join</button>
			<span data-testid="slot-pdp-waitlist-clicks">{String(clicks.value)}</span>
		</div>
	);
});
