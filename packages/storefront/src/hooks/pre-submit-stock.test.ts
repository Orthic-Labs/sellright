import { afterEach, describe, expect, it, vi } from 'vitest';
import { CartService } from '~/services/CartService';
import { PreSubmitStockError, refreshStockBeforeSubmit } from './pre-submit-stock';

vi.mock('~/services/CartService', () => ({ CartService: { refresh: vi.fn(), validateStock: vi.fn(), getCart: vi.fn() } }));
afterEach(() => vi.resetAllMocks());
const cartWithStatus = (status: string) => vi.mocked(CartService.getCart).mockReturnValue({ status } as never);

describe('pre-submit live stock read', () => {
	it('awaits a live cart read, then validates, on every call (no memo)', async () => {
		const order: string[] = [];
		cartWithStatus('active');
		vi.mocked(CartService.refresh).mockImplementation(async () => { order.push('refresh'); return { cart: {} as never, dropped: [] }; });
		vi.mocked(CartService.validateStock).mockImplementation(() => { order.push('validate'); return { valid: true, errors: [] }; });
		await refreshStockBeforeSubmit();
		await refreshStockBeforeSubmit();
		expect(order).toEqual(['refresh', 'validate', 'refresh', 'validate']);
	});

	it('refuses with PreSubmitStockError when a line is unavailable after the live read', async () => {
		cartWithStatus('active');
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

	it('refuses a NEW order (active cart) whose line is unavailable, and never treats a missing status as converted', async () => {
		vi.mocked(CartService.refresh).mockResolvedValue({ cart: {} as never, dropped: [] });
		vi.mocked(CartService.validateStock).mockReturnValue({ valid: false, errors: ['Knife: Out of stock. Please remove from cart.'] });
		for (const status of ['active', 'abandoned', 'merged', '']) {
			cartWithStatus(status);
			await expect(refreshStockBeforeSubmit()).rejects.toBeInstanceOf(PreSubmitStockError);
		}
		vi.mocked(CartService.getCart).mockReturnValue({} as never);
		await expect(refreshStockBeforeSubmit()).rejects.toBeInstanceOf(PreSubmitStockError);
	});

	it('lets a converted cart through to srPlaceOrder even when its last unit is allocated to its own order (live read still awaited)', async () => {
		const order: string[] = [];
		vi.mocked(CartService.refresh).mockImplementation(async () => { order.push('refresh'); return { cart: {} as never, dropped: [] }; });
		vi.mocked(CartService.getCart).mockImplementation(() => { order.push('status'); return { status: 'converted' } as never; });
		vi.mocked(CartService.validateStock).mockReturnValue({ valid: false, errors: ['Knife: Out of stock. Please remove from cart.'] });
		await expect(refreshStockBeforeSubmit()).resolves.toBeUndefined();
		expect(order).toEqual(['refresh', 'status']); // live read first, status read from its result, no memo
	});

	it('still refuses when the live read fails, even if the previous mirror was converted', async () => {
		cartWithStatus('converted');
		vi.mocked(CartService.refresh).mockRejectedValue(new Error('network down'));
		await expect(refreshStockBeforeSubmit()).rejects.toThrow('network down');
		expect(CartService.getCart).not.toHaveBeenCalled();
	});
});
