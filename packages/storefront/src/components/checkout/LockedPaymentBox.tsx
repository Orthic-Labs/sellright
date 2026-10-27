import { component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { getShopConfig } from '~/providers/shop/checkout/checkout';
import { CardBrandIcon } from '~/components/payment/CardBrandIcons';
import { INSTALLMENT_PROVIDER, providerLabel } from '~/platform/payments/labels';
import type { PaymentMethod } from '~/hooks/useCheckout';
import { LOCKED_PAYMENT_HEADING, LOCKED_PAYMENT_LINE, PAYMENT_UNLOCKED_ANNOUNCEMENT, availableMethods, lockedPaymentMarks } from './locked-payment';

const PILL = 'inline-flex items-center h-[22px] px-2 rounded border border-[var(--color-card-border)] bg-white text-[11px] font-medium text-[var(--color-ink)]';

/** #404: where the payment controls will appear, before the email and shipping address are valid (replaces the faint
 *  "Complete your shipping address" line, which read as an empty page on phones). Not focusable or clickable; role=status.
 *  The marks come from the store's configured payment providers. */
export const LockedPaymentBox = component$<{ methods: readonly PaymentMethod[] }>(({ methods }) => {
	// Checkout reads the shop config only when payment mounts; the box reads it on its own (read-only, nothing applied to
	// checkout state) so the marks show while the payment is still locked.
	const configured = useSignal<readonly PaymentMethod[] | null>(null);
	useVisibleTask$(async () => {
		if (methods.length) return;
		try { configured.value = availableMethods(await getShopConfig()); } catch { configured.value = []; }
	}, { strategy: 'document-ready' });
	const marks = lockedPaymentMarks(methods.length ? methods : configured.value ?? []);
	return (
		<div role="status" data-testid="payment-locked" class="rounded-md border border-[var(--color-card-border)] bg-[var(--color-parchment)] px-5 py-4 select-none">
			<div class="flex items-center gap-2 mb-1.5">
				<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="text-[var(--color-ink)]">
					<rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
				</svg>
				<h2 class="m-0 font-heading text-[15px] font-semibold tracking-wide text-[var(--color-ink)]">{LOCKED_PAYMENT_HEADING}</h2>
			</div>
			<p class="m-0 text-[13px] leading-relaxed text-[var(--color-ink-soft)]">{LOCKED_PAYMENT_LINE}</p>
			{marks.length > 0 && (
				<ul class="flex flex-wrap items-center gap-1.5 mt-3 p-0 list-none" aria-label="Accepted payment methods">
					{marks.map((mark) => (
						<li key={mark} class="flex items-center gap-1.5">
							{mark === 'cards' && (['visa', 'mastercard', 'amex'] as const).map((b) => <CardBrandIcon key={b} brand={b} />)}
							{mark === 'cards' && <span class="sr-only">Cards</span>}
							{mark === 'apple-pay' && <span class={PILL}>Apple Pay</span>}
							{mark === 'link' && <span class={PILL}>Link</span>}
							{mark === INSTALLMENT_PROVIDER && (
								<img src={`/${INSTALLMENT_PROVIDER}-color.svg`} alt={providerLabel(INSTALLMENT_PROVIDER)} width="64" height="18" class="h-[18px] w-auto" />
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
});

/** The box while the details are incomplete, and an always-present screen-reader status that announces the unlock. */
export const PaymentLock = component$<{ unlocked: boolean; methods: readonly PaymentMethod[] }>(({ unlocked, methods }) => (
	<>
		{!unlocked && <LockedPaymentBox methods={methods} />}
		<p class="sr-only" role="status" data-testid="payment-unlock-status">{unlocked ? PAYMENT_UNLOCKED_ANNOUNCEMENT : ''}</p>
	</>
));
