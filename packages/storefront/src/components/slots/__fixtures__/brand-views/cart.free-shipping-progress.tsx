// Fixture view: a country-conditional free-shipping band over the discounted amount.
import { component$ } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'cart.free-shipping-progress'>>((props) => (
	<div data-testid="view-free-shipping" data-country={props.countryCode ?? 'none'} data-checkout={String(props.isCheckoutView)}>
		{`band:${props.countryCode ?? 'none'}:${props.discountedSubtotalCents}:${props.subtotalCents}`}
	</div>
));
