/**
 * The single place that decides cache headers for storefront responses (docs/adr/ADR-0001-edge-cached-shell.md).
 *
 * Route classes (ADR "Route classes"):
 *   shell   — `/`, `/shop/`, product pages (`/products/*`, and `/shop/<slug>/` when routes.json productPath is `/shop/:slug/`),
 *             `/collections/<slug>`, `/blog`, `/blog/<slug>`, `/about`, `/contact`, legal pages, `/checkout/` (exact).
 *             The HTML is free of per-visitor data, stock and price (live values are read by the browser), so it MAY be stored
 *             at the edge — but only when SHELL_CACHE=1 and the finished response passes I-6 (below).
 *   dynamic — every other path (checkout steps, account, sign-in, search, track-order, verify, password routes, /api, /cache*),
 *             any non-GET request, any preview request (preview_token query or sr_preview_token cookie), any shell path with a
 *             query other than ad-click tracking parameters (I-3), and every unclassified path (I-5 fail closed).
 *   data    — Qwik loader/action/server$ data (`q-loader-*.json`, `q-data.json`, `?qaction=`, `?qfunc=`) and `/v1/*`.
 *
 * Every response starts `private, no-store` (layout onRequest + the express fail-closed default). With SHELL_CACHE=1 the express
 * layer (createShellRequestMiddleware + createShellCacheMiddleware, wired in entry.express.tsx):
 *   request (I-2): a `shell` request has Cookie, Authorization, cf-ipcountry, x-preview-token and x-qwik-nonce removed BEFORE the
 *     cookie/host contexts and Qwik see it, and renders without a CSP nonce;
 *   response (I-6): the body is buffered; the CSP gets the sha256 of every executable inline script in that exact body; and the
 *     response becomes `public, max-age=0, s-maxage=<SHELL_CACHE_TTL>` only if: class shell, status 200, text/html, no
 *     Set-Cookie, no veto header (identity fallback, maintenance on/unknown, authenticated, preview, unpublished — set by
 *     layout loaders through vetoEdgeCache), anonymous context. Anything else stays `private, no-store`.
 * With SHELL_CACHE unset (default) neither middleware does anything: every document is `private, no-store` with the per-request
 * nonce CSP, exactly as before.
 * `no-cache`/`must-revalidate` are kept alongside `no-store` for older intermediaries and the e2e/prod-smoke checks.
 */
import { PRODUCT_PREFIX } from '~/platform/product-path';
import { inlineScriptHashSources, withScriptHashes } from '~/utils/csp';

export const NO_STORE_CACHE_CONTROL = 'private, no-store, no-cache, must-revalidate';

export type RouteClass = 'shell' | 'dynamic' | 'data';

export interface RouteCacheProfile {
	routeClass: RouteClass;
	responseCacheControl: string;
}

export const CACHE_POLICY_VERSION = '2026-10-31.1';

// ─── switch ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const SHELL_CACHE_ENV = 'SHELL_CACHE';
export const SHELL_CACHE_TTL_ENV = 'SHELL_CACHE_TTL';
export const DEFAULT_SHELL_TTL_SECONDS = 300;

type Env = Record<string, string | undefined>;
const processEnv = (): Env => (typeof process !== 'undefined' && process.env ? process.env : {});

/** ADR-0001 switch: on only when the process env has SHELL_CACHE=1 (default off; always false in the browser). */
export const shellCacheEnabled = (env: Env = processEnv()): boolean => env[SHELL_CACHE_ENV] === '1';

/** Edge lifetime of a cacheable shell: SHELL_CACHE_TTL as a positive integer of seconds, else 300. */
export const shellTtlSeconds = (env: Env = processEnv()): number => {
	const raw = (env[SHELL_CACHE_TTL_ENV] ?? '').trim();
	const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
	return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_SHELL_TTL_SECONDS;
};

/** The only shared-cacheable header: browser always revalidates, edge keeps it TTL seconds. No stale-while-revalidate. */
export const shellCacheControl = (ttlSeconds: number): string => `public, max-age=0, s-maxage=${ttlSeconds}`;

