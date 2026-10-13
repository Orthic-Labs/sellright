// The shop listing's live availability (the in-stock toggle, and shop.stockOnLoad = live). Fail closed: every listed product is out of
// stock unless the live read of THIS request returned it with `inStock === true`; a product the response omits (deleted, past the
// page) and every product of a failed read are out of stock. Pure; the callers keep one request generation so an older response can
// never replace a newer one. No cache: the result lives in the page's signal for the current view only.
export function liveListingAvailability(listedSlugs: readonly string[], live: { items: readonly { slug: string; inStock?: unknown }[] } | null): Record<string, boolean> {
	const inStock = new Set<string>();
	for (const item of live?.items ?? []) if (item && typeof item.slug === 'string' && item.inStock === true) inStock.add(item.slug);
	const out: Record<string, boolean> = {};
	for (const slug of listedSlugs) out[slug] = inStock.has(slug);
	return out;
}
