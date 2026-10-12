// Fixture view: the shell footer.
import { component$ } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'shell.footer'>>((props) => (
	<footer data-testid="view-footer">{`${props.identity.storeName} ${props.year} ${props.paymentLabels.join(',')}`}</footer>
));
