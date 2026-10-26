import { component$ } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';
import { displayOrderCode } from '~/utils/order-code';

/**
 * The "Payment verification error" screen (the previous store's): shown on the confirmation route when a hosted-gateway
 * return (Sezzle) could not be verified, or the order is still unpaid after polling. It never says the order is confirmed.
 * Retry reloads the page, which verifies the return again (the `paymentAttempt` and `rt` params stay in the URL).
 */
export const PaymentVerificationError = component$<{ code: string; message: string }>(({ code, message }) => (
	<div class="max-w-2xl mx-auto pt-20 pb-24 px-6 text-center" data-testid="payment-verification-error">
		<svg class="w-10 h-10 mx-auto text-[var(--color-accent)] mb-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 18.5c-.77.833.192 2.5 1.732 2.5z" />
		</svg>
		<h1 class="font-display text-4xl text-[var(--color-ink)] mb-3" style="line-height: 1.1">Payment verification error</h1>
		<p class="text-[#5b5a56] text-sm mb-4" role="alert">{message}</p>
		<p class="text-xs text-[#5b5a56] mb-8">
			If payment has been deducted, please contact support with order code <span class="font-medium text-[var(--color-ink)]">{displayOrderCode(code)}</span>
		</p>
		<div class="flex flex-wrap gap-6 justify-center text-xs tracking-[0.14em] uppercase">
			<button
				type="button"
				onClick$={() => { window.location.reload(); }}
				class="text-[var(--color-ink)] border-b border-[var(--color-ink)] pb-0.5 hover:opacity-70 transition-opacity"
			>
				Retry verification
			</button>
			<Link href="/contact" class="text-[var(--color-ink)] border-b border-[var(--color-ink)] pb-0.5 hover:opacity-70 transition-opacity">
				Contact support
			</Link>
			<Link href="/checkout" class="text-[var(--color-ink)] border-b border-[var(--color-ink)] pb-0.5 hover:opacity-70 transition-opacity">
				Try again
			</Link>
		</div>
	</div>
));
