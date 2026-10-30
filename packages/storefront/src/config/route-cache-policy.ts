/**
 * The single place that decides cache headers for storefront responses (CLAUDE.md "Stock Architecture": no cache,
 * TTL or debounce for stock anywhere). Every HTML document and every loader/action data response is
 * `private, no-store`: documents render stock-derived state (home cards, shop, PDP, JSON-LD availability, search)
 * or per-request state (CSP nonce, cookies, identity, maintenance), so a shared or browser cache in front of ANY of
 * them is a stock cache or replays a stale nonce. There is deliberately no "public" page class: an unknown path
 * fails closed. Cacheable responses are only content-hashed build assets (`/build`, `/assets`, hashed root images)
 * and the stock-free sitemap/robots/IndexNow-key routes, which set their own headers.
 * `no-cache`/`must-revalidate` are kept alongside `no-store` for older intermediaries and the e2e/prod-smoke checks.
 *
 * P4b (below, default OFF): with SELLRIGHT_EDGE_HTML_CACHE=1 the express layer may promote a FINISHED, anonymous, stock-free
 * content document (EDGE_CONTENT_PATHS) to EDGE_HTML_CACHE_CONTROL after every request/response check passes. The profiles in
 * this block stay no-store; nothing here ever marks a stock-bearing, data or dynamic response public.
 */
export const NO_STORE_CACHE_CONTROL = 'private, no-store, no-cache, must-revalidate';

export type RouteClass = 'dynamic' | 'stock_bearing' | 'document';

export interface RouteCacheProfile {
	routeClass: RouteClass;
	responseCacheControl: string;
}

export const CACHE_POLICY_VERSION = '2026-10-30.1';

// `/shop-api` and `/admin-api` were the old legacy GraphQL endpoint
// prefixes — this SellRight storefront never serves or proxies those paths
// (the native API lives under `/v1`, handled directly by
// `~/sellright/client`'s SSR fetch, never through a Qwik route), so they were
// dead entries here.
const DYNAMIC_PREFIXES = [
	'/checkout',
	'/account',
	'/sign-in',
	'/api/',
	'/cache-debug',
	'/cache',
	'/track-order',
	'/newsletter-signup',
	'/subscriber',
	'/newsletter/',
	'/affiliate',
	'/verify',
	'/forgot-password',
	'/verify-email-address-change',
	'/password-reset',
];

// Documents that render stock-derived state (manifest `inStock`, PDP availability and JSON-LD, search and collection
// cards, the home page's product cards). Classified separately from other documents only for the x-route-class
// diagnostic header; the cache header is identical.
const STOCK_BEARING_PREFIXES = [
	'/',
	'/shop',
	'/products',
	'/search',
	'/collections',
];

const startsWithAny = (pathname: string, prefixes: string[]) => {
	if (pathname === '/') {
		return prefixes.includes('/');
	}
	return prefixes.some((prefix) => prefix !== '/' && pathname.startsWith(prefix));
};

export const getRouteCacheProfile = (pathname: string): RouteCacheProfile => {
	if (startsWithAny(pathname, DYNAMIC_PREFIXES)) {
		return { routeClass: 'dynamic', responseCacheControl: NO_STORE_CACHE_CONTROL };
	}
	if (startsWithAny(pathname, STOCK_BEARING_PREFIXES)) {
		return { routeClass: 'stock_bearing', responseCacheControl: NO_STORE_CACHE_CONTROL };
	}
	// Any other document (contact, legal pages, blog, unknown paths): still never stored.
	return { routeClass: 'document', responseCacheControl: NO_STORE_CACHE_CONTROL };
};

/**
 * Qwik Router rc.2 serves loader data from `{route}/q-loader-{id}.{hash}.json` and strips that suffix from
 * `url.pathname` before handlers run, so a page-path profile would wrongly classify the data response as the
 * page ('/' => shared s-maxage). Router flags set on `sharedMap`: `@isQLoader`, `@isQAction`
 * (router lib/chunks/request-path.mjs, user-response.mjs createRequestEvent).
 */
