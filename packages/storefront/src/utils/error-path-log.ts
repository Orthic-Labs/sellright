// #364: one stderr line per 404 or 5xx response, so a broken link or a failing page is named in the pm2 log (production
// nginx redacts URLs and referrers). Paths only, never a query string; secret-bearing segments are redacted; a per-minute
// cap keeps a scanner from flooding the log.
import type { NextFunction, Request, Response } from 'express';

/** The segment after one of these carries an order code, subscriber id, token or address id: always redacted. */
const SECRET_AFTER = new Set(['orders', 'confirmation', 'confirm', 'unsubscribe', 'address-book', 'password-reset', 'verify']);
/** A segment that reads as a token: a UUID/hex run, or a long opaque run with several digits. Slugs keep their words. */
const looksLikeToken = (s: string): boolean =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^[0-9a-f]{20,}$/i.test(s) || (/^[A-Za-z0-9_~.-]{20,}$/.test(s) && (s.match(/\d/g)?.length ?? 0) >= 6);

/** The request path with no query string, each secret-bearing segment replaced by `:redacted`, capped at 200 chars. */
export const redactPath = (raw: string): string => {
	const path = raw.split(/[?#]/)[0];
	const parts = path.split('/');
	const out = parts.map((seg, i) => {
		if (!seg) return seg;
		if (i > 0 && SECRET_AFTER.has(parts[i - 1].toLowerCase())) return ':redacted';
		return looksLikeToken(seg) || /@|%40/i.test(seg) ? ':redacted' : seg;
	});
	return out.join('/').slice(0, 200);
};

/** Same-host referrer: its redacted path. Another site: its host only. Missing or unparseable: undefined. */
export const referrerFor = (referer: string | undefined, host: string | undefined): string | undefined => {
	if (!referer) return undefined;
	try {
		const u = new URL(referer);
		return host && u.host.toLowerCase() === host.toLowerCase() ? redactPath(u.pathname) : u.host;
	} catch {
		return undefined;
	}
};

export const shouldLog = (status: number): boolean => status === 404 || status >= 500;

type Writer = (line: string) => void;

export const createErrorPathLog = (opts: { perMinute?: number; write?: Writer; now?: () => number } = {}) => {
	const perMinute = opts.perMinute ?? 120;
	const write: Writer = opts.write ?? ((line) => process.stderr.write(line + '\n'));
	const now = opts.now ?? Date.now;
	let windowStart = now();
	let logged = 0;
	let dropped = 0;
	const admit = (t: number): boolean => {
		if (t - windowStart >= 60_000) {
			if (dropped) write(`[http-error] ${JSON.stringify({ t: new Date(t).toISOString(), dropped })}`);
			windowStart = t;
			logged = 0;
			dropped = 0;
		}
		if (logged < perMinute) {
			logged++;
			return true;
		}
		dropped++;
		return false;
	};
	return (req: Request, res: Response, next: NextFunction) => {
		const t0 = now();
		res.on('finish', () => {
			if (!shouldLog(res.statusCode)) return;
			const t = now();
			if (!admit(t)) return;
			write(`[http-error] ${JSON.stringify({
				t: new Date(t).toISOString(),
				status: res.statusCode,
				method: req.method,
				path: redactPath(req.originalUrl || req.url || ''),
				ref: referrerFor(req.headers.referer, req.headers.host),
				ms: t - t0,
				ua: String(req.headers['user-agent'] || '').slice(0, 60),
			})}`);
		});
		next();
	};
};
