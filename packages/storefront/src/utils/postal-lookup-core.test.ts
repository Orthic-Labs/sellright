import { describe, expect, it, vi } from 'vitest';
import { lookupPostal, postalLookupApplies } from './postal-lookup-core';

const zipDb: Record<string, string[]> = { '78701': ['Austin', 'TX'], '10001': ['New York', 'NY'] };
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('lookupPostal', () => {
	it('US: bundled table, no network', async () => {
		const fetch = vi.fn();
		expect(await lookupPostal('US', '78701', { zipDb, fetch })).toEqual({ city: 'Austin', province: 'TX' });
		expect(await lookupPostal('us', '10001-1234', { zipDb, fetch })).toEqual({ city: 'New York', province: 'NY' });
		expect(fetch).not.toHaveBeenCalled();
	});

	it('GB: full postcode via postcodes.io; London region -> "London", county left blank', async () => {
		const fetch = reply(200, { status: 200, result: { postcode: 'SW1A 1AA', admin_district: 'Westminster', region: 'London', country: 'England' } });
		expect(await lookupPostal('GB', 'SW1A 1AA', { zipDb, fetch })).toEqual({ city: 'London', province: '' });
		expect(fetch).toHaveBeenCalledWith('https://api.postcodes.io/postcodes/SW1A%201AA', expect.anything());
	});

	it('GB outside London: the local authority', async () => {
		const fetch = reply(200, { result: { admin_district: 'Manchester', region: 'North West' } });
		expect(await lookupPostal('GB', 'M1 1AE', { zipDb, fetch })).toEqual({ city: 'Manchester', province: '' });
	});

	it('IN: India Post district + full state name', async () => {
		const fetch = reply(200, [{ Status: 'Success', PostOffice: [{ Name: 'Baroda House', District: 'Central Delhi', State: 'Delhi' }] }]);
		expect(await lookupPostal('IN', '110001', { zipDb, fetch })).toEqual({ city: 'Central Delhi', province: 'Delhi' });
		expect(fetch).toHaveBeenCalledWith('https://api.postalpincode.in/pincode/110001', expect.anything());
	});

	it('IN: "Error" status (unknown PIN) -> null', async () => {
		expect(await lookupPostal('IN', '999999', { zipDb, fetch: reply(200, [{ Status: 'Error', PostOffice: null }]) })).toBeNull();
	});

	it('other countries: zippopotam.us, numeric state abbreviation falls back to the name', async () => {
		const fetch = reply(200, { places: [{ 'place name': 'Setúbal', state: 'Setúbal', 'state abbreviation': '15' }] });
		expect(await lookupPostal('PT', '2900-001', { zipDb, fetch })).toEqual({ city: 'Setúbal', province: 'Setúbal' });
	});

	it('failures are silent: 404, network error, timeout, bad JSON shape -> null', async () => {
		expect(await lookupPostal('GB', 'ZZ1 1ZZ', { zipDb, fetch: reply(404, { status: 404, error: 'Postcode not found' }) })).toBeNull();
		expect(await lookupPostal('GB', 'SW1A 1AA', { zipDb, fetch: vi.fn(async () => { throw new TypeError('fetch failed'); }) })).toBeNull();
		const hang = vi.fn((_: string, init?: RequestInit) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))));
		expect(await lookupPostal('IN', '110001', { zipDb, fetch: hang as unknown as typeof fetch, timeoutMs: 20 })).toBeNull();
		expect(await lookupPostal('IN', '110001', { zipDb, fetch: reply(200, { unexpected: true }) })).toBeNull();
		expect(await lookupPostal('US', '00000', { zipDb })).toBeNull();
	});

	it('never sends a code from another country (78701 after switching US -> GB/IN)', async () => {
		const fetch = vi.fn();
		expect(await lookupPostal('GB', '78701', { zipDb, fetch })).toBeNull();
		expect(await lookupPostal('IN', '78701', { zipDb, fetch })).toBeNull();
		expect(await lookupPostal('US', 'SW1A 1AA', { zipDb, fetch })).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});

	it('strips markup and control characters from upstream text', async () => {
		const fetch = reply(200, { result: { admin_district: '<b>Leeds</b>\u0007', region: 'Yorkshire' } });
		expect(await lookupPostal('GB', 'LS1 1UR', { zipDb, fetch })).toEqual({ city: 'bLeeds/b', province: '' });
	});
});

describe('postalLookupApplies', () => {
	it('valid codes for supported countries only', () => {
		expect(postalLookupApplies('US', '78701')).toBe(true);
		expect(postalLookupApplies('GB', 'SW1A 1AA')).toBe(true);
		expect(postalLookupApplies('IN', '110001')).toBe(true);
		expect(postalLookupApplies('GB', '78701')).toBe(false);
		expect(postalLookupApplies('IN', '78701')).toBe(false);
		expect(postalLookupApplies('HK', '999077')).toBe(false); // no lookup source for HK
		expect(postalLookupApplies('', '78701')).toBe(false);
		expect(postalLookupApplies('USA', '78701')).toBe(false);
		expect(postalLookupApplies('US', '12')).toBe(false);
	});
});
