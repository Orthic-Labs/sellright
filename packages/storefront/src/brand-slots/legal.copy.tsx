// Base default for the `legal.copy` slot: the payment-processor names the privacy page used to hard-code.
import { component$ } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'legal.copy'>>(({ section }) => {
	return section === 'privacy.payment-processors' ? <>NMI, Sezzle, and other payment service providers</> : null;
});
