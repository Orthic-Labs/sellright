import { component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import type { LoyaltyProgram } from '~/sellright/types/rewards';
import { pdpEarnPoints, pointsLabel, productMultiplier } from '~/utils/rewards';
import { loadLoyaltyProgram } from './loyalty-program';

/**
 * PDP: "Earn N points with this purchase", with a multiplier badge when the
 * product has one. Driven entirely by the store's loyalty settings
 * (GET /v1/shop/config `loyalty`) — no rate lives in the storefront — and
 * renders nothing while the program is off or the config can't be read.
 * Display-only: the order's real points are computed by the API at checkout.
 */
export const LoyaltyPdpEarn = component$<{ cents: number; productId?: string | null; from?: boolean }>(
	({ cents, productId, from }) => {
		const program = useSignal<LoyaltyProgram | null>(null);
		useVisibleTask$(async () => {
			program.value = await loadLoyaltyProgram();
		});
		const pts = pdpEarnPoints({ priceCents: cents, productId, program: program.value });
		if (!program.value || pts <= 0) return null;
		const mult = productMultiplier(program.value, productId);
		return (
			<p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-snug mb-2" style="color:var(--mid)" data-testid="pdp-earn-points">
				<span>
					Earn {from ? 'from ' : ''}
					<strong class="font-semibold" style="color:var(--ink)">{pointsLabel(pts)}</strong> with this purchase
				</span>
				{mult && (
					<span class="px-2 py-px rounded-sm text-[12px] tracking-wide text-white" style="background:var(--gold)">{mult}x points</span>
				)}
			</p>
		);
	},
);
