import { describe, expect, it } from 'vitest';
import { guestRestorePatch } from './guest-restore';

describe('guestRestorePatch', () => {
	it('a country-only record never blanks the customer or the typed address (the post-PLACE-ORDER qinit re-fire)', () => {
		const patch = guestRestorePatch(
			{ firstName: 'Ada', lastName: 'Lovelace', emailAddress: 'ada@example.net' },
			{ streetLine1: '1 Main', city: 'Austin', province: 'TX', postalCode: '78701', countryCode: 'US', phoneNumber: '512' },
			{ countryCode: 'US' },
		);
		expect(patch).toEqual({ customer: {}, shipping: {} });
	});

	it('restores the remembered country when it differs from the current one', () => {
		expect(guestRestorePatch({}, { countryCode: 'US' }, { countryCode: 'CA' }).shipping).toEqual({ countryCode: 'CA' });
	});

	it('fills empty fields from a fuller record but never overwrites typed values', () => {
		const patch = guestRestorePatch(
			{ firstName: '', lastName: 'Typed', emailAddress: '' },
			{ city: '', streetLine1: 'Typed St' },
			{ firstName: 'Ada', lastName: 'Old', emailAddress: 'ada@example.net', city: 'Austin', streetLine1: 'Old St' },
		);
		expect(patch.customer).toEqual({ firstName: 'Ada', emailAddress: 'ada@example.net' });
		expect(patch.shipping).toEqual({ city: 'Austin' });
	});
});
