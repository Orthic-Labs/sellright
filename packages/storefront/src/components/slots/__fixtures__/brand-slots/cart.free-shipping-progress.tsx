// Fixture: a state-driven prop (the cart subtotal and line count) updates the slot after the cart changes post-resume.
import { component$ } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'cart.free-shipping-progress'>>(({ currencyCode, subtotalCents, lineCount, isCheckoutView }) => {
	return (
		<div data-testid="slot-cart-progress" data-checkout={String(isCheckoutView)}>
			{`fixture-cart:${lineCount}:${subtotalCents}:${currencyCode}`}
		</div>
	);
});
