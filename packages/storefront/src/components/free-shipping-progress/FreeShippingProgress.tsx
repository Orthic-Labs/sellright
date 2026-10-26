import { component$ } from '@qwik.dev/core';
import { formatPrice } from '~/utils';
import type { SlotProps } from '~/components/slots/registry';

/**
 * Cart drawer: "$X away from free shipping" with a progress bar (the previous platform's cart's FreeShippingProgress markup and colours). The base
 * implementation of the `cart.free-shipping-progress` slot, shown when the brand supplies none. It reads only the server's tier
 * (`freeShipping`, from POST /v1/shop/shipping-methods): no thresholds live here. Nothing shows until the server has quoted a
 * reachable tier, which also covers an unknown country and a cart that already ships free.
 */
export const FreeShippingProgress = component$<SlotProps<'cart.free-shipping-progress'>>(({ freeShipping, currencyCode }) => {
	if (!freeShipping || freeShipping.threshold <= 0 || freeShipping.remaining <= 0) return null;

	const progress = Math.min(100, Math.max(0, ((freeShipping.threshold - freeShipping.remaining) / freeShipping.threshold) * 100));

	return (
		<div class="bg-[var(--color-parchment)] border border-[var(--color-card-border)] rounded-md p-3 mb-4" data-testid="free-shipping-progress">
			<div class="flex items-center justify-between mb-2">
				<span class="text-sm text-[var(--color-ink)]">Free Shipping</span>
				<span class="text-xs text-[#9A9288]">{formatPrice(freeShipping.remaining, currencyCode)} away</span>
			</div>

			{/* Progress Bar */}
			<div class="w-full bg-[var(--color-card-border)] rounded-full h-1.5">
				<div
					class="bg-[#965341] h-1.5 rounded-full transition-all duration-300 ease-out"
					data-testid="free-shipping-progress-bar"
					style={`width: ${progress}%`}
				></div>
			</div>
		</div>
	);
});