// ─── route classes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Exact shell paths, matched with or without the trailing slash. */
const SHELL_EXACT = ['/', '/shop', '/about', '/contact', '/privacy', '/terms', '/returns', '/press', '/blog', '/checkout'];
const ONE_SEGMENT = '[^/]+';
const DATA_PATH = /(^|\/)q-(loader|data|action)[^/]*\.json$/i;
const DATA_QUERY = ['qaction', 'qfunc', 'qloaders', 'qdata'];
/** Ad-click tracking parameters: the only query keys a shell response may carry (they never change server output). */
const TRACKING_PARAM = /^(utm_[a-z_]+|gclid|gbraid|wbraid|dclid|fbclid|msclkid|ttclid|twclid|li_fat_id|mc_cid|mc_eid|_gl|_ga)$/i;
export const PREVIEW_QUERY_PARAM = 'preview_token';
export const PREVIEW_COOKIE = 'sr_preview_token';

const strip = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

function shellPath(pathname: string, productPrefix: 'products' | 'shop'): boolean {
	const p = strip(pathname);
	if (SHELL_EXACT.includes(p)) return true;
	if (/^\/products\/.+/.test(p)) return true;
	if (productPrefix === 'shop' && new RegExp(`^/shop/${ONE_SEGMENT}$`).test(p)) return true;
	if (new RegExp(`^/collections/${ONE_SEGMENT}$`).test(p)) return true;
	if (new RegExp(`^/blog/${ONE_SEGMENT}$`).test(p)) return true;
	return false;
}

/** routeClass with the product prefix injected (tests). */
export function routeClassFor(pathname: string, search: URLSearchParams, productPrefix: 'products' | 'shop'): RouteClass {
	if (pathname === '/v1' || pathname.startsWith('/v1/') || DATA_PATH.test(pathname)) return 'data';
	for (const key of DATA_QUERY) if (search.has(key)) return 'data';
	if (search.has(PREVIEW_QUERY_PARAM)) return 'dynamic';
	if (!shellPath(pathname, productPrefix)) return 'dynamic';
	// I-3: a cacheable response must be identical for every query string; any key that could change output makes it dynamic.
	for (const key of search.keys()) if (!TRACKING_PARAM.test(key)) return 'dynamic';
	return 'shell';
}

/** ADR-0001 route class of a GET document request (pathname + query). Fails closed: anything unclassified is `dynamic`. */
export const routeClass = (pathname: string, search: URLSearchParams): RouteClass => routeClassFor(pathname, search, PRODUCT_PREFIX);

const hasCookie = (cookie: string | undefined, name: string) =>
	(cookie ?? '').split(';').some((part) => part.split('=')[0]!.trim() === name);

/** The class of a whole request: only GET can be `shell` (HEAD and every write are `dynamic`); a preview cookie is a preview. */
export function requestRouteClass(req: { method: string; pathname: string; search: string; cookie: string | undefined }): RouteClass {
	const search = new URLSearchParams(req.search);
	const cls = routeClass(req.pathname, search);
	if (cls === 'data') return 'data';
	if (req.method !== 'GET') return 'dynamic';
	if (cls === 'shell' && hasCookie(req.cookie, PREVIEW_COOKIE)) return 'dynamic';
	return cls;
}

// ─── layout onRequest profile (diagnostic x-route-class + the no-store default) ───────────────────────────────────────────

/** Every profile is private no-store: the layout never marks anything public; only the express response-end check does. */
export const getRouteCacheProfile = (pathname: string): RouteCacheProfile => ({
	routeClass: routeClass(pathname, new URLSearchParams()),
	responseCacheControl: NO_STORE_CACHE_CONTROL,
});

/**
 * Qwik Router rc serves loader data from `{route}/q-loader-{id}.{hash}.json` and strips that suffix from `url.pathname` before
 * handlers run, so a page-path profile would wrongly classify the data response as the page. Router flags set on `sharedMap`:
 * `@isQLoader`, `@isQAction` (router lib/chunks/request-path.mjs, user-response.mjs createRequestEvent).
 */
const INTERNAL_DATA_FLAGS = ['@isQLoader', '@isQAction'];

export const isInternalDataRequest = (sharedMap: { has(key: string): boolean }) =>
	INTERNAL_DATA_FLAGS.some((flag) => sharedMap.has(flag));

/** Loader/action data is cookie-dependent (identity, auth, country, maintenance, catalog): never stored. */
export const getDataRequestCacheProfile = (): RouteCacheProfile => ({ routeClass: 'data', responseCacheControl: NO_STORE_CACHE_CONTROL });

