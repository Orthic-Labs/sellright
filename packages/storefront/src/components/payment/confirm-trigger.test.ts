import { describe, expect, it } from 'vitest';
import { nextConfirm } from './confirm-trigger';

describe('nextConfirm', () => {
	it('holds an early confirm in the same mount, then runs it once when ready', () => {
		let baseline = 0; // signal value at mount
		expect(nextConfirm(1, false, baseline)).toEqual({ run: false, baseline: 0 });
		const ready = nextConfirm(1, true, baseline);
		expect(ready).toEqual({ run: true, baseline: 1 });
		baseline = ready.baseline;
		expect(nextConfirm(1, true, baseline).run).toBe(false);
	});

	it('does nothing on remount with a stale non-zero trigger', () => {
		const baseline = 3; // signal value at mount
		expect(nextConfirm(3, false, baseline).run).toBe(false);
		expect(nextConfirm(3, true, baseline).run).toBe(false);
	});

	it('runs a new increment after remount exactly once', () => {
		let baseline = 3;
		const r = nextConfirm(4, true, baseline);
		expect(r).toEqual({ run: true, baseline: 4 });
		baseline = r.baseline;
		expect(nextConfirm(4, true, baseline).run).toBe(false);
	});

	it('ignores a zero trigger', () => {
		expect(nextConfirm(0, true, 0).run).toBe(false);
	});

	it('a trigger reset to 0 while mounted resets the baseline, so the next click runs (#403)', () => {
		let baseline = 0;
		baseline = nextConfirm(1, true, baseline).baseline; // first PLACE ORDER (stopped by a changed total)
		expect(baseline).toBe(1);
		baseline = nextConfirm(0, true, baseline).baseline; // the page resets its order state and the trigger
		expect(baseline).toBe(0);
		expect(nextConfirm(1, true, baseline)).toEqual({ run: true, baseline: 1 }); // the click after confirming
	});
});
