// #332: Qwik server-function ($server / server$) POSTs. A replayed id from an old build (the previous platform) made the
// router throw `QWIK ERROR Code(Q6) ... qrl failed to load`, which surfaced as a 500 with a full stack trace per request
// (200-500 a minute from one IP). Two guards, both pure and unit-tested:
//   1. a per-IP rate limit on server-function POSTs (429 + Retry-After);
//   2. an unknown/unloadable QRL is a plain 404 with ONE sampled warn line and no stack trace.
// Server-only: imported by entry.express.tsx.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isLocalProxyPeer, visitorIpFrom } from './sellright-visitor-ip.server';

type Writer = (line: string) => void;

/** A server-function call: a POST carrying the `qfunc` query key or the `X-QRL` header (what Qwik's client sends). */
export const isServerFunctionPost = (req: Pick<Request, 'method' | 'url' | 'headers'>): boolean => {
	if (req.method !== 'POST') return false;
	if (req.headers['x-qrl']) return true;
	const q = (req.url || '').indexOf('?');
	return q >= 0 && /(^|&)qfunc=/.test((req.url || '').slice(q + 1));
};

/** The error Qwik throws when a QRL symbol cannot be resolved/loaded (Q6), however the message is worded. */
export const isUnknownQrlError = (err: unknown): boolean => {
	const text = err instanceof Error ? `${err.message}\n${String((err as { code?: unknown }).code ?? '')}` : String(err ?? '');
	return /Code\(Q?6\)|qrl failed to load|\bQ6\b/i.test(text);
};

/** The requesting IP: the socket peer, or the proxy's x-real-ip only when a trusted proxy is declared (same rule as the API relays). */
export const clientIpOf = (
	req: { headers: Request['headers']; socket?: { remoteAddress?: string } },
	env: Record<string, string | undefined> = process.env,
): string => visitorIpFrom((name) => req.headers[name], req.socket?.remoteAddress, env) ?? 'unknown';

/** A loopback or private peer: the deployment's own proxy (nginx, Docker gateway), never a shopper. */
const isProxyPeer = (ip: string): boolean => ip === 'unknown' || isLocalProxyPeer(ip);

/** Admits at most `limit` server-function POSTs per IP per window; everything else (GETs, pages) is untouched.
 *  Behind a proxy whose x-real-ip is not trusted, every shopper shares the proxy's address: limiting that would throttle
 *  the whole site at once, so such requests are not limited (the unknown-QRL 404 guard still applies). */
export const createServerFunctionRateLimit = (
	opts: { limit?: number; windowMs?: number; now?: () => number; maxTracked?: number; env?: Record<string, string | undefined> } = {},
): RequestHandler => {
	const limit = opts.limit ?? 60;
	const windowMs = opts.windowMs ?? 60_000;
	const now = opts.now ?? Date.now;
	const maxTracked = opts.maxTracked ?? 10_000;
	const hits = new Map<string, { start: number; count: number }>();
	return (req: Request, res: Response, next: NextFunction) => {
		if (!isServerFunctionPost(req)) return next();
		const t = now();
		const ip = clientIpOf(req, opts.env);
		if (isProxyPeer(ip)) return next();
		let slot = hits.get(ip);
		if (!slot || t - slot.start >= windowMs) {
			if (!slot && hits.size >= maxTracked) {
				for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
				if (hits.size >= maxTracked) hits.clear(); // bounded memory beats perfect accounting under a spray of addresses
			}
			slot = { start: t, count: 0 };
			hits.set(ip, slot);
		}
		slot.count++;
		if (slot.count > limit) {
			const retry = Math.max(1, Math.ceil((slot.start + windowMs - t) / 1000));
			res.setHeader('Retry-After', String(retry));
			res.setHeader('Cache-Control', 'private, no-store');
			res.status(429).type('text/plain').send('Too many requests');
			return;
		}
		next();
	};
};

// The router logs a failed request with console.error(err) before it hands the error on, so the stack trace is already
// out by the time an error handler sees it. A scoped filter drops that one line, and only for a server-function POST
// that failed with the unknown-QRL error; every other console.error passes through untouched.
const inServerFunction = new AsyncLocalStorage<true>();
const FILTER_MARK = Symbol.for('sellright.qrlErrorFilter');
const patchConsoleOnce = (): void => {
	if ((console.error as unknown as Record<symbol, unknown>)[FILTER_MARK]) return;
	const original = console.error.bind(console);
	const filtered = (...args: unknown[]) => {
		if (inServerFunction.getStore() && args.length === 1 && isUnknownQrlError(args[0])) return;
		original(...args);
	};
	(filtered as unknown as Record<symbol, unknown>)[FILTER_MARK] = true;
	console.error = filtered;
};

/** The server-function hash a POST names: the `X-QRL` header, else the `qfunc` query value. */
export const serverFunctionHash = (req: Pick<Request, 'url' | 'headers'>): string => {
	const h = req.headers['x-qrl'];
	if (typeof h === 'string' && h) return h;
	const q = (req.url || '').indexOf('?');
	return q >= 0 ? new URLSearchParams((req.url || '').slice(q + 1)).get('qfunc') ?? '' : '';
};

/**
 * Wraps the Qwik router: a server-function POST whose QRL cannot be loaded answers 404 (not 500) and writes one warn
 * line, at most `perMinute` of them (a dropped count is reported when the window rolls). Other requests and other
 * errors go to `next` exactly as before.
 * `knownHashes` (the build manifest's symbol hashes) rejects an id this build never had before the router runs: the
 * Qwik 2 router answers a failed server function with its own 500 and never hands the error on.
 */
export const createServerFunctionGuard = (
	opts: { perMinute?: number; write?: Writer; now?: () => number; knownHashes?: ReadonlySet<string> } = {},
) => {
	const perMinute = opts.perMinute ?? 6;
	const write: Writer = opts.write ?? ((line) => process.stderr.write(line + '\n'));
	const now = opts.now ?? Date.now;
	let windowStart = now();
	let logged = 0;
	let dropped = 0;
	const warn = (ip: string): void => {
		const t = now();
		if (t - windowStart >= 60_000) {
			if (dropped) write(`[server-function] ${JSON.stringify({ t: new Date(t).toISOString(), unknownQrlDropped: dropped })}`);
			windowStart = t;
			logged = 0;
			dropped = 0;
		}
		if (logged < perMinute) {
			logged++;
			write(`[server-function] ${JSON.stringify({ t: new Date(t).toISOString(), status: 404, reason: 'unknown-qrl', ip })}`);
		} else {
			dropped++;
		}
	};
	patchConsoleOnce();
	return (router: RequestHandler): RequestHandler =>
		(req, res, next) => {
			if (!isServerFunctionPost(req)) return router(req, res, next);
			if (opts.knownHashes?.size && !opts.knownHashes.has(serverFunctionHash(req))) {
				warn(clientIpOf(req));
				res.locals.quietNotFound = true;
				res.setHeader('Cache-Control', 'private, no-store');
				res.status(404).type('text/plain').send('Not found');
				return;
			}
			return inServerFunction.run(true, () =>
				router(req, res, (err?: unknown) => {
					if (err && isUnknownQrlError(err) && !res.headersSent) {
						warn(clientIpOf(req));
						res.locals.quietNotFound = true; // utils/error-path-log.ts skips this one: the warn line above is the record
						res.setHeader('Cache-Control', 'private, no-store');
						res.status(404).type('text/plain').send('Not found');
						return;
					}
					next(err as never);
				}),
			);
		};
};
