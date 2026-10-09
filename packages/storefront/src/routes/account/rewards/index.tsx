import { $, component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { getLoyaltyAccount, saveBirthday } from '~/providers/shop/rewards/rewards';
import { SellRightError } from '~/sellright/client';
import type { LoyaltyAccount } from '~/sellright/types/rewards';
import { formatPrice } from '~/utils';
import { MONTHS, daysInMonth, describeActivity, pointsLabel, waysToEarn } from '~/utils/rewards';
import { createSEOHead } from '~/utils/seo';

const CARD = 'bg-white rounded-lg shadow-soft border border-gray-100/50 p-6';
const DATE_FMT: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };

/**
 * Account → Rewards: points balance and what it is worth, how to earn more,
 * and the activity ledger. Every figure (rates, value, expiry) is read from
 * the API's /v1/shop/account/loyalty — the page hard-codes none of it.
 */
export default component$(() => {
	const data = useSignal<LoyaltyAccount | null>(null);
	const status = useSignal<'loading' | 'ready' | 'off' | 'error'>('loading');
	const month = useSignal(0);
	const day = useSignal(0);
	const birthdayMsg = useSignal('');
	const saving = useSignal(false);

	useVisibleTask$(async () => {
		try {
			const res = await getLoyaltyAccount();
			data.value = res;
			status.value = res.program.enabled ? 'ready' : 'off';
		} catch {
			status.value = 'error';
		}
	});

	const saveBirthday$ = $(async () => {
		birthdayMsg.value = '';
		if (!month.value || !day.value) {
			birthdayMsg.value = 'Choose a month and a day.';
			return;
		}
		saving.value = true;
		try {
			const b = await saveBirthday(month.value, day.value);
			if (data.value) data.value = { ...data.value, birthday: b };
		} catch (e) {
			const s = e instanceof SellRightError ? e.status : undefined;
			birthdayMsg.value =
				s === 409 ? 'Your birthday is already saved.'
				: s === 400 ? 'That date does not exist.'
				: 'Could not save your birthday. Please try again.';
		} finally {
			saving.value = false;
		}
	});

	const d = data.value;
	return (
		<div class="space-y-6" data-testid="account-rewards">
			<div class={CARD}>
				<h1 class="text-lg font-heading font-medium text-gray-900 mb-1">Rewards</h1>
				{status.value === 'loading' && <p class="text-sm text-gray-600">Loading your points…</p>}
				{status.value === 'error' && (
					<p class="text-sm text-gray-700">We could not load your points. If you just created your account, verify your email first, then reload.</p>
				)}
				{status.value === 'off' && <p class="text-sm text-gray-700">The rewards program is not active right now. Any points you have are kept.</p>}
				{status.value === 'ready' && d && (
					<>
						<div class="flex flex-wrap items-end gap-x-10 gap-y-3 mt-3">
							<div>
								<div class="text-4xl font-heading font-light text-[var(--color-accent)] tabular-nums" data-testid="rewards-available">{d.available.toLocaleString('en-US')}</div>
								<div class="text-sm text-gray-600">{d.available === 1 ? 'point' : 'points'} available</div>
							</div>
							<div class="text-sm text-gray-700" data-testid="rewards-value">
								Worth <strong>{formatPrice(d.availableValue, d.currency)}</strong> off your next order.
								{d.program.minRedeemPoints > 0 && <> Minimum {pointsLabel(d.program.minRedeemPoints)} per redemption.</>}
							</div>
						</div>
						<p class="text-sm text-gray-600 mt-3">
							{d.program.expiryDays ? `Points expire ${d.program.expiryDays} days after they are earned.` : 'Your points never expire.'}
							{' '}Use them at checkout.
						</p>
					</>
				)}
			</div>

			{status.value === 'ready' && d && (
				<div class={CARD}>
					<h2 class="text-base font-heading font-medium text-gray-900 mb-3">Ways to earn</h2>
					<ul class="space-y-2 text-sm text-gray-700">
						{waysToEarn(d.program).map((w) => (
							<li key={w.label}><strong class="text-gray-900">{w.label}:</strong> {w.detail}</li>
						))}
					</ul>
					{d.program.birthdayBonusPoints > 0 && !d.birthday && (
						<form class="mt-4 flex flex-wrap items-end gap-3" preventdefault:submit onSubmit$={saveBirthday$}>
							<label class="text-sm text-gray-700">
								<span class="block mb-1">Birthday month</span>
								<select
									class="border border-gray-300 rounded-sm py-2 px-2 text-sm bg-white"
									onChange$={(_, el) => {
										month.value = Number(el.value);
										if (day.value > daysInMonth(month.value)) day.value = 0;
									}}
								>
									<option value="0">Month</option>
									{MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
								</select>
							</label>
							<label class="text-sm text-gray-700">
								<span class="block mb-1">Day</span>
								<select class="border border-gray-300 rounded-sm py-2 px-2 text-sm bg-white" onChange$={(_, el) => { day.value = Number(el.value); }}>
									<option value="0">Day</option>
									{Array.from({ length: month.value ? daysInMonth(month.value) : 31 }, (_, i) => (
										<option key={`d${i}`} value={String(i + 1)}>{String(i + 1)}</option>
									))}
								</select>
							</label>
							<button
								type="submit"
								class="px-4 py-2 text-sm font-medium text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] min-h-[44px] disabled:opacity-60"
								disabled={saving.value}
							>
								{saving.value ? 'Saving…' : 'Save birthday'}
							</button>
							<p class="w-full text-sm text-gray-600">We only store the month and day, and it can't be changed later.</p>
							{birthdayMsg.value && <p class="w-full text-sm text-red-700" role="alert">{birthdayMsg.value}</p>}
						</form>
					)}
					{d.birthday && d.program.birthdayBonusPoints > 0 && (
						<p class="mt-4 text-sm text-gray-700">Birthday saved: {MONTHS[d.birthday.month - 1]} {d.birthday.day}.</p>
					)}
				</div>
			)}

			{status.value === 'ready' && d && (
				<div class={CARD}>
					<h2 class="text-base font-heading font-medium text-gray-900 mb-3">Activity</h2>
					{d.activity.length === 0 ? (
						<p class="text-sm text-gray-600">No points activity yet.</p>
					) : (
						<ul class="divide-y divide-gray-100" data-testid="rewards-activity">
							{d.activity.map((a, i) => (
								<li key={`${a.createdAt}-${i}`} class="py-3 flex items-baseline justify-between gap-4 text-sm">
									<div>
										<div class="text-gray-900">{describeActivity(a)}</div>
										<div class="text-gray-600">
											{new Date(a.createdAt).toLocaleDateString('en-US', DATE_FMT)}
											{a.expiresAt ? ` · expires ${new Date(a.expiresAt).toLocaleDateString('en-US', DATE_FMT)}` : ''}
										</div>
									</div>
									<div class={`tabular-nums font-medium ${a.points < 0 ? 'text-gray-600' : 'text-[var(--color-accent)]'}`}>
										{a.points > 0 ? '+' : ''}{a.points.toLocaleString('en-US')}
									</div>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
});

export const head = () =>
	createSEOHead({ title: 'Rewards', description: 'Your points balance and activity.', noindex: true });
