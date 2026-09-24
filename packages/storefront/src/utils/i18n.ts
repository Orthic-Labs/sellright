export function extractBase(): string {
	// Vite bakes its `base` config (vite.config.ts, always '/' for this
	// package) into import.meta.env.BASE_URL at build time — deriving from it
	// here instead of hardcoding '/build' keeps this correct if `base` is ever
	// something other than '/', with zero behavior change while it isn't.
	const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
	return `${base}/build`;
}
