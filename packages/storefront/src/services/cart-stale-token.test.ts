import { describe, expect, it } from 'vitest';
import { withStaleCartRetry } from './cart-stale-token';

const err404 = () => Object.assign(new Error('not found'), { status: 404 });
const isStale = (e: unknown) => (e as { status?: number }).status === 404;

describe('withStaleCartRetry', () => {
	it('returns the first attempt untouched when it succeeds', async () => {
		let runs = 0, recreates = 0;
		const out = await withStaleCartRetry({
			run: async () => { runs++; return 'ok'; },
			isStaleCart: isStale,
			recreateCart: async () => { recreates++; },
		});
		expect(out).toBe('ok');
		expect(runs).toBe(1);
		expect(recreates).toBe(0);
	});

	it('a 404 clears the stale cart, recreates once, and retries exactly once', async () => {
		let runs = 0, recreates = 0;
		const out = await withStaleCartRetry({
			run: async () => {
				runs++;
				if (runs === 1) throw err404();
				return 'recovered';
			},
			isStaleCart: isStale,
			recreateCart: async () => { recreates++; },
		});
		expect(out).toBe('recovered');
		expect(runs).toBe(2);
		expect(recreates).toBe(1);
	});

	it('a second 404 after the retry propagates — the failure path, not success', async () => {
		let runs = 0, recreates = 0;
		await expect(
			withStaleCartRetry({
				run: async () => { runs++; throw err404(); },
				isStaleCart: isStale,
				recreateCart: async () => { recreates++; },
			}),
		).rejects.toMatchObject({ status: 404 });
		expect(runs).toBe(2);
		expect(recreates).toBe(1);
	});

	it('a non-404 error propagates immediately — no recreate, no retry', async () => {
		let runs = 0, recreates = 0;
		await expect(
			withStaleCartRetry({
				run: async () => { runs++; throw new Error('boom'); },
				isStaleCart: isStale,
				recreateCart: async () => { recreates++; },
			}),
		).rejects.toThrow(/boom/);
		expect(runs).toBe(1);
		expect(recreates).toBe(0);
	});
});
