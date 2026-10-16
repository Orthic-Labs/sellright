import { component$ } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';
// Fixture: a required prop (`section`) reaches the slot.
export default component$<SlotProps<'legal.copy'>>(({ section }) => {
	return <span data-testid="slot-legal-copy">{`fixture-legal:${section}`}</span>;
});
