import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CartService } from '~/services/CartService';
import { PreSubmitStockError, refreshStockBeforeSubmit, validateCheckoutStock } from './pre-submit-stock';

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

describe('checkout gate: recovery of the cart\'s own converted order', () => {
	const unavailable = { valid: false, errors: ['Knife: Out of stock. Please remove from cart.'] };

	it('a converted mirror is valid (the gate that feeds Place Order), any other or missing status stays fail-closed', () => {
		vi.mocked(CartService.validateStock).mockReturnValue(unavailable);
		cartWithStatus('converted');
		expect(validateCheckoutStock()).toEqual({ valid: true, errors: [] });
		expect(CartService.validateStock).not.toHaveBeenCalled();
		for (const status of ['active', 'abandoned', 'merged', '']) {
			cartWithStatus(status);
			expect(validateCheckoutStock()).toEqual(unavailable);
		}
		vi.mocked(CartService.getCart).mockReturnValue({} as never);
		expect(validateCheckoutStock()).toEqual(unavailable);
	});

	it('after a cart refresh adopts the converted status the gate opens, and the awaited pre-submit read still runs', async () => {
		let status = 'active';
		vi.mocked(CartService.getCart).mockImplementation(() => ({ status }) as never);
		vi.mocked(CartService.validateStock).mockReturnValue(unavailable);
		expect(validateCheckoutStock().valid).toBe(false); // before the live read: a new order, fail closed
		vi.mocked(CartService.refresh).mockImplementation(async () => { status = 'converted'; return { cart: {} as never, dropped: [] }; });
		await CartService.refresh(); // cart open / checkout re-entry adopts the live response
		expect(validateCheckoutStock().valid).toBe(true);
		await expect(refreshStockBeforeSubmit()).resolves.toBeUndefined();
		expect(CartService.refresh).toHaveBeenCalledTimes(2); // every read is live, none skipped
	});

	it('checkout re-entry: a fresh document starts from a mirror with no status and fails closed until the live read says converted', async () => {
		vi.mocked(CartService.getCart).mockReturnValue({} as never);
		vi.mocked(CartService.validateStock).mockReturnValue(unavailable);
		expect(validateCheckoutStock().valid).toBe(false);
		cartWithStatus('converted');
		expect(validateCheckoutStock().valid).toBe(true);
	});

	it('the checkout route validates through the shared gate (never CartService.validateStock directly) and tracks the cart status', () => {
		const src = readFileSync(`${process.cwd()}/src/routes/checkout/index.tsx`, 'utf8');
		expect(src).toMatch(/validateCheckoutStock\(\)/);
		expect(src).not.toMatch(/CartService\.validateStock/);
		expect(src).toMatch(/track\(\(\) => localCart\.cart\.status\)/);
	});
});
