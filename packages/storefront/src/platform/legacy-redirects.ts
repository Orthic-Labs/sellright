// routes.json `redirects`: legacy URLs (an old platform's product pages, retired pages, links shared before a move) answered
// with a 301 to their live page, so they never reach the 404 page. Keys are an exact path (matched with or without the
// trailing slash) or a prefix ending in `/*`; exact entries win, then the longest prefix. Only page GET/HEAD requests.
import type { NextFunction, Request, Response } from 'express';

export interface LegacyRedirects {
	exact: Map<string, string>;
	prefixes: [string, string][];
}

const trimSlash = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

export function compileRedirects(map: Readonly<Record<string, string>>): LegacyRedirects {
	const exact = new Map<string, string>();
	const prefixes: [string, string][] = [];
	for (const [from, to] of Object.entries(map)) {
		if (from.endsWith('/*')) prefixes.push([from.slice(0, -1), to]);
		else exact.set(trimSlash(from), to);
	}
	prefixes.sort((a, b) => b[0].length - a[0].length);
	return { exact, prefixes };
}

/** The live target of a request path, or null. A prefix never matches its own bare root (`/product/*` leaves `/product/` alone). */
export function redirectTarget(r: LegacyRedirects, path: string): string | null {
	const hit = r.exact.get(trimSlash(path));
	if (hit !== undefined) return hit;
	for (const [prefix, to] of r.prefixes) if (path.startsWith(prefix) && path.length > prefix.length) return to;
	return null;
}

export function createLegacyRedirects(map: Readonly<Record<string, string>>) {
	const compiled = compileRedirects(map);
	const empty = compiled.exact.size === 0 && compiled.prefixes.length === 0;
	return (req: Request, res: Response, next: NextFunction) => {
		if (empty || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
		const to = redirectTarget(compiled, req.path);
		if (to === null || to === req.path) return next();
		res.redirect(301, to);
	};
}
