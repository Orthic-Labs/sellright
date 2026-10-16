// Brand views, plan §2.5: declared content paths. Pure (no Qwik, no Node) so the build-time validator and the runtime
// catch-all share it. A brand declares exact content paths in src/brand/routes.json; there are no handlers and no patterns.

// One or more lowercase hyphenated segments with a trailing slash. A single-segment path (`/slow-fashion/`) is served by the `[key]`
// route, which renders the declared page and keeps answering `/<key>.txt` (IndexNow) and a plain 404 for anything undeclared; deeper
// paths by the catch-all. A path segment can never contain a dot, so a declaration never shadows a key file.
export const CONTENT_PATH = /^\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*\/$/;
export const PAGE_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** First path segments a brand may never claim, besides every top-level `src/routes` directory (walked at build). */
export const FIXED_RESERVED_PREFIXES = ['api', 'admin', 'assets', 'build', 'fonts', 'favicon', 'media', 'brand', '.well-known'] as const;

export const BUILT_IN_CONTENT_PATHS = ['/about/', '/privacy/', '/terms/', '/returns/', '/press/'] as const;

/** The built-in static page paths a `pages` entry may carry a head for. */
export const BUILT_IN_PAGE_PATHS = ['/', '/about/', '/privacy/', '/terms/', '/returns/', '/press/', '/contact/', '/blog/', '/shop/'] as const;

export interface DeclaredContent {
	path: string;
	pageKey: string;
	head?: { title?: string; description?: string; noindex?: boolean };
}

export interface ContentRoutesInput {
	/** Exact route.content selections; absent preserves every existing content mount. */
	contentViewPaths?: string[];
	content?: DeclaredContent[];
	pages?: Record<string, { head?: { title?: string; description?: string; noindex?: boolean } }>;
}

/** `/a/b/` -> `a`; anything else -> ''. */
export const firstSegment = (path: string): string => path.split('/')[1] ?? '';

/**
 * Problems with the declared paths, or []. `routeDirs` = every top-level directory name of src/routes (including `[...catchall]`
 * style names, which can never collide because a content path segment is lowercase words).
 */
export function checkContentPaths(input: ContentRoutesInput, routeDirs: readonly string[]): string[] {
	const problems: string[] = [];
	const reserved = new Set<string>([...FIXED_RESERVED_PREFIXES, ...routeDirs.map((d) => d.toLowerCase())]);
	const seenPath = new Set<string>();
	const seenKey = new Set<string>();
	for (const entry of input.content ?? []) {
		const p = entry.path;
		if (typeof p !== 'string' || !CONTENT_PATH.test(p)) {
			problems.push(`content path ${JSON.stringify(p)} must be lowercase hyphenated segments with a leading and a trailing slash (e.g. "/slow-fashion/" or "/about/our-story/")`);
			continue;
		}
		const first = firstSegment(p);
		if (reserved.has(first) || first.startsWith('_')) problems.push(`content path ${p}: "${first}" is a reserved or existing route prefix`);
		if (seenPath.has(p)) problems.push(`content path ${p} is declared twice`);
		seenPath.add(p);
		if (typeof entry.pageKey !== 'string' || !PAGE_KEY.test(entry.pageKey)) problems.push(`content path ${p}: pageKey ${JSON.stringify(entry.pageKey)} must be lowercase words joined by hyphens`);
		else if (seenKey.has(entry.pageKey)) problems.push(`pageKey ${entry.pageKey} is declared twice`);
		else seenKey.add(entry.pageKey);
	}
	for (const key of Object.keys(input.pages ?? {})) {
		if (!(BUILT_IN_PAGE_PATHS as readonly string[]).includes(key)) problems.push(`pages key ${JSON.stringify(key)} is not a built-in static page (${BUILT_IN_PAGE_PATHS.join(', ')})`);
	}
	if (input.contentViewPaths !== undefined) {
		const allowed = new Set<string>([...BUILT_IN_CONTENT_PATHS, ...(input.content ?? []).map((c) => c.path)]);
		const selected = new Set<string>();
		for (const path of input.contentViewPaths) {
			if (selected.has(path)) problems.push(`contentViewPaths path ${path} is listed twice`);
			selected.add(path);
			if (!CONTENT_PATH.test(path) || !allowed.has(path)) problems.push(`contentViewPaths path ${JSON.stringify(path)} is not a declared content path or supported built-in content page`);
		}
		for (const entry of input.content ?? []) {
			if (!selected.has(entry.path)) problems.push(`content path ${entry.path} is omitted from contentViewPaths; every declared path needs its content view`);
		}
	}
	return problems;
}

/** Exact path selection, with the original all-mount behavior when no allowlist is declared. */
export const selectsContentView = (paths: readonly string[] | undefined, pathname: string): boolean => paths === undefined || paths.includes(pathname);

/** The declaration for an exact request pathname, or null. Exact match only: no case folding, no prefix, no wildcard. */
export function matchDeclaredPath(content: readonly DeclaredContent[], pathname: string): DeclaredContent | null {
	if (!CONTENT_PATH.test(pathname)) return null;
	return content.find((c) => c.path === pathname) ?? null;
}
