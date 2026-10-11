/**
 * The checkout route's single view generation: one monotonically increasing counter for "which payment view is on
 * screen". It is bumped when the view is replaced — payment-method switch, resume start, payment-component retry,
 * start-new-cart and leaving the page. Every async handler captures it at entry and returns without touching state or
 * navigating once it has changed; a payment component captures it at mount (`mountGen`) and passes it with each
 * callback, so a stale component's callback is rejected even when its QRL only runs after the view was replaced.
 *
 * A payment-error recovery does NOT bump: the mounted component stays the one in charge after a decline.
 */
export interface ViewGeneration {
	gen: number;
}

export const bumpView = (view: ViewGeneration): number => ++view.gen;

export const isCurrentView = (view: ViewGeneration, gen: number): boolean => view.gen === gen;

/** A component callback is accepted only from the mount that is still the current view. Absent id = legacy caller. */
export const acceptsMount = (view: ViewGeneration, mountGen: number | undefined): boolean =>
	mountGen === undefined || view.gen === mountGen;
