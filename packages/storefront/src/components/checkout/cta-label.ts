// The checkout's primary button reads PLACE ORDER in every case (Adrian, 2026-10-26: "one PLACE ORDER"): with an amount
// due it shows until the details are valid (then the payment panel's own PLACE ORDER takes over, #372) and a press names
// what is missing; a fully covered order (gift card, store credit, a 100% discount) completes on this press.
export function checkoutCtaLabel(_formattedTotal: string | null | undefined): string {
	return 'PLACE ORDER';
}
