import { describe, expect, it } from 'vitest';
import { formatMinorUnitsAsDecimalString, minorUnitDigits } from './currency';

describe('minorUnitDigits', () => {
	it('defaults to 2 decimal places for the common case', () => {
		expect(minorUnitDigits('USD')).toBe(2);
		expect(minorUnitDigits('EUR')).toBe(2);
		expect(minorUnitDigits(undefined)).toBe(2);
	});

	it('returns 0 for zero-decimal currencies', () => {
		expect(minorUnitDigits('JPY')).toBe(0);
		expect(minorUnitDigits('krw')).toBe(0); // case-insensitive
	});

	it('returns 3 for three-decimal currencies', () => {
		expect(minorUnitDigits('BHD')).toBe(3);
		expect(minorUnitDigits('KWD')).toBe(3);
	});
});

describe('formatMinorUnitsAsDecimalString', () => {
	it('formats USD cents as a 2-decimal string', () => {
		expect(formatMinorUnitsAsDecimalString(12345, 'USD')).toBe('123.45');
	});

	it('formats JPY (0-decimal minor unit) without dividing by 100', () => {
		// A hardcoded /100 would wrongly turn ¥1000 into "10.00".
		expect(formatMinorUnitsAsDecimalString(1000, 'JPY')).toBe('1000');
	});

	it('formats BHD (3-decimal minor unit) correctly', () => {
		expect(formatMinorUnitsAsDecimalString(12345, 'BHD')).toBe('12.345');
	});
});