const INTERNAL_DATA_FLAGS = ['@isQLoader', '@isQAction'];

export const isInternalDataRequest = (sharedMap: { has(key: string): boolean }) =>
	INTERNAL_DATA_FLAGS.some((flag) => sharedMap.has(flag));

/** Loader/action data is cookie-dependent and stock-bearing (identity, auth, country, maintenance, catalog): never stored. */
export const getDataRequestCacheProfile = (): RouteCacheProfile => ({
	routeClass: 'dynamic',
	responseCacheControl: NO_STORE_CACHE_CONTROL,
});

/** Every response is private no-store; loader/action data requests get the data profile under any page path. */
export const resolveRouteCacheProfile = (
	pathname: string,
	sharedMap: { has(key: string): boolean },
): RouteCacheProfile =>
	isInternalDataRequest(sharedMap) ? getDataRequestCacheProfile() : getRouteCacheProfile(pathname);

// ─────────────────────────────────────────────────────────────────────────────
// P4b: public edge caching for anonymous, stock-free content documents (perf plan "HTML edge policy", N10).
//
// OFF unless the deployment sets SELLRIGHT_EDGE_HTML_CACHE=1 (one storefront process serves one pinned store, so the flag is
// per store). Even when on, every response starts as NO_STORE_CACHE_CONTROL (layout onRequest); entry.express.tsx promotes a
// finished response to EDGE_HTML_CACHE_CONTROL only when ALL of these hold, else it leaves no-store untouched:
//   request:  GET, a path in EDGE_CONTENT_PATHS (documents that carry no availability, cart, account or preview state), not a
//             loader/action data request, no query string other than ad-click tracking parameters, and every cookie on the
//             request is a known analytics/Cloudflare cookie (edgeRequestEligibility; any session, cart, preview, country or
//             unknown cookie = no-store);
//   response: status 200, text/html, no Set-Cookie, no EDGE_VETO_HEADER from a loader (identity/maintenance fallback, active
//             maintenance, an authenticated customer), the body fits EDGE_MAX_BODY_BYTES, and the CSP nonce could be replaced
//             by sha256 hashes of every executable inline script in the exact body (cspWithScriptHashes).
// Stock-bearing documents (home, shop, PDP, collections, search) are NOT in EDGE_CONTENT_PATHS: their HTML/loader state still
// embeds availability (manifest inStock, live tiles, JSON-LD offers) until the stock-free content split lands.
// ─────────────────────────────────────────────────────────────────────────────

/** Browser: always revalidate (max-age=0). Edge: 60 s, then up to 30 s stale while one request revalidates. The 90 s total
 *  bounds how long a maintenance/unpublish gate change can lag at the edge when no purge runs. No stale-if-error: an origin
 *  outage must not extend a page past its gate. */
export const EDGE_HTML_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=30';
export const EDGE_HTML_CACHE_ENV = 'SELLRIGHT_EDGE_HTML_CACHE';
export const edgeHtmlCacheEnabled = (env: Record<string, string | undefined>): boolean => env[EDGE_HTML_CACHE_ENV] === '1';

/** Loader-set response header that forbids edge caching this response (value = reason). Removed before the response leaves. */
export const EDGE_VETO_HEADER = 'x-sr-edge-veto';
export const vetoEdgeCache = (headers: { set(name: string, value: string): void }, reason: string): void => headers.set(EDGE_VETO_HEADER, reason);

export const EDGE_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Stock-free, anonymous content documents. Exact paths match with or without the trailing slash; `/blog/` also covers posts. */
export const EDGE_CONTENT_PATHS = ['/blog', '/about', '/press', '/privacy', '/returns', '/contact'] as const;

const EDGE_TRACKING_PARAM = /^(utm_[a-z_]+|gclid|gbraid|wbraid|fbclid|msclkid|ttclid|twclid|li_fat_id|mc_cid|mc_eid|_gl)$/i;
/** Cookies that never change server output: GA/Ads/Meta client ids, Cloudflare bot cookies, the GTM loader's visitor id. */
const EDGE_HARMLESS_COOKIE = /^(_ga(_[A-Za-z0-9]+)?|_gid|_gat(_[A-Za-z0-9]+)?|_gcl_[a-z]+|_fbp|_fbc|__cf_bm|cf_clearance|_cfuvid|sr_vid)$/;

