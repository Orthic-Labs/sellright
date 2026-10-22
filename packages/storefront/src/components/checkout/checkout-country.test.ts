// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { canRestorePreferredCountry, resolveCheckoutCountry } from './checkout-country';

const LIST = [{ code: 'US' }, { code: 'CA' }, { code: 'GB' }];

describe('resolveCheckoutCountry', () => {
	it("starts on the cart's ship country instead of an empty select", () => {
		expect(resolveCheckoutCountry({ current: '', cartShipCountry: 'CA' }, LIST)).toBe('CA');
	});
	it('prefers the cart ship country over the SSR cookie seed when no address is entered', () => {
		expect(resolveCheckoutCountry({ current: 'US', cartShipCountry: 'GB', cookie: 'US' }, LIST)).toBe('GB');
	});
	it('never overrides a saved or entered address', () => {
		expect(resolveCheckoutCountry({ current: 'GB', addressEntered: true, cartShipCountry: 'CA' }, LIST)).toBe('GB');
	});
	it('skips a cart country the store does not ship to and falls back in order', () => {
		expect(resolveCheckoutCountry({ current: '', cartShipCountry: 'FR', cookie: 'ca' }, LIST)).toBe('CA');
		expect(resolveCheckoutCountry({ current: '', cartShipCountry: 'FR', cookie: 'FR', session: 'GB' }, LIST)).toBe('GB');
	});
	it('accepts any valid code while the ship-to list is not loaded', () => {
		expect(resolveCheckoutCountry({ current: '', cartShipCountry: 'FR' }, [])).toBe('FR');
	});
	it('leaves the field empty when nothing usable exists', () => {
		expect(resolveCheckoutCountry({ current: '', cartShipCountry: 'garbage', cookie: null }, LIST)).toBe('');
	});
});

describe('canRestorePreferredCountry', () => {
	it('restores only while no street line is on the address', () => {
		expect(canRestorePreferredCountry({ streetLine1: '' })).toBe(true);
		expect(canRestorePreferredCountry({ streetLine1: '  ' })).toBe(true);
		expect(canRestorePreferredCountry({ streetLine1: '1 Main St' })).toBe(false);
	});
});
