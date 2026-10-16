import { component$ } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';
// Fixture (e2e/slots.spec.ts): slot supplied, static props.
export default component$<SlotProps<'payment.badges'>>(({ placement }) => {
	return <span data-testid="slot-payment-badges" data-placement={placement}>fixture-badges</span>;
});
