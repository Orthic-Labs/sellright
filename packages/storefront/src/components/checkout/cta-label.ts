// The checkout's primary button creates the order. When something is left to pay, the payment form appears next, so the
// button says so; a fully covered order (gift card, store credit, a 100% discount) completes on this press.
export function checkoutCtaLabel(formattedTotal: string | null | undefined): string {
	const dueIsZero = !!formattedTotal && /\d/.test(formattedTotal) && !/[1-9]/.test(formattedTotal);
	return dueIsZero ? 'PLACE ORDER' : 'CONTINUE TO PAYMENT';
}
