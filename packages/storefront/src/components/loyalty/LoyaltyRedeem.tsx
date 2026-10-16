import { component$ } from '@qwik.dev/core';
import { formatPrice } from '~/utils';
import type { SlotProps } from '~/components/slots/registry';
import { formatPoints } from './loyalty-program';

/**
 * Checkout control: spend the shopper's points for money off. Brand views (plan §2.3): the checkout route owns the redemption
 * signal and the loyalty read (platform/controllers/loyalty.ts `useLoyaltyOffer`); this control, and a brand's slot, receive the
 * projection and can only ask `onRedeemToggle$`. The server re-validates the balance under a lock, applies the discount before
 * tax, and 409s if the points are no longer available. The route renders it only for a signed-in shopper with the program on.
 */
export const LoyaltyRedeem = component$<SlotProps<'checkout.loyalty-redemption'>>(
	({ balance, minRedeemPoints, offer, applied, currencyCode, onRedeemToggle$ }) => {
		return (
			<div class="px-4 py-3 border-t border-[rgba(var(--color-accent-rgb),0.25)] text-[13px] text-[rgba(253,250,246,0.7)]" data-testid="loyalty-redeem">
				<div class="flex items-center justify-between gap-3">
					<span>
						You have <span class="font-medium tabular-nums">{formatPoints(balance)}</span> points
					</span>
					{offer ? (
						<label class="inline-flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={!!applied}
								onChange$={(_, el) => onRedeemToggle$(el.checked)}
							/>
							<span>Use {formatPoints(offer.points)} for {formatPrice(offer.discountCents, currencyCode)} off</span>
						</label>
					) : (
						<span class="text-[rgba(253,250,246,0.45)]">
							{balance > 0 && balance < minRedeemPoints
								? `Minimum ${formatPoints(minRedeemPoints)} points to redeem`
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
