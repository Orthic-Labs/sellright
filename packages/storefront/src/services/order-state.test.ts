import { describe, expect, it } from 'vitest';
import { classifyOrderState } from './order-state';

describe('classifyOrderState', () => {
	it('PendingPayment is payable', () => {
		expect(classifyOrderState('PendingPayment')).toBe('payable');
	});

	it('every paid-or-later state is settled', () => {
		for (const state of ['Paid', 'PartiallyRefunded', 'Refunded', 'PartiallyShipped', 'Shipped', 'Delivered']) {
			expect(classifyOrderState(state)).toBe('settled');
		}
	});

	it('Cancelled is cancelled, never payable', () => {
		expect(classifyOrderState('Cancelled')).toBe('cancelled');
	});

	it('Declined, AddingItems, unseen and missing states are unknown — a declined attempt proves nothing', () => {
		for (const state of ['Declined', 'AddingItems', 'SomethingNew', '', undefined, null]) {
			expect(classifyOrderState(state)).toBe('unknown');
		}
	});
});