export const isEdgeContentPath = (pathname: string): boolean =>
	EDGE_CONTENT_PATHS.some((p) => pathname === p || pathname === `${p}/` || (p === '/blog' && /^\/blog\/[^/]+\/?$/.test(pathname)));

export type EdgeEligibility = { ok: true } | { ok: false; reason: string };

/** Request half of the policy (pure). `search` without the leading `?` is fine; an empty string means none. */
export function edgeRequestEligibility(req: { method: string; pathname: string; search: string; cookie: string | undefined; enabled: boolean }): EdgeEligibility {
	if (!req.enabled) return { ok: false, reason: 'disabled' };
	if (req.method !== 'GET') return { ok: false, reason: 'method' };
	if (/(^|\/)q-(loader|data|action)[^/]*\.json$/i.test(req.pathname)) return { ok: false, reason: 'data' };
	if (!isEdgeContentPath(req.pathname)) return { ok: false, reason: 'route' };
	for (const key of new URLSearchParams(req.search).keys()) if (!EDGE_TRACKING_PARAM.test(key)) return { ok: false, reason: 'query' };
	for (const part of (req.cookie ?? '').split(';')) {
		const name = part.split('=')[0]!.trim();
		if (name && !EDGE_HARMLESS_COOKIE.test(name)) return { ok: false, reason: 'cookie' };
	}
	return { ok: true };
}

/** Response half of the policy (pure). */
export function edgeResponseEligibility(res: { status: number; contentType: string | undefined; setCookie: unknown; veto: unknown; bytes: number }): EdgeEligibility {
	if (res.status !== 200) return { ok: false, reason: 'status' };
	if (!/^text\/html\b/i.test(res.contentType ?? '')) return { ok: false, reason: 'content-type' };
	if (res.setCookie !== undefined && res.setCookie !== null && !(Array.isArray(res.setCookie) && res.setCookie.length === 0)) return { ok: false, reason: 'set-cookie' };
	if (res.veto !== undefined && res.veto !== null && res.veto !== '') return { ok: false, reason: `veto:${String(res.veto)}` };
	if (res.bytes > EDGE_MAX_BODY_BYTES) return { ok: false, reason: 'size' };
	return { ok: true };
}

/** Inline script types that are data, never executed (Qwik state/vnode, JSON-LD, import maps are NOT here: they are policed). */
const DATA_SCRIPT_TYPE = /^(application\/(ld\+)?json|qwik\/[a-z-]+|text\/qwik[a-z-]*)$/i;

/** The exact text of every inline script the browser would police under script-src. External (src) and data scripts excluded. */
export function executableInlineScripts(html: string): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
		const attrs = m[1] ?? '';
		if (/\ssrc\s*=/i.test(` ${attrs}`)) continue;
		const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
		const t = (type?.[1] ?? type?.[2] ?? type?.[3] ?? '').trim();
		if (t && DATA_SCRIPT_TYPE.test(t)) continue;
		out.push(m[2] ?? '');
	}
	return out;
}

/**
 * A cached body is shared, so a per-request nonce would be replayed to every visitor. Replace the script-src nonce source with
 * the sha256 of each executable inline script in THIS body (computed at response time from the exact bytes, so dynamic Qwik
 * event scripts are covered too). null when the policy carries no nonce to replace (the response then stays no-store).
 * `sha256Base64` is injected so this module stays free of node:crypto (it is also bundled for the browser).
 */
export function cspWithScriptHashes(csp: string, html: string, sha256Base64: (text: string) => string): string | null {
	if (!/'nonce-[A-Za-z0-9+/=_-]+'/.test(csp)) return null;
	const hashes = [...new Set(executableInlineScripts(html).map((s) => `'sha256-${sha256Base64(s)}'`))];
	return csp.replace(/\s*'nonce-[A-Za-z0-9+/=_-]+'/g, hashes.length ? ` ${hashes.join(' ')}` : '');
}