export const resolveRouteCacheProfile = (pathname: string, sharedMap: { has(key: string): boolean }): RouteCacheProfile =>
	isInternalDataRequest(sharedMap) ? getDataRequestCacheProfile() : getRouteCacheProfile(pathname);

// ─── veto (set by layout loaders) ───────────────────────────────────────────────────────────────────────────────────────

/** Loader-set response header that forbids storing this response (value = reason). Removed before the response leaves. */
export const EDGE_VETO_HEADER = 'x-sr-edge-veto';
export const vetoEdgeCache = (headers: { set(name: string, value: string): void }, reason: string): void => headers.set(EDGE_VETO_HEADER, reason);

/** Diagnostic header (only when SHELL_CACHE=1): `cacheable` or `bypass:<reason>`. */
export const SHELL_DIAG_HEADER = 'x-sr-edge';

// ─── I-6: the response-end verdict (pure) ──────────────────────────────────────────────────────────────────────────────────

export type ShellVerdict = { ok: true } | { ok: false; reason: string };

export interface ShellResponseFacts {
	routeClass: RouteClass;
	/** The request reached Qwik with no Cookie/Authorization/preview input (createShellRequestMiddleware ran). */
	anonymous: boolean;
	enabled: boolean;
	status: number;
	contentType: string | undefined;
	setCookie: unknown;
	/** EDGE_VETO_HEADER value: identity fallback, maintenance on/unknown, authenticated, preview, unpublished, error fallback. */
	veto: unknown;
}

const present = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

/** I-6. Cacheability is decided after render; anything but an all-clear is `private, no-store`. */
export function shellResponseVerdict(f: ShellResponseFacts): ShellVerdict {
	if (!f.enabled) return { ok: false, reason: 'disabled' };
	if (f.routeClass !== 'shell') return { ok: false, reason: `class:${f.routeClass}` };
	if (!f.anonymous) return { ok: false, reason: 'not-anonymous' };
	if (f.status !== 200) return { ok: false, reason: `status:${f.status}` };
	if (!/^text\/html\b/i.test(f.contentType ?? '')) return { ok: false, reason: 'content-type' };
	if (present(f.setCookie)) return { ok: false, reason: 'set-cookie' };
	if (present(f.veto)) return { ok: false, reason: `veto:${String(f.veto)}` };
	return { ok: true };
}

/** The Cache-Control a finished response leaves with. */
export const shellResponseCacheControl = (f: ShellResponseFacts, ttlSeconds: number): string =>
	shellResponseVerdict(f).ok ? shellCacheControl(ttlSeconds) : NO_STORE_CACHE_CONTROL;

// ─── express halves (server only; Node's Buffer is used lazily, nothing imported) ─────────────────────────────────────────

type ShellReq = { method: string; path: string; originalUrl: string; headers: Record<string, string | string[] | undefined> };
type ShellRes = {
	statusCode: number;
	headersSent: boolean;
	locals: Record<string, unknown>;
	write: (...a: any[]) => boolean;
	end: (...a: any[]) => unknown;
	getHeader(name: string): unknown;
	setHeader(name: string, value: string | number | readonly string[]): unknown;
	removeHeader(name: string): void;
};

const SHELL_LOCAL = 'srShellRender';

/** True when this response is an anonymous shell render (no nonce; hash CSP and the I-6 check at response end). */
export const isShellRender = (res: { locals?: Record<string, unknown> }): boolean => res.locals?.[SHELL_LOCAL] === true;

/** Request headers that carry visitor identity, preview or per-visitor render input. */
export const SHELL_STRIPPED_REQUEST_HEADERS = ['cookie', 'authorization', 'proxy-authorization', 'cf-ipcountry', 'x-preview-token', 'x-qwik-nonce'] as const;

/**
 * I-2, structural: with SHELL_CACHE=1, a `shell` request loses every identity/preview input before ANY later middleware (the CSP
 * nonce, the cookie/host AsyncLocalStorage contexts) or Qwik loader sees it. Must be registered before those. Off: inert.
 */
