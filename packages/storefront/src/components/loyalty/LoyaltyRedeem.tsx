import { $, component$, useSignal, useVisibleTask$, type Signal } from '@qwik.dev/core';
import { formatPrice } from '~/utils';
import { previewRedemption, srAccountLoyalty, type SrAccountLoyalty } from '~/utils/sellright';
import { formatPoints } from './loyalty-program';

/**
 * Checkout control: spend the shopper's points for money off. Sets
 * `redeemPoints` (0 = off); the server re-validates the balance under a lock,
 * applies the discount before tax, and 409s if the points are no longer
 * available. Renders nothing for guests or when the program is off.
 */
export const LoyaltyRedeem = component$<{ redeemPoints: Signal<number>; discountableCents: number; currencyCode?: string }>(
	({ redeemPoints, discountableCents, currencyCode = 'USD' }) => {
		const account = useSignal<SrAccountLoyalty | null>(null);
		useVisibleTask$(async () => {
			try {
				const data = await srAccountLoyalty();
				account.value = data.program.enabled ? data : null;
			} catch {
				account.value = null; // guest (401) or unavailable → no control
			}
		});
		const toggle = $((on: boolean) => {
			const a = account.value;
			const plan = a ? previewRedemption(a.available, a.available, discountableCents, a.program) : null;
			redeemPoints.value = on && plan ? plan.points : 0;
		});

		const a = account.value;
		if (!a) return null;
		const best = previewRedemption(a.available, a.available, discountableCents, a.program);
		const applied = redeemPoints.value > 0 ? previewRedemption(redeemPoints.value, a.available, discountableCents, a.program) : null;
		return (
			<div class="px-4 py-3 border-t border-[rgba(var(--color-accent-rgb),0.25)] text-[13px] text-[rgba(253,250,246,0.7)]" data-testid="loyalty-redeem">
				<div class="flex items-center justify-between gap-3">
					<span>
						You have <span class="font-medium tabular-nums">{formatPoints(a.available)}</span> points
					</span>
					{best ? (
						<label class="inline-flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={redeemPoints.value > 0}
								onChange$={(_, el) => toggle(el.checked)}
							/>
							<span>Use {formatPoints(best.points)} for {formatPrice(best.discountCents, currencyCode)} off</span>
						</label>
					) : (
						<span class="text-[rgba(253,250,246,0.45)]">
							{a.available > 0 && a.available < a.program.minRedeemPoints
								? `Minimum ${formatPoints(a.program.minRedeemPoints)} points to redeem`
								: 'Not enough points to redeem yet'}
						</span>
					)}
				</div>
				{applied && (
					<p class="mt-1 text-[12px] text-[rgba(253,250,246,0.5)]">
						−{formatPrice(applied.discountCents, currencyCode)} will be applied before tax when you place the order.
					</p>
				)}
			</div>
		);
	},
);