type EdgeReq = { method: string; path: string; originalUrl: string; headers: Record<string, string | string[] | undefined> };
type EdgeRes = {
	statusCode: number;
	headersSent: boolean;
	write: (...a: any[]) => boolean;
	end: (...a: any[]) => unknown;
	getHeader(name: string): unknown;
	setHeader(name: string, value: string | number | readonly string[]): unknown;
	removeHeader(name: string): void;
};

/**
 * The express half (server only; uses Node's Buffer lazily, imports nothing). For an eligible request the rendered body is
 * buffered, then judged once complete; see the block comment above. An ineligible request, an oversize body or any failed
 * response check passes through with the no-store default and the per-request nonce CSP untouched.
 */
export function createEdgeHtmlMiddleware(opts: { enabled: boolean; sha256Base64: (text: string) => string }) {
	return (req: EdgeReq, res: EdgeRes, next: () => void): void => {
		const q = req.originalUrl.indexOf('?');
		const cookie = req.headers.cookie;
		const eligible = edgeRequestEligibility({ method: req.method, pathname: req.path, search: q < 0 ? '' : req.originalUrl.slice(q + 1), cookie: Array.isArray(cookie) ? cookie.join('; ') : cookie, enabled: opts.enabled });
		if (!eligible.ok) {
			if (opts.enabled) res.setHeader('x-sr-edge', `bypass:${eligible.reason}`);
			return next();
		}
		// A shared body must not carry one visitor's country (#375 GTM data-co): render the candidate without it.
		delete req.headers['cf-ipcountry'];
		const chunks: Buffer[] = [];
		let bytes = 0;
		let passthrough = false;
		const write = res.write.bind(res);
		const end = res.end.bind(res);
		const toBuffer = (chunk: unknown, enc?: unknown): Buffer =>
			Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), typeof enc === 'string' ? (enc as BufferEncoding) : 'utf8');
		const release = (reason: string) => {
			passthrough = true;
			res.removeHeader(EDGE_VETO_HEADER);
			res.setHeader('x-sr-edge', `bypass:${reason}`);
			for (const c of chunks.splice(0)) write(c);
		};
		res.write = (chunk: unknown, enc?: unknown, cb?: unknown): boolean => {
			if (passthrough) return write(chunk, enc, cb);
			const buf = toBuffer(chunk, enc);
			chunks.push(buf);
			bytes += buf.length;
			const done = typeof enc === 'function' ? enc : cb;
			if (bytes > EDGE_MAX_BODY_BYTES) release('size');
			if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
			return true;
		};
		res.end = (chunk?: unknown, enc?: unknown, cb?: unknown): unknown => {
			if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
			else if (typeof enc === 'function') { cb = enc; enc = undefined; }
			if (passthrough) return end(chunk, enc, cb);
			if (chunk !== undefined && chunk !== null) { const buf = toBuffer(chunk, enc); chunks.push(buf); bytes += buf.length; }
			const body = Buffer.concat(chunks.splice(0));
			const verdict = edgeResponseEligibility({ status: res.statusCode, contentType: res.getHeader('content-type') as string | undefined, setCookie: res.getHeader('set-cookie'), veto: res.getHeader(EDGE_VETO_HEADER), bytes: body.length });
			res.removeHeader(EDGE_VETO_HEADER);
			const csp = verdict.ok ? cspWithScriptHashes(String(res.getHeader('content-security-policy') ?? ''), body.toString('utf8'), opts.sha256Base64) : null;
			if (verdict.ok && csp) {
				res.setHeader('Content-Security-Policy', csp);
				res.setHeader('Cache-Control', EDGE_HTML_CACHE_CONTROL);
				res.setHeader('x-sr-edge', 'eligible');
			} else {
				res.setHeader('x-sr-edge', `bypass:${verdict.ok ? 'csp' : verdict.reason}`);
			}
			if (!res.headersSent) res.setHeader('Content-Length', body.length);
			return end(body, cb);
		};
		next();
	};
}
