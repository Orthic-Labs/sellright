import { createReadStream, promises as fs } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Serves the build-time `.br` / `.gz` sibling of an existing static file when the client accepts it. Anything else
// (no sibling, unsupported type, no matching Accept-Encoding, a skipped path) falls through to the plain static handler.
const TYPES: Record<string, string> = {
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
};

function accepted(header: string | undefined, coding: string): boolean {
	if (!header) return false;
	for (const part of header.split(',')) {
		const [name, ...params] = part.trim().toLowerCase().split(';');
		if (name !== coding) continue;
		const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
		return q === undefined || Number(q.slice(2)) > 0;
	}
	return false;
}

export function precompressedStatic(
	root: string,
	opts: { cacheControl?: string; skip?: (path: string) => boolean } = {},
): RequestHandler {
	const base = resolve(root);
	const cacheControl = opts.cacheControl ?? 'public, max-age=31536000, immutable';
	return (req: Request, res: Response, next: NextFunction) => {
		void (async () => {
			if (req.method !== 'GET' && req.method !== 'HEAD') return next();
			const type = TYPES[extname(req.path).toLowerCase()];
			if (!type || opts.skip?.(req.path)) return next();
			const header = req.headers['accept-encoding'];
			const coding = accepted(header, 'br') ? 'br' : accepted(header, 'gzip') ? 'gzip' : null;
			if (!coding) return next();
			let decoded: string;
			try { decoded = decodeURIComponent(req.path); } catch { return next(); }
			if (decoded.includes('\0')) return next();
			const file = resolve(join(base, decoded));
			if (!file.startsWith(base + sep)) return next();
			const sibling = file + (coding === 'br' ? '.br' : '.gz');
			try {
				const [orig, comp] = await Promise.all([fs.stat(file), fs.stat(sibling)]);
				if (!orig.isFile() || !comp.isFile()) return next();
				res.setHeader('Content-Type', type);
				res.setHeader('Content-Encoding', coding);
				res.setHeader('Vary', 'Accept-Encoding');
				res.setHeader('Cache-Control', cacheControl);
				res.setHeader('Last-Modified', orig.mtime.toUTCString());
				res.setHeader('ETag', `W/"${comp.size.toString(16)}-${Math.floor(comp.mtimeMs).toString(16)}-${coding}"`);
				if (req.fresh) { res.statusCode = 304; res.end(); return; }
				res.setHeader('Content-Length', String(comp.size));
				if (req.method === 'HEAD') { res.end(); return; }
				createReadStream(sibling).on('error', () => res.destroy()).pipe(res);
			} catch {
				next();
			}
		})();
	};
}
