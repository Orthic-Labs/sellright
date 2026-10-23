import { describe, expect, it } from 'vitest';
import { displayOrderCode } from './order-code';

describe('order codes in the storefront (#309)', () => {
	it('displays one leading # whatever the store format', () => {
		expect(displayOrderCode('1001')).toBe('#1001');
		expect(displayOrderCode('DD30306')).toBe('#DD30306');
		expect(displayOrderCode('#1001')).toBe('#1001');
	});
});
