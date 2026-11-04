import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	clientIpOf,
	createServerFunctionGuard,
	createServerFunctionRateLimit,
	isServerFunctionPost,
	isUnknownQrlError,
} from './qrl-guard';

type Req = { method: string; url: string; headers: Record<string, string>; socket: { remoteAddress: string } };
const req = (over: Partial<Req> = {}): Req => ({
	method: 'POST',
	url: '/?qfunc=4MIW00BrUF8',
	headers: {},
	socket: { remoteAddress: '80.94.92.137' },
	...over,
});

const makeRes = () => {
	const res = {
		statusCode: 200,
		headersSent: false,
		headers: {} as Record<string, string>,
		locals: {} as Record<string, unknown>,
		body: undefined as unknown,
		setHeader(k: string, v: string) {
			res.headers[k] = v;
			return res;
		},
		status(c: number) {
			res.statusCode = c;
			return res;
		},
		type() {
			return res;
		},
		send(b: unknown) {
			res.body = b;
			res.headersSent = true;
			return res;
		},
	};
	return res;
};

describe('isServerFunctionPost', () => {
	it('recognises a POST with the qfunc query key or the X-QRL header', () => {
		expect(isServerFunctionPost(req() as never)).toBe(true);
		expect(isServerFunctionPost(req({ url: '/checkout/', headers: { 'x-qrl': 'abc' } }) as never)).toBe(true);
	});
	it('ignores GETs and ordinary POSTs', () => {
		expect(isServerFunctionPost(req({ method: 'GET' }) as never)).toBe(false);
		expect(isServerFunctionPost(req({ url: '/newsletter/?x=1' }) as never)).toBe(false);
		expect(isServerFunctionPost(req({ url: '/p?notqfunc=1' }) as never)).toBe(false);
	});
});

describe('isUnknownQrlError', () => {
	it('matches the Q6 failure and nothing else', () => {
		expect(isUnknownQrlError(new Error('QWIK ERROR Code(Q6) qrl failed to load'))).toBe(true);
		expect(isUnknownQrlError(new Error('QWIK ERROR Code(6): something'))).toBe(true);
		expect(isUnknownQrlError(new Error('ECONNRESET'))).toBe(false);
		expect(isUnknownQrlError(new Error('Code(Q61) other'))).toBe(false);
		expect(isUnknownQrlError(undefined)).toBe(false);
	});
});

describe('clientIpOf', () => {
	it('uses the socket peer unless a trusted proxy is declared', () => {
		const r = req({ headers: { 'x-real-ip': '1.2.3.4' } });
		expect(clientIpOf(r as never, {})).toBe('80.94.92.137');
		expect(clientIpOf(r as never, { SELLRIGHT_TRUST_FORWARDED_HOST: '1' })).toBe('1.2.3.4');
	});
});

describe('createServerFunctionRateLimit', () => {
	it('answers 429 with Retry-After past the per-IP limit and recovers next window', () => {
		let t = 1_000;
		const limiter = createServerFunctionRateLimit({ limit: 3, windowMs: 60_000, now: () => t, env: {} });
		const run = (r: Req) => {
			const res = makeRes();
			const next = vi.fn();
			limiter(r as never, res as never, next);
			return { res, next };
		};
		for (let i = 0; i < 3; i++) expect(run(req()).next).toHaveBeenCalledTimes(1);
		const blocked = run(req());
		expect(blocked.next).not.toHaveBeenCalled();
		expect(blocked.res.statusCode).toBe(429);
		expect(Number(blocked.res.headers['Retry-After'])).toBeGreaterThan(0);
		// another IP is unaffected
		expect(run(req({ socket: { remoteAddress: '9.9.9.9' } })).next).toHaveBeenCalledTimes(1);
		t += 60_000;
		expect(run(req()).next).toHaveBeenCalledTimes(1);
	});

	it('does not limit an untrusted proxy peer (every shopper would share its address)', () => {
		const limiter = createServerFunctionRateLimit({ limit: 1, env: {} });
		for (const remoteAddress of ['127.0.0.1', '172.22.0.1', '::1', '10.0.0.5']) {
			for (let i = 0; i < 3; i++) {
				const next = vi.fn();
				limiter(req({ socket: { remoteAddress } }) as never, makeRes() as never, next);
				expect(next).toHaveBeenCalledTimes(1);
			}
		}
	});

	it('never limits GETs or other POSTs', () => {
		const limiter = createServerFunctionRateLimit({ limit: 1, env: {} });
		for (let i = 0; i < 5; i++) {
			const next = vi.fn();
			limiter(req({ method: 'GET' }) as never, makeRes() as never, next);
			limiter(req({ url: '/contact/' }) as never, makeRes() as never, next);
			expect(next).toHaveBeenCalledTimes(2);
		}
	});
});

