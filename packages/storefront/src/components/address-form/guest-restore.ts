import type { GuestShippingAddress } from './address-guest-storage';

type CustomerFields = { firstName?: string; lastName?: string; emailAddress?: string };
type ShippingFields = {
	streetLine1?: string;
	streetLine2?: string;
	city?: string;
	province?: string;
	postalCode?: string;
	countryCode?: string;
	phoneNumber?: string;
};

const CUSTOMER_KEYS = ['firstName', 'lastName', 'emailAddress'] as const;
const SHIPPING_KEYS = ['streetLine1', 'streetLine2', 'city', 'province', 'postalCode', 'phoneNumber'] as const;

/**
 * What the remembered guest record may add to the live checkout state.
 *
 * `useOnDocument('qinit')` is NOT a run-once hook on a client-rendered page: the qwikloader dispatches `qinit` to
 * every element that (re)acquires the listener after boot, so this restore can run again mid-checkout — right
 * after PLACE ORDER, when the payment panel re-renders. It must therefore never blank anything the shopper has
 * already typed: a field is only filled when it is currently empty, and a missing field in the record is a no-op
 * (the record only holds the country now). The country is the one remembered choice that wins over the default.
 *
 * Returns only the keys to change; an empty patch means "leave appState alone".
 */
export function guestRestorePatch(
	customer: CustomerFields | undefined,
	shipping: ShippingFields | undefined,
	guest: GuestShippingAddress,
): { customer: Partial<CustomerFields>; shipping: Partial<ShippingFields> } {
	const customerPatch: Partial<CustomerFields> = {};
	for (const key of CUSTOMER_KEYS) {
		if (guest[key] && !customer?.[key]) customerPatch[key] = guest[key];
	}
	const shippingPatch: Partial<ShippingFields> = {};
	for (const key of SHIPPING_KEYS) {
		if (guest[key] && !shipping?.[key]) shippingPatch[key] = guest[key];
	}
	if (guest.countryCode && guest.countryCode !== shipping?.countryCode) shippingPatch.countryCode = guest.countryCode;
	return { customer: customerPatch, shipping: shippingPatch };
}
