import { describe, expect, it } from 'vitest';
import { postalLookupPatch } from './address-form-utils';

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