describe('createServerFunctionGuard', () => {
	const qrlError = () => new Error('QWIK ERROR Code(Q6) qrl failed to load');
	afterEach(() => vi.restoreAllMocks());

	it('turns an unknown QRL into a 404 and writes one sampled warn line, no stack trace', async () => {
		const lines: string[] = [];
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const wrap = createServerFunctionGuard({ write: (l) => lines.push(l), perMinute: 2, now: () => 1 });
		// the real router logs the error itself, then calls next(err)
		const router = async (_q: never, _s: never, next: (e?: unknown) => void) => {
			console.error(qrlError());
			next(qrlError());
		};
		const handler = wrap(router as never);
		for (let i = 0; i < 5; i++) {
			const res = makeRes();
			const next = vi.fn();
			await handler(req() as never, res as never, next);
			expect(res.statusCode).toBe(404);
			expect(next).not.toHaveBeenCalled();
		}
		expect(lines.length).toBe(2); // sampled: 2 per minute, the rest dropped
		expect(lines[0]).toContain('unknown-qrl');
		expect(lines.join('\n')).not.toMatch(/\n\s+at /);
		// the router's own stack-trace line was swallowed for these requests (the spy saw none of them)
		expect(errSpy.mock.calls.some((c) => isUnknownQrlError(c[0]))).toBe(false);
	});

	it('leaves other errors and ordinary requests alone', async () => {
		const wrap = createServerFunctionGuard({ write: () => {} });
		const boom = new Error('boom');
		const handler = wrap((async (_q: never, _s: never, next: (e?: unknown) => void) => next(boom)) as never);
		const next = vi.fn();
		await handler(req() as never, makeRes() as never, next);
		expect(next).toHaveBeenCalledWith(boom);

		const passthrough = wrap((async (_q: never, _s: never, n: (e?: unknown) => void) => n(qrlError())) as never);
		const next2 = vi.fn();
		await passthrough(req({ method: 'GET', url: '/' }) as never, makeRes() as never, next2);
		expect(next2).toHaveBeenCalledTimes(1); // not a server-function POST: the error continues to the normal handler
	});

	it('does not touch console.error outside a server-function request', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		createServerFunctionGuard({ write: () => {} });
		console.error(qrlError());
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

// Last: building a guard patches console.error once, which must not happen before the spy-based test above.
describe('createServerFunctionGuard knownHashes', () => {
	it('answers 404 for a server-function hash outside the build, before the router runs', () => {
		const lines: string[] = [];
		const guard = createServerFunctionGuard({ write: (l) => lines.push(l), knownHashes: new Set(['known1']) });
		const router = vi.fn();
		const wrapped = guard(router as never);
		const res = makeRes();
		wrapped(req({ url: '/shop/?qfunc=stale9', headers: { 'x-qrl': 'stale9', 'content-type': 'application/qwik-json' } }) as never, res as never, vi.fn());
		expect(router).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(404);
		expect(lines).toHaveLength(1);
		wrapped(req({ url: '/shop/?qfunc=known1', headers: { 'x-qrl': 'known1', 'content-type': 'application/qwik-json' } }) as never, makeRes() as never, vi.fn());
		expect(router).toHaveBeenCalledTimes(1);
	});
});

describe('clientIpOf with BEHIND_CLOUDFLARE', () => {
	it('uses CF-Connecting-IP only when the peer is the local proxy, and never the forwarded host switch', () => {
		const env = { BEHIND_CLOUDFLARE: '1' };
		expect(clientIpOf(req({ headers: { 'cf-connecting-ip': '203.0.113.7' }, socket: { remoteAddress: '172.22.0.1' } }) as never, env)).toBe('203.0.113.7');
		expect(clientIpOf(req({ headers: { 'cf-connecting-ip': '203.0.113.7' }, socket: { remoteAddress: '198.51.100.9' } }) as never, env)).toBe('198.51.100.9');
		expect(clientIpOf(req({ headers: { 'cf-connecting-ip': 'not-an-ip' }, socket: { remoteAddress: '127.0.0.1' } }) as never, env)).toBe('127.0.0.1');
		expect(clientIpOf(req({ headers: { 'cf-connecting-ip': '203.0.113.7' }, socket: { remoteAddress: '127.0.0.1' } }) as never, {})).toBe('127.0.0.1');
	});
});
