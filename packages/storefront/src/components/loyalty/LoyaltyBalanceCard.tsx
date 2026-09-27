import { component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { formatPrice } from '~/utils';
import { srAccountLoyalty, type SrAccountLoyalty } from '~/utils/sellright';
import { formatPoints } from './loyalty-program';

const KIND: Record<string, string> = {
	earn: 'Earned', redeem: 'Redeemed', reverse: 'Adjusted (refund/cancel)', adjust: 'Adjusted', expire: 'Expired', import: 'Transferred',
};

/** Account page: points balance, what it's worth, and recent activity. */
export const LoyaltyBalanceCard = component$(() => {
	const data = useSignal<SrAccountLoyalty | null>(null);
	useVisibleTask$(async () => {
		try {
			const res = await srAccountLoyalty();
			data.value = res.program.enabled || res.balance > 0 ? res : null;
		} catch {
			data.value = null;
		}
	});
	const d = data.value;
	if (!d) return null;
	return (
		<div class="bg-white rounded-lg shadow-soft border border-gray-100/50 p-6 mb-6" data-testid="loyalty-balance">
			<div class="flex items-baseline justify-between gap-4">
				<h3 class="text-lg font-heading font-medium text-gray-900">Points</h3>
				<div class="text-right">
					<div class="text-2xl font-heading text-[var(--color-accent)] tabular-nums">{formatPoints(d.available)}</div>
					<div class="text-xs text-gray-500">worth {formatPrice(d.availableValue, d.currency)} off</div>
				</div>
			</div>
			{d.program.enabled && (
				<p class="text-sm text-gray-600 mt-2">
					Earn {formatPoints(d.program.earnRatePerDollar)} point{d.program.earnRatePerDollar === 1 ? '' : 's'} per $1 spent.
					{' '}{formatPoints(d.program.pointsPerDollarOff)} points = $1 off at checkout.
					{d.program.expiryDays ? ` Points expire ${d.program.expiryDays} days after they are earned.` : ''}
				</p>
			)}
			{d.activity.length > 0 && (
				<ul class="mt-4 divide-y divide-gray-100 text-sm">
					{d.activity.slice(0, 5).map((row, i) => (
						<li key={i} class="flex justify-between py-2">
							<span class="text-gray-600">
								{KIND[row.kind] ?? row.kind}
								{row.orderCode ? <span class="text-gray-400"> · {row.orderCode}</span> : null}
							</span>
							<span class={`tabular-nums ${row.points < 0 ? 'text-gray-500' : 'text-gray-900'}`}>
								{row.points > 0 ? '+' : ''}{formatPoints(row.points)}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
});
