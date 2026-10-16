import { component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import type { LoyaltyProgram } from '~/sellright/types/rewards';
import { pointsLabel } from '~/utils/rewards';
import { estimatePointsEarned } from '~/utils/sellright';
import { loadLoyaltyProgram } from './loyalty-program';

/**
 * "Earn N points" line for cart/checkout totals. Display-only: the order's
 * real points are computed server-side and posted once it is paid.
 *
 * `serverPoints` is the API's own `pointsToEarn` from the priced cart (it
 * already reflects discounts and per-product multipliers). When the cart
 * response carries no figure, fall back to an estimate on merchandise after
 * discounts from the store's program rate. Either way nothing renders while
 * the program is off (the program settings come from GET /v1/shop/config).
 */
export const LoyaltyEarnHint = component$<{ eligibleCents: number; dark?: boolean; serverPoints?: number }>(
	({ eligibleCents, dark, serverPoints }) => {
		const program = useSignal<LoyaltyProgram | null>(null);
		useVisibleTask$(async () => {
			program.value = await loadLoyaltyProgram();
		});
		const points = typeof serverPoints === 'number' ? serverPoints : estimatePointsEarned(eligibleCents, program.value);
		if (!program.value || points <= 0) return null;
		return (
			<p
				class={dark ? 'text-[12px] text-[rgba(253,250,246,0.5)]' : 'text-sm text-gray-600'}
				data-testid="loyalty-earn-hint"
			>
				Earn <span class="font-medium tabular-nums">{pointsLabel(points)}</span> with this order
				<span class={dark ? 'text-[rgba(253,250,246,0.35)]' : 'text-gray-400'}> (signed-in customers)</span>
			</p>
		);
	},
);
