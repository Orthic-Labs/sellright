import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CartService } from '~/services/CartService';
import { PreSubmitStockError, refreshStockBeforeSubmit, validateCheckoutStock } from './pre-submit-stock';

vi.mock('~/services/CartService', () => ({
	CartService: { refresh: vi.fn(), readFresh: vi.fn(), validateStock: vi.fn(), getCart: vi.fn() },
}));
afterEach(() => vi.resetAllMocks());
const cartWithStatus = (status: string) => vi.mocked(CartService.getCart).mockReturnValue({ status } as never);
const line = (available: boolean | undefined, name = 'Knife') => ({ sku: 'SKU1', name, available });
const fresh = (status: string, lines: unknown[]) => ({ token: 't', revision: 1, status, lines }) as never;

describe('pre-submit live stock read', () => {
	it('awaits its own live cart read on every call (no memo) and passes when every line is available', async () => {
		vi.mocked(CartService.readFresh).mockResolvedValue(fresh('active', [line(true)]));
		await refreshStockBeforeSubmit();
		await refreshStockBeforeSubmit();
		expect(CartService.readFresh).toHaveBeenCalledTimes(2);
	});

	it('refuses with PreSubmitStockError when a line is unavailable in the fresh response', async () => {
		vi.mocked(CartService.readFresh).mockResolvedValue(fresh('active', [line(false)]));
		await expect(refreshStockBeforeSubmit()).rejects.toBeInstanceOf(PreSubmitStockError);
		await expect(refreshStockBeforeSubmit()).rejects.toThrow('Knife: Out of stock');
	});

	it('validates the fresh response, never the mirror: an in-stock mirror cannot rescue an out-of-stock response', async () => {
		cartWithStatus('active');
		vi.mocked(CartService.validateStock).mockReturnValue({ valid: true, errors: [] });
		vi.mocked(CartService.getCart).mockReturnValue({ status: 'active', lines: [line(true)] } as never);
		vi.mocked(CartService.readFresh).mockResolvedValue(fresh('active', [line(false)]));
		await expect(refreshStockBeforeSubmit()).rejects.toBeInstanceOf(PreSubmitStockError);
		expect(CartService.validateStock).not.toHaveBeenCalled();
		expect(CartService.getCart).not.toHaveBeenCalled();
	});

	it('treats a missing availability flag as unavailable (fail closed)', async () => {
		vi.mocked(CartService.readFresh).mockResolvedValue(fresh('active', [line(undefined)]));
		await expect(refreshStockBeforeSubmit()).rejects.toBeInstanceOf(PreSubmitStockError);
	});

	it('propagates a failed live read and never validates against the stale mirror', async () => {
		vi.mocked(CartService.readFresh).mockRejectedValue(new Error('network down'));
		await expect(refreshStockBeforeSubmit()).rejects.toThrow('network down');
		expect(CartService.validateStock).not.toHaveBeenCalled();
		expect(CartService.getCart).not.toHaveBeenCalled();
	});

	it('refuses a NEW order (any non-converted status) whose line is unavailable, and never treats a missing status as converted', async () => {
		for (const status of ['active', 'abandoned', 'merged', '', undefined as unknown as string]) {
			vi.mocked(CartService.readFresh).mockResolvedValue(fresh(status, [line(false)]));
			await expect(refreshStockBeforeSubmit()).rejects.toBeInstanceOf(PreSubmitStockError);
		}
	});

	it('lets a converted cart through to srPlaceOrder even when its last unit is allocated to its own order (live read still awaited)', async () => {
		vi.mocked(CartService.readFresh).mockResolvedValue(fresh('converted', [line(false)]));
		await expect(refreshStockBeforeSubmit()).resolves.toEqual({ token: 't', revision: 1, status: 'converted' });
		expect(CartService.readFresh).toHaveBeenCalledTimes(1);
	});

	it('still refuses when the live read fails, even if the previous mirror was converted', async () => {
		cartWithStatus('converted');
		vi.mocked(CartService.readFresh).mockRejectedValue(new Error('network down'));
		await expect(refreshStockBeforeSubmit()).rejects.toThrow('network down');
		expect(CartService.getCart).not.toHaveBeenCalled();
	});

	it('recovery applies only when THAT response is converted: a converted mirror does not excuse an active fresh response', async () => {
		cartWithStatus('converted');
		vi.mocked(CartService.readFresh).mockResolvedValue(fresh('active', [line(false)]));
		await expect(refreshStockBeforeSubmit()).rejects.toBeInstanceOf(PreSubmitStockError);
	});
});

describe('pre-submit read is the submission snapshot', () => {
	it('returns the token, revision and status of the validated response itself', async () => {
		vi.mocked(CartService.readFresh).mockResolvedValue({ token: 'tok_x', revision: 7, status: 'active', lines: [line(true)] } as never);
		await expect(refreshStockBeforeSubmit()).resolves.toEqual({ token: 'tok_x', revision: 7, status: 'active' });
		expect(CartService.readFresh).toHaveBeenCalledTimes(1);
	});

	it('refuses an empty active cart (and any non-converted status with no lines)', async () => {
		for (const status of ['active', 'abandoned', '']) {
			vi.mocked(CartService.readFresh).mockResolvedValue(fresh(status, []));
			await expect(refreshStockBeforeSubmit()).rejects.toBeInstanceOf(PreSubmitStockError);
			await expect(refreshStockBeforeSubmit()).rejects.toThrow(/empty/i);
		}
	});

	it('a converted cart replays its original order even with no lines left', async () => {
		vi.mocked(CartService.readFresh).mockResolvedValue(fresh('converted', []));
		await expect(refreshStockBeforeSubmit()).resolves.toEqual({ token: 't', revision: 1, status: 'converted' });
	});

	it('every call runs a new live read and returns that read\'s own revision (single-use, never remembered)', async () => {
		vi.mocked(CartService.readFresh)
			.mockResolvedValueOnce({ token: 't', revision: 3, status: 'active', lines: [line(true)] } as never)
			.mockResolvedValueOnce({ token: 't', revision: 4, status: 'active', lines: [line(true)] } as never);
		expect((await refreshStockBeforeSubmit()).revision).toBe(3);
		expect((await refreshStockBeforeSubmit()).revision).toBe(4);
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
		vi.mocked(CartService.readFresh).mockResolvedValue(fresh('converted', [line(false)]));
		await CartService.refresh(); // cart open / checkout re-entry adopts the live response
		expect(validateCheckoutStock().valid).toBe(true);
		await expect(refreshStockBeforeSubmit()).resolves.toEqual({ token: 't', revision: 1, status: 'converted' });
		expect(CartService.refresh).toHaveBeenCalledTimes(1);
		expect(CartService.readFresh).toHaveBeenCalledTimes(1); // the pre-submit read is its own live read, none skipped
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
