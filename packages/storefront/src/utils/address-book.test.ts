import { describe, expect, it } from 'vitest';
import { toShippingAddress } from './address-book';

describe('toShippingAddress', () => {
	it('maps the API address onto the shared form/checkout field names, with empty strings for absent optionals', () => {
		expect(
			toShippingAddress({
				id: 'a1', fullName: 'Ada Lovelace', line1: '1 Main St', line2: null, city: 'Reno', province: 'NV', postalCode: '89501',
				country: 'US', phone: null, isDefaultShipping: true, isDefaultBilling: false,
			}),
		).toEqual({
			id: 'a1', fullName: 'Ada Lovelace', streetLine1: '1 Main St', streetLine2: '', company: '', city: 'Reno', province: 'NV', postalCode: '89501',
			countryCode: 'US', phoneNumber: '', defaultShippingAddress: true, defaultBillingAddress: false,
		});
	});
	it('tolerates a null name / province / postal code', () => {
		const a = toShippingAddress({ id: 'a2', fullName: null, line1: 'x', line2: 'y', city: 'c', province: null, postalCode: null, country: 'GB', phone: '123', isDefaultShipping: false, isDefaultBilling: false });
		expect(a).toMatchObject({ fullName: '', province: '', postalCode: '', streetLine2: 'y', phoneNumber: '123' });
	});
});
