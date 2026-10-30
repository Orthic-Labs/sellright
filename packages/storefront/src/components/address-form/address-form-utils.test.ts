import { describe, expect, it } from 'vitest';
import { countryChangeClearPatch, postalLookupPatch } from './address-form-utils';

const base = {
	current: { city: '', province: '' },
	userEdited: { city: false, province: false },
	focusedField: null as string | null,
	result: { city: 'Reno', province: 'NV' },
};

describe('postalLookupPatch', () => {
	it('fills empty fields', () => {
		expect(postalLookupPatch(base)).toEqual({ city: 'Reno', province: 'NV' });
	});

	it('never writes the field the shopper is in (a write there moves the caret and the next keystroke is appended: NVNV)', () => {
		expect(postalLookupPatch({ ...base, focusedField: 'province' })).toEqual({ city: 'Reno' });
		expect(postalLookupPatch({ ...base, focusedField: 'city' })).toEqual({ province: 'NV' });
	});

	it('never replaces a value the shopper typed, even with a different lookup answer', () => {
		const typed = { ...base, current: { city: 'Sparks', province: 'N' }, userEdited: { city: true, province: true } };
		expect(postalLookupPatch(typed)).toEqual({});
	});

	it('may replace an earlier lookup value or a value loaded from a saved address, but not write an identical one', () => {
		expect(postalLookupPatch({ ...base, current: { city: 'Sparks', province: 'NV' } })).toEqual({ city: 'Reno' });
	});

	it('refills a field the shopper typed into and then emptied', () => {
		expect(postalLookupPatch({ ...base, userEdited: { city: true, province: true } })).toEqual({ city: 'Reno', province: 'NV' });
	});

	it('skips empty or missing result values', () => {
		expect(postalLookupPatch({ ...base, result: { city: '', province: 'NV' } })).toEqual({ province: 'NV' });
		expect(postalLookupPatch({ ...base, result: {} })).toEqual({});
	});
});

describe('countryChangeClearPatch', () => {
	it('blanks city and state the lookup filled (IN 110001 then GB must not keep Central Delhi / Delhi)', () => {
		const current = { city: 'Central Delhi', province: 'Delhi' };
		expect(countryChangeClearPatch({ country: 'GB', current, autofilled: { ...current } })).toEqual({ city: '', province: '' });
	});

	it('keeps a typed city and state that are valid for the new country (typed Austin / TX, then fixed the country to US)', () => {
		expect(countryChangeClearPatch({ country: 'US', current: { city: 'Austin', province: 'TX' }, autofilled: {} })).toEqual({});
	});

	it('keeps values changed after the lookup', () => {
		expect(countryChangeClearPatch({ country: 'GB', current: { city: 'New Delhi', province: 'Delhi' }, autofilled: { city: 'Central Delhi', province: 'Delhi' } })).toEqual({ province: '' });
	});

	it('blanks a typed state that is not a region of the new country, keeps the typed city', () => {
		expect(countryChangeClearPatch({ country: 'CA', current: { city: 'Austin', province: 'TX' }, autofilled: {} })).toEqual({ province: '' });
	});

	it('keeps a typed region where the new country has no region list', () => {
		expect(countryChangeClearPatch({ country: 'GB', current: { city: 'Leeds', province: 'West Yorkshire' }, autofilled: {} })).toEqual({});
	});

	it('does nothing to empty fields', () => {
		expect(countryChangeClearPatch({ country: 'GB', current: { city: '', province: '' }, autofilled: { city: 'Reno' } })).toEqual({});
	});
});
