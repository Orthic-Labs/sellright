import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterLoadIdleOrInteraction } from './load-trigger';

const state = (p: Promise<void>) => { let done = false; void p.then(() => { done = true; }); return () => done; };
const setReady = (v: DocumentReadyState) => Object.defineProperty(document, 'readyState', { configurable: true, get: () => v });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setReady('complete'); });

describe('afterLoadIdleOrInteraction (P7/V15 trigger)', () => {
	it('waits for window load, then idle', async () => {
		vi.useFakeTimers();
		setReady('loading');
		const ric = vi.fn((cb: () => void) => { setTimeout(cb, 50); return 1; });
		vi.stubGlobal('requestIdleCallback', ric);
		const done = state(afterLoadIdleOrInteraction());
		await vi.advanceTimersByTimeAsync(1000);
		expect(done()).toBe(false);
		expect(ric).not.toHaveBeenCalled();
		window.dispatchEvent(new Event('load'));
		expect(ric).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60);
		expect(done()).toBe(true);
	});

	it('resolves early on the first interaction', async () => {
		vi.useFakeTimers();
		setReady('loading');
		const done = state(afterLoadIdleOrInteraction());
		await vi.advanceTimersByTimeAsync(10);
		expect(done()).toBe(false);
		window.dispatchEvent(new Event('pointerdown'));
		await vi.advanceTimersByTimeAsync(0);
		expect(done()).toBe(true);
	});

	it('never waits past maxWaitMs (wallet readiness still reported on a slow load)', async () => {
		vi.useFakeTimers();
		setReady('loading');
		const done = state(afterLoadIdleOrInteraction({ maxWaitMs: 3000 }));
		await vi.advanceTimersByTimeAsync(2999);
		expect(done()).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(done()).toBe(true);
	});

	it('an already-loaded page only waits for idle (setTimeout fallback without requestIdleCallback)', async () => {
		vi.useFakeTimers();
		setReady('complete');
		vi.stubGlobal('requestIdleCallback', undefined);
		const done = state(afterLoadIdleOrInteraction());
		await vi.advanceTimersByTimeAsync(199);
		expect(done()).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(done()).toBe(true);
	});
});
