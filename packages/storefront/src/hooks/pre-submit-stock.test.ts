import { afterEach, describe, expect, it, vi } from 'vitest';
import { CartService } from '~/services/CartService';
import { PreSubmitStockError, refreshStockBeforeSubmit } from './pre-submit-stock';

vi.mock('~/services/CartService', () => ({ CartService: { refresh: vi.fn(), validateStock: vi.fn() } }));
afterEach(() => vi.resetAllMocks());

describe('pre-submit live stock read', () => {
	it('awaits a live cart read, then validates, on every call (no memo)', async () => {
		const order: string[] = [];
		vi.mocked(CartService.refresh).mockImplementation(async () => { order.push('refresh'); return { cart: {} as never, dropped: [] }; });
		vi.mocked(CartService.validateStock).mockImplementation(() => { order.push('validate'); return { valid: true, errors: [] }; });
		await refreshStockBeforeSubmit();
		await refreshStockBeforeSubmit();
		expect(order).toEqual(['refresh', 'validate', 'refresh', 'validate']);
	});

	it('refuses with PreSubmitStockError when a line is unavailable after the live read', async () => {
		vi.mocked(CartService.refresh).mockResolvedValue({ cart: {} as never, dropped: [] });
		vi.mocked(CartService.validateStock).mockReturnValue({ valid: false, errors: ['Knife: Out of stock. Please remove from cart.'] });
		await expect(refreshStockBeforeSubmit()).rejects.toBeInstanceOf(PreSubmitStockError);
		await expect(refreshStockBeforeSubmit()).rejects.toThrow('Knife: Out of stock');
	});

	it('propagates a failed live read and never validates against the stale mirror', async () => {
		vi.mocked(CartService.refresh).mockRejectedValue(new Error('network down'));
		await expect(refreshStockBeforeSubmit()).rejects.toThrow('network down');
		expect(CartService.validateStock).not.toHaveBeenCalled();
	});
});
