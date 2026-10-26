// The checkout's primary button. When something is left to pay it shows only until the shopper's details are valid (then
// the payment panel's own PAY takes over, #372), so it reads PAY and a press names what is missing; a fully covered order
// (gift card, store credit, a 100% discount) completes on this press.
export function checkoutCtaLabel(formattedTotal: string | null | undefined): string {
	const dueIsZero = !!formattedTotal && /\d/.test(formattedTotal) && !/[1-9]/.test(formattedTotal);
	return dueIsZero ? 'PLACE ORDER' : 'PAY';
}
