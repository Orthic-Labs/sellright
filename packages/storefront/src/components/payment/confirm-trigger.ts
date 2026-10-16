/**
 * Decides whether a confirm trigger should run. `baseline` is the trigger value consumed so far; it must start
 * as the signal value AT MOUNT, so a stale confirm left over from a previous mount (the parent's signal survives
 * a payment-method switch) is never replayed. Only increments received during this mount are acted on, and one
 * received before the fields are ready is held until they are.
 */
export const nextConfirm = (trigger: number, ready: boolean, baseline: number): { run: boolean; baseline: number } => {
	if (!trigger || !ready || trigger === baseline) return { run: false, baseline };
	return { run: true, baseline: trigger };
};
