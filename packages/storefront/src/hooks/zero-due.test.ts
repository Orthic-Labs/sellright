import { describe, expect, it, vi } from 'vitest';
import { settleZeroDueProven } from './zero-due';

const run = (settle: () => Promise<{ state?: string } | null>, readOrder: () => Promise<{ state?: string }>) =>
	settleZeroDueProven('O1', 'rt', { settle: vi.fn(settle), readOrder: vi.fn(readOrder) });

describe('settleZeroDueProven', () => {
	it('a settle response with a settled state is proof, no read needed', async () => {
		const readOrder = vi.fn();
		expect(await settleZeroDueProven('O1', 'rt', { settle: async () => ({ state: 'Paid' }), readOrder })).toBe(true);
		expect(readOrder).not.toHaveBeenCalled();
	});

	it.each(['PendingPayment', 'Declined', 'Failed'])('HTTP 200 with state %s is NOT proof and falls to the read-back', async (state) => {
		const readOrder = vi.fn(async () => ({ state: 'PendingPayment' }));
		expect(await settleZeroDueProven('O1', 'rt', { settle: async () => ({ state }), readOrder })).toBe(false);
		expect(readOrder).toHaveBeenCalledTimes(1);
	});

	it('a 200 non-settled response is still settled when the read-back shows Paid', async () => {
		expect(await run(async () => ({ state: 'PendingPayment' }), async () => ({ state: 'Paid' }))).toBe(true);
	});

	it('a timeout/network failure with an unreadable order is NOT settled', async () => {
		expect(await run(() => Promise.reject(new Error('timeout')), () => Promise.reject(new Error('down')))).toBe(false);
	});

	it('a failure with the order still PendingPayment is NOT settled', async () => {
		expect(await run(() => Promise.reject(new Error('500')), async () => ({ state: 'PendingPayment' }))).toBe(false);
	});

	it('"already covered" (null) with a settled read-back is settled; without one it is not', async () => {
		expect(await run(async () => null, async () => ({ state: 'Paid' }))).toBe(true);
		expect(await run(async () => null, async () => ({ state: 'PendingPayment' }))).toBe(false);
	});

	it('a rejected settle that the server completed anyway is proven by the read', async () => {
		expect(await run(() => Promise.reject(new Error('timeout')), async () => ({ state: 'Paid' }))).toBe(true);
	});
});
