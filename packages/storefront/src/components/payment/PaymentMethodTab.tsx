import { component$ } from '@qwik.dev/core';
import { INSTALLMENT_PROVIDER, providerLabel, type PaymentProviderId } from '~/platform/payments/labels';
import { CardBrandStrip } from './CardBrandIcons';

/**
 * What a payment method tab shows (the previous store's payment tab): the card tab names the method with the card brand
 * marks under it, the installment tab says "Pay in 4 · 0% Interest" over the provider's logo. Any other method shows
 * its plain label. The provider is named through the label map, never typed here (brand lint).
 */
export const PaymentMethodTab = component$<{ method: PaymentProviderId; label: string }>(({ method, label }) => {
	if (method === 'nmi') {
		return (
			<>
				<span>Credit / Debit Card</span>
				<CardBrandStrip />
			</>
		);
	}
	if (method === INSTALLMENT_PROVIDER) {
		return (
			<>
				<span>Pay in 4 · 0% Interest</span>
				<img src={`/${INSTALLMENT_PROVIDER}-color.svg`} alt={providerLabel(INSTALLMENT_PROVIDER)} width="86" height="24" class="h-6 w-auto" />
			</>
		);
	}
	return <span>{label}</span>;
});

/** Classes for a method tab button; the selected tab is raised and outlined in the accent colour. */
export const methodTabClass = (selected: boolean): string =>
	`payment-method-option min-h-[84px] min-w-0 px-1 sm:px-3 py-3 flex flex-col items-center justify-center gap-2 rounded border text-[11px] sm:text-xs leading-snug tracking-[0.06em] uppercase cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] ${
		selected
			? 'relative -translate-y-px bg-white border-[var(--color-accent)] text-[var(--color-ink)] font-semibold shadow-md'
			: 'bg-transparent border-transparent text-black/60 hover:text-black/80 hover:bg-white/50'
	}`;
