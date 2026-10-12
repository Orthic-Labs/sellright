import { component$ } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';
// Fixture: the live price prop reaches the slot.
export default component$<SlotProps<'pdp.payment-widget'>>(({ priceCents }) => {
	return <div data-testid="slot-pdp-payment-widget" data-price={String(priceCents)}>{`fixture-widget:${priceCents}`}</div>;
});
