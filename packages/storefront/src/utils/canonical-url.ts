/**
 * URL canonicalisation for public content sections: one URL shape, lowercase and
 * slash-terminated, so `/SHOP/` and `/contact` do not both answer 200 as
 * duplicates. A base capability driven by configuration: the list of public
 * sections comes from `STOREFRONT_CANONICAL_SECTIONS` (comma-separated first path
 * segments, for example `shop,blog,about,contact`). Unset or empty = OFF: no
 * request is ever redirected.
 *
 * Only a section's own page URLs are touched. Never redirected: non-GET/HEAD
 * requests (actions and server$ calls are POST), asset, API and framework-data
 * paths, anything with a file extension (documents, loader data, images), and
 * Qwik action/server-function query requests. Sections that carry
 * case-sensitive identifiers (checkout, account order codes) must not be listed.
 */

/** First path segments that are never canonicalised, even when listed. */
const NEVER_CANONICALISED = new Set(['build', 'assets', 'fonts', 'v1', 'api', 'checkout', 'account']);

/** Qwik action / server$ / loader-data request markers in the query string. */
const QWIK_DATA_QUERY = /(^|&)(qaction|qfunc|qdata)(=|&|$)/;

/** Parse the configured list: lowercase, trimmed, bare segment names only. */
export function parseCanonicalSections(raw: string | undefined | null): string[] {
	const out = new Set<string>();
	for (const part of (raw ?? '').split(',')) {
		const name = part.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
		if (/^[a-z0-9][a-z0-9_-]*$/.test(name) && !NEVER_CANONICALISED.has(name)) out.add(name);
	}
	return [...out];
}

/** The canonical URL (path + original query) for a request, or null when it is already canonical / out of scope. */
export function canonicalUrlRedirect(
	req: { method: string; path: string; originalUrl: string },
	sections: ReadonlySet<string> | readonly string[],
): string | null {
	if (req.method !== 'GET' && req.method !== 'HEAD') return null;
	const set = sections instanceof Set ? sections : new Set(sections);
	if (set.size === 0) return null;
	const section = req.path.split('/')[1]?.toLowerCase() ?? '';
	if (!set.has(section) || NEVER_CANONICALISED.has(section)) return null;
	if (/\.[a-z0-9]+$/i.test(req.path)) return null;
	const queryIndex = req.originalUrl.indexOf('?');
	const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
	if (query && QWIK_DATA_QUERY.test(query.slice(1))) return null;
	const target = req.path.toLowerCase().replace(/\/?$/, '/');
	return target === req.path ? null : target + query;
}

/** Express-compatible middleware (structural types: no express import here). */
export function createCanonicalUrlMiddleware(sections: readonly string[]) {
	const set = new Set(sections);
	return (
		req: { method: string; path: string; originalUrl: string },
		res: { redirect(status: number, url: string): void },
		next: () => void,
	): void => {
		const target = canonicalUrlRedirect(req, set);
		if (target === null) return next();
		res.redirect(301, target);
	};
}
