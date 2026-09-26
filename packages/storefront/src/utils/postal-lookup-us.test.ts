import { describe, expect, it } from 'vitest';
import { matchUsZip } from './postal-lookup-us';

const fixture: Record<string, string[]> = {
	'10001': ['New York', 'NY'],
	'90210': ['Beverly Hills', 'CA'],
};

describe('matchUsZip', () => {
	it('resolves a known 5-digit ZIP to city + state', () => {
		expect(matchUsZip(fixture, '10001')).toEqual({ city: 'New York', province: 'NY' });
	});

	it('resolves a ZIP+4 by truncating to the 5-digit prefix', () => {
		expect(matchUsZip(fixture, '90210-1234')).toEqual({ city: 'Beverly Hills', province: 'CA' });
	});

	it('strips non-digit characters before matching', () => {
		expect(matchUsZip(fixture, ' 10001 ')).toEqual({ city: 'New York', province: 'NY' });
	});

	it('fails closed on an unknown ZIP', () => {
		expect(matchUsZip(fixture, '00000')).toBeNull();
	});

	it('fails closed on the wrong digit count (not 5 or 9)', () => {
		// A 6-digit code (e.g. an Indian PIN) must NOT be silently truncated to a
		// 5-digit prefix that happens to collide with a real US ZIP.
		expect(matchUsZip(fixture, '100011')).toBeNull();
		expect(matchUsZip(fixture, '1000')).toBeNull();
	});

	it('fails closed on empty input', () => {
		expect(matchUsZip(fixture, '')).toBeNull();
	});
});
