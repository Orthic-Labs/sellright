import { component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { estimatePointsEarned, type SrLoyaltyProgram } from '~/utils/sellright';
import { formatPoints, loadLoyaltyProgram } from './loyalty-program';

/**
 * "Earn N points" line for cart/checkout totals. Display-only estimate on
 * merchandise after discounts (shipping and tax never earn); the order's
 * real points are computed server-side and posted once it is paid.
 */
export const LoyaltyEarnHint = component$<{ eligibleCents: number; dark?: boolean }>(({ eligibleCents, dark }) => {
	const program = useSignal<SrLoyaltyProgram | null>(null);
	useVisibleTask$(async () => {
		program.value = await loadLoyaltyProgram();
	});
	const points = estimatePointsEarned(eligibleCents, program.value);
	if (!program.value || points <= 0) return null;
	return (
		<p
			class={dark ? 'text-[12px] text-[rgba(253,250,246,0.5)]' : 'text-sm text-gray-600'}
			data-testid="loyalty-earn-hint"
		>
			Earn <span class="font-medium tabular-nums">{formatPoints(points)}</span> points with this order
			<span class={dark ? 'text-[rgba(253,250,246,0.35)]' : 'text-gray-400'}> (signed-in customers)</span>
		</p>
	);
});
