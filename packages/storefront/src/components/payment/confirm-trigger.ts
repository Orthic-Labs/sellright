/**
 * Decides whether a confirm trigger should run. `baseline` is the trigger value consumed so far; it must start
 * as the signal value AT MOUNT, so a stale confirm left over from a previous mount (the parent's signal survives
 * a payment-method switch) is never replayed. Only increments received during this mount are acted on, and one
 * received before the fields are ready is held until they are. A trigger reset to 0 (the page forgets a previous order,
 * e.g. after a changed total is confirmed) resets the baseline too: otherwise the next click (0 -> 1) equals the old
 * baseline and is silently dropped (#403).
 */
export const nextConfirm = (trigger: number, ready: boolean, baseline: number): { run: boolean; baseline: number } => {
	if (!trigger) return { run: false, baseline: 0 };
	if (!ready || trigger === baseline) return { run: false, baseline };
	return { run: true, baseline: trigger };
};