export function createShellRequestMiddleware(opts: { enabled: boolean }) {
	return (req: ShellReq, res: ShellRes, next: () => void): void => {
		if (!opts.enabled) return next();
		const q = req.originalUrl.indexOf('?');
		const cookie = req.headers.cookie;
		const cls = requestRouteClass({ method: req.method, pathname: req.path, search: q < 0 ? '' : req.originalUrl.slice(q + 1), cookie: Array.isArray(cookie) ? cookie.join('; ') : cookie });
		if (cls !== 'shell') {
			res.setHeader(SHELL_DIAG_HEADER, `bypass:class:${cls}`);
			return next();
		}
		for (const h of SHELL_STRIPPED_REQUEST_HEADERS) delete req.headers[h];
		res.locals[SHELL_LOCAL] = true;
		next();
	};
}

/**
 * I-3: Qwik serialises the request URL (router location, query included) into the page state, so `?utm_source=` would change
 * the body. A shell request's query holds only ad-click tracking keys (any other key made it `dynamic`), so the render sees the
 * bare path. Register immediately before the router, after the redirect middlewares (a redirect keeps the visitor's query).
 * The browser's address bar, and so analytics, still carry the query. Inert for anything but a marked shell render.
 */
export function shellRenderUrl(req: { url: string; originalUrl: string }, res: { locals?: Record<string, unknown> }, next: () => void): void {
	if (isShellRender(res)) {
		const q = req.originalUrl.indexOf('?');
		if (q >= 0) req.originalUrl = req.originalUrl.slice(0, q);
		const u = req.url.indexOf('?');
		if (u >= 0) req.url = req.url.slice(0, u);
	}
	next();
}

/**
 * I-6 + hash CSP at response end. Only for a response createShellRequestMiddleware marked: the full body is buffered (a shell
 * render has no nonce, so the CSP cannot be sent before the body is known), the sha256 of every executable inline script is added
 * to script-src, and Cache-Control becomes the shell header only when shellResponseVerdict passes. Register after the express
 * no-store default and before the router.
 */
export function createShellCacheMiddleware(opts: { enabled: boolean; ttlSeconds: number; sha256Base64: (text: string) => string }) {
	return (_req: ShellReq, res: ShellRes, next: () => void): void => {
		if (!opts.enabled || !isShellRender(res)) return next();
		const chunks: Buffer[] = [];
		const end = res.end.bind(res);
		const toBuffer = (chunk: unknown, enc?: unknown): Buffer =>
			Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), typeof enc === 'string' && Buffer.isEncoding(enc) ? enc : 'utf8');
		res.write = (chunk: unknown, enc?: unknown, cb?: unknown): boolean => {
			chunks.push(toBuffer(chunk, typeof enc === 'function' ? undefined : enc));
			const done = typeof enc === 'function' ? enc : cb;
			if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
			return true;
		};
		res.end = (chunk?: unknown, enc?: unknown, cb?: unknown): unknown => {
			if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
			else if (typeof enc === 'function') { cb = enc; enc = undefined; }
			if (chunk !== undefined && chunk !== null) chunks.push(toBuffer(chunk, enc));
			const body = Buffer.concat(chunks.splice(0));
			const facts: ShellResponseFacts = {
				routeClass: 'shell', anonymous: true, enabled: opts.enabled, status: res.statusCode,
				contentType: res.getHeader('content-type') as string | undefined, setCookie: res.getHeader('set-cookie'), veto: res.getHeader(EDGE_VETO_HEADER),
			};
			const verdict = shellResponseVerdict(facts);
			res.removeHeader(EDGE_VETO_HEADER);
			if (!res.headersSent) {
				const csp = res.getHeader('content-security-policy');
				let hashed = false;
				if (typeof csp === 'string' && csp) {
					try {
						res.setHeader('Content-Security-Policy', withScriptHashes(csp, inlineScriptHashSources(body.toString('utf8'), opts.sha256Base64)));
						hashed = true;
					} catch { /* leave no-store below */ }
				}
				const ok = verdict.ok && hashed;
				res.setHeader('Cache-Control', ok ? shellCacheControl(opts.ttlSeconds) : NO_STORE_CACHE_CONTROL);
				res.setHeader(SHELL_DIAG_HEADER, ok ? 'cacheable' : `bypass:${verdict.ok ? 'csp' : verdict.reason}`);
				res.setHeader('Content-Length', body.length);
			}
			return end(body, cb);
		};
		next();
	};
}
