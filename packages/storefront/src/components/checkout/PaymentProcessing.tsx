import { component$ } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';
import { displayOrderCode } from '~/utils/order-code';

/**
 * The "Payment processing" screen: a hosted-gateway return (Sezzle) the API verified as approved but not yet captured.
 * Never says the order is confirmed, never invites a second payment. The route keeps re-verifying behind it and swaps
 * in the confirmation as soon as the order is Paid; the confirmation email follows either way.
 */
export const PaymentProcessing = component$<{ code: string; email?: string | null; stillChecking: boolean }>(({ code, email, stillChecking }) => (
	<div class="max-w-2xl mx-auto pt-20 pb-24 px-6 text-center" data-testid="payment-processing">
		<svg class={['w-10 h-10 mx-auto text-[var(--color-accent)] mb-5', stillChecking && 'animate-spin']} fill="none" viewBox="0 0 24 24" aria-hidden="true">
			<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5" />
			<path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
		</svg>
		<h1 class="font-display text-4xl text-[var(--color-ink)] mb-3" style="line-height: 1.1">Payment processing</h1>
		<p class="text-[#5b5a56] text-sm mb-4" role="status">
			Your payment was approved and is being finalised. {stillChecking ? 'This page will update on its own.' : 'It can take a few minutes.'}
		</p>
		<p class="text-[#5b5a56] text-sm mb-4">
			Please don't pay again. {email ? <>We'll email <span class="font-medium text-[var(--color-ink)]">{email}</span> as soon as your order is confirmed.</> : "We'll email you as soon as your order is confirmed."}
		</p>
		<p class="text-xs text-[#5b5a56] mb-8">
			Order code <span class="font-medium text-[var(--color-ink)]">{displayOrderCode(code)}</span>
		</p>
		<div class="flex flex-wrap gap-6 justify-center text-xs tracking-[0.14em] uppercase">
			<Link href="/contact" class="text-[var(--color-ink)] border-b border-[var(--color-ink)] pb-0.5 hover:opacity-70 transition-opacity">
				Contact support
			</Link>
		</div>
	</div>
));
