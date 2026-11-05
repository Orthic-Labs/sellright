// Lane 11: start below-the-fold work (a network read) only when its element nears the viewport, never on the page's load.

/** How far ahead of the viewport the element counts as "near" (the PDP reviews block reads when it is ~400px away). */
export const NEAR_VIEWPORT_MARGIN = '400px 0px';

/**
 * Calls `onNear` once, the first time `el` is within `rootMargin` of the viewport, then stops observing. Without
 * IntersectionObserver (old browsers) it calls at once, so the content never stays missing. Returns the cleanup.
 */
export function whenNearViewport(el: Element, onNear: () => void, rootMargin: string = NEAR_VIEWPORT_MARGIN): () => void {
	let done = false;
	const fire = () => {
		if (done) return;
		done = true;
		onNear();
	};
	if (typeof IntersectionObserver === 'undefined') {
		fire();
		return () => { done = true; };
	}
	const observer = new IntersectionObserver((entries) => {
		if (!entries.some((e) => e.isIntersecting)) return;
		observer.disconnect();
		fire();
	}, { rootMargin });
	observer.observe(el);
	return () => {
		done = true;
		observer.disconnect();
	};
}
