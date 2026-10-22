// Which destination country checkout starts on. Pure so the precedence is testable; the route supplies the inputs.
//
// The cart drawer and every cart quote price shipping for one country (`CountryPreferenceService.getCountry()`, which
// is also what `CartService` sends as `shipCountry`). Checkout starts on that same country instead of an empty
// "Select a country", so the shipping the shopper saw in the cart is the shipping checkout quotes. A saved or entered
// address always wins: once the address has a street line its country is the shopper's, never replaced here. The
// shopper can still change the country in the form (the select writes the preference back).

export interface CheckoutCountryInputs {
	/** The country already on the checkout address (saved address, shopper's choice, or the SSR cookie seed). */
	current?: string | null;
	/** True when the address already carries a street line (a saved address or one the shopper typed). */
	addressEntered?: boolean;
	/** The cart's ship-to country: the value the cart drawer displayed and the cart quote used. */
	cartShipCountry?: string | null;
	/** Older fallbacks, read only when nothing above is usable. */
	cookie?: string | null;
	session?: string | null;
}

const ISO2 = /^[A-Z]{2}$/;

const usable = (code: string | null | undefined, available: readonly { code: string }[]): string => {
	const upper = (code ?? '').trim().toUpperCase();
	if (!ISO2.test(upper)) return '';
	// The store's ship-to list, when loaded, is authoritative: never preselect a country checkout cannot ship to.
	if (available.length > 0 && !available.some((c) => c.code === upper)) return '';
	return upper;
};

export function resolveCheckoutCountry(inputs: CheckoutCountryInputs, available: readonly { code: string }[]): string {
	const current = (inputs.current ?? '').trim();
	if (inputs.addressEntered && current) return current;
	for (const candidate of [inputs.cartShipCountry, inputs.current, inputs.cookie, inputs.session]) {
		const code = usable(candidate, available);
		if (code) return code;
	}
	return current;
}

/** The layout's idle restore of the stored country must not replace the country of a saved or entered address. */
export const canRestorePreferredCountry = (address: { streetLine1?: string | null }): boolean => !(address.streetLine1 ?? '').trim();
