// F1: first-paint stall triggers (backdrop-filter, scroll/view-timeline animations) are gated behind this class on <html>.
// It is added once the page has loaded and painted (the layout's qidle handler), so the first frame never pays for them.
// CSS gates on `.sr-fx` (core header-styles, brand header/scroll CSS). Without JS the effects simply stay off.
export const POST_PAINT_FX_CLASS = 'sr-fx';

export function enablePostPaintEffects(doc: Document = document): void {
	const root = doc.documentElement;
	if (root.classList.contains(POST_PAINT_FX_CLASS)) return;
	// Two frames: the class lands after a frame that has already been presented.
	const raf = doc.defaultView?.requestAnimationFrame?.bind(doc.defaultView);
	if (!raf) {
		root.classList.add(POST_PAINT_FX_CLASS);
		return;
	}
	raf(() => raf(() => root.classList.add(POST_PAINT_FX_CLASS)));
}
