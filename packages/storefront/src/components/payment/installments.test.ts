import { describe, expect, it } from 'vitest';
import { installmentSchedule } from './installments';

describe('installmentSchedule', () => {
	it('splits evenly', () => {
		expect(installmentSchedule(10000)).toEqual([2500, 2500, 2500, 2500]);
	});

	it.each([1, 2, 3, 5, 9999, 10001, 10002, 10003])('always adds back up to %i cents', (total) => {
		const parts = installmentSchedule(total);
		expect(parts).toHaveLength(4);
		expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
	});

	it('puts the remainder on the earliest payments, as the previous store did', () => {
		expect(installmentSchedule(10003)).toEqual([2501, 2501, 2501, 2500]);
		expect(installmentSchedule(10001)).toEqual([2501, 2500, 2500, 2500]);
	});

	it('is all zeros for nothing due or a bad total', () => {
		expect(installmentSchedule(0)).toEqual([0, 0, 0, 0]);
		expect(installmentSchedule(Number.NaN)).toEqual([0, 0, 0, 0]);
		expect(installmentSchedule(-5)).toEqual([0, 0, 0, 0]);
	});
});
