import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEAR_VIEWPORT_MARGIN, whenNearViewport } from './near-viewport';

type Entry = { isIntersecting: boolean };
class FakeIO {
	static last: FakeIO | null = null;
	observed: Element[] = [];
	disconnected = false;
	constructor(public cb: (entries: Entry[]) => void, public opts: { rootMargin?: string }) { FakeIO.last = this; }
	observe(el: Element) { this.observed.push(el); }
	disconnect() { this.disconnected = true; }
	emit(isIntersecting: boolean) { this.cb([{ isIntersecting }]); }
}

afterEach(() => { vi.unstubAllGlobals(); FakeIO.last = null; });

describe('whenNearViewport (lane 11: PDP reviews read gated on visibility)', () => {
	it('does not fire until the element is within ~400px of the viewport, then fires once and stops observing', () => {
		vi.stubGlobal('IntersectionObserver', FakeIO);
		const el = document.createElement('div');
		const load = vi.fn();
		whenNearViewport(el, load);
		const io = FakeIO.last!;
		expect(io.opts.rootMargin).toBe(NEAR_VIEWPORT_MARGIN);
		expect(NEAR_VIEWPORT_MARGIN).toMatch(/^400px/);
		expect(io.observed).toEqual([el]);
		expect(load).not.toHaveBeenCalled();
		io.emit(false);
		expect(load).not.toHaveBeenCalled();
		io.emit(true);
		io.emit(true);
		expect(load).toHaveBeenCalledTimes(1);
		expect(io.disconnected).toBe(true);
	});

	it('cleanup before visibility means no read at all', () => {
		vi.stubGlobal('IntersectionObserver', FakeIO);
		const load = vi.fn();
		const stop = whenNearViewport(document.createElement('div'), load);
		stop();
		FakeIO.last!.emit(true);
		expect(load).not.toHaveBeenCalled();
		expect(FakeIO.last!.disconnected).toBe(true);
	});

	it('without IntersectionObserver the content is not withheld: fires at once', () => {
		vi.stubGlobal('IntersectionObserver', undefined);
		const load = vi.fn();
		whenNearViewport(document.createElement('div'), load);
		expect(load).toHaveBeenCalledTimes(1);
	});
});
