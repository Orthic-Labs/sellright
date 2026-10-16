// Fixture: data props only.
import { component$ } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'account.sustainability-badge'>>(({ orderCount, statsLoaded }) => {
	return <div data-testid="slot-account-badge">{`fixture-account:${statsLoaded ? orderCount : 'loading'}`}</div>;
});
