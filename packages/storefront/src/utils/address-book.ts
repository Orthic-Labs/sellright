import type { Address } from '~/sellright/types/account';
import type { ShippingAddress } from '~/types';

/** The API's saved address -> the long-standing ShippingAddress field names the address form and checkout share. */
export function toShippingAddress(a: Address): ShippingAddress {
	return {
		id: a.id,
		fullName: a.fullName ?? '',
		streetLine1: a.line1,
		streetLine2: a.line2 ?? '',
		company: '',
		city: a.city,
		province: a.province ?? '',
		postalCode: a.postalCode ?? '',
		countryCode: a.country,
		phoneNumber: a.phone ?? '',
		defaultShippingAddress: a.isDefaultShipping,
		defaultBillingAddress: a.isDefaultBilling,
	};
}
