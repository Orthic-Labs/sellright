// #415: every API read a page needs starts at document parse, in parallel with the HTML, CSS and JS, depending on nothing (not Qwik,
// not qinit, not GTM, not loader JSON). An inline classic script, the first executable element of <head> (early-reads.server.ts writes
// it), starts each read with a plain fetch() and keeps the in-flight promise on `window.__srEarly`, keyed by the request (path + query).
// The Qwik consumer TAKES AND DELETES it once (single-use hand-off) when it would have started that same request, and falls back to
// its own live request when the promise is absent or rejects.
//
// #425: a document that is being PRERENDERED (the drawer's /checkout/ speculation, utils/prerender.ts) starts its reads when it is
// ACTIVATED (prerenderingchange), not seconds earlier in a hidden tab; the cookie is read then. Every other document starts them at parse,
// exactly as before (document.prerendering is false). The listener is registered first, so the reads exist before any consumer takes one.
//
// LOCKED stock rules: nothing here caches, debounces or stores a value. A promise is consumed at most once, only by the page load's own
// automatic read of the document it was started for (navigating away drops every unconsumed one), and never by a later read
// (cart open, checkout entry re-read, pre-submit, variant change, retry, bfcache): those pass no `early` flag and read live as before.
// Missing or failed stock fails closed in the consumer exactly as before (stock-read.ts, ProductContent.tsx).
//
// Inputs come from the page structure only: the path (product slug), the build's brand data (spotlight, detail products) and whether
// this render is a shell (ADR-0001: values are read in the browser). Visitor state (session marker, cart token, country) is read by
// the script in the browser, never written into the HTML, so the edge-cached shell stays identical for every visitor.
//
// DP-5/DP-6: on the /shop/ and /checkout/ shells a second inline script (early-paint.ts) consumes a CLONE of the same in-flight read to
// reveal the shop grid (stock-confirmed cards only) and to paint the checkout order summary before hydration.
import { SHOP_REVEAL_TIMEOUT_MS, checkoutPaintScriptSource, shopRevealScriptSource } from './early-paint';

/** The window property holding this document's early reads. */
export const EARLY_READS_GLOBAL = '__srEarly';

/** What the script leaves on window: the document's path + query it ran for, and the in-flight reads by request key. */
export interface EarlyReadsStore {
	h: string;
	r: Record<string, Promise<Response> | undefined>;
	/** The cart token the checkout shell's cart read was started for (the paint script paints only when the page would read that cart). */
	ct?: string;
}

/** The GET API equivalents of the shell routes' live-values server$ reads (routes/api/live/[read]/index.ts). */
export const LIVE_READS = ['home-values', 'home-spotlight', 'shop-catalog', 'shop-configurator', 'product-values', 'product-live', 'license-catalog'] as const;
export type LiveReadName = (typeof LIVE_READS)[number];

const SAFE_SLUG = /^[a-z0-9][a-z0-9\-_]*$/;

/** The request key of a GET live-values read (also its URL). */
export const liveReadUrl = (read: LiveReadName, slug?: string): string => `/api/live/${read}/${slug ? `?slug=${encodeURIComponent(slug)}` : ''}`;

/** The SellRight stock read of one product (sellright/catalog.ts fetchProductStock, same path serialisation as openapi-fetch). */
export const stockReadUrl = (slug: string): string => `/v1/shop/catalog/products/${encodeURIComponent(slug)}/stock`;

/** The live listing's first page (listing-availability.ts readLiveListing -> fetchProductList({ limit: 100, offset: 0 })). */
export const LISTING_FIRST_PAGE_URL = '/v1/shop/catalog/products?limit=100&offset=0';

export const SHOP_CONFIG_URL = '/v1/shop/config';

/** The checkout shell's summary read (routes/api/live/checkout-summary): a FIXED url (no token or country in it: the server reads the
 *  visitor's `sr_cart` and country cookies from the credentialed request), so it can be preloaded from the cached shell's Link header. */
export const CHECKOUT_SUMMARY_URL = '/api/live/checkout-summary/';

// ---------------------------------------------------------------------------------------------------- pure: the page's plan

/** The build's and the render's facts the plan depends on (early-reads.server.ts fills it; tests pass their own). */
export interface EarlyReadsContext {
	/** routes.json productPath: `products` (/products/:slug/) or `shop` (/shop/:slug/). */
	productPrefix: 'products' | 'shop';
	/** This render is an ADR-0001 shell: its loaders carry no values, the page reads them in the browser. */
	shell: boolean;
	/** Brand views present (hasView): the PDP, shop and home mounts read through the configurator. */
	brandHome: boolean;
	brandShop: boolean;
	brandProduct: boolean;
	/** routes.json home.spotlight slug (brand home only), or null. */
	homeSpotlightSlug: string | null;
	/** routes.json shop.detailProducts slugs (brand shop's configurator products). */
	detailSlugs: readonly string[];
	/** platform setting shop.stockOnLoad = live: the shop makes one live listing read on load. */
	shopLiveListing: boolean;
	/** License commerce flow (RightSites store.* hosts): its own routes; the only page read is the home's license catalog. */
	license?: boolean;
	/** theme.domain and the asset variant revision (the painter's image URLs must equal OptimizedImage's). */
	assetDomain?: string;
	assetRev?: number;
}

export type EarlyPageType = 'home' | 'shop' | 'product' | 'checkout' | 'other';

/** The reads one document starts. `get`: [url, low priority]. `checkout`: the cart read takes the checkout entry's query. */
export interface EarlyReadsPlan {
	page: EarlyPageType;
	get: [string, 0 | 1][];
	checkout: boolean;
	/** A shell render only: the paint script this page gets after the reads script (early-paint.ts). Absent: none. */
	paint?: { kind: 'shop'; k: string; t: number } | { kind: 'checkout'; k: string; dm: string; rev: number };
}

const strip = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

/** The page type and, for a product page, its slug, from the path alone. */
export function earlyPageOf(pathname: string, productPrefix: 'products' | 'shop'): { page: EarlyPageType; slug?: string } {
	const p = strip(pathname || '/');
	if (p === '' || p === '/') return { page: 'home' };
	if (p === '/shop') return { page: 'shop' };
	if (p === '/checkout') return { page: 'checkout' };
	const m = new RegExp(`^/${productPrefix}/([^/]+)$`).exec(p);
	if (m) {
		let slug = '';
		try { slug = decodeURIComponent(m[1]!); } catch { /* malformed: not a product page */ }
		if (SAFE_SLUG.test(slug)) return { page: 'product', slug };
	}
	return { page: 'other' };
}

/** Every GET read a page of this type needs on load, in the order its consumers start them (stock first, values low). Pure. */
export function buildEarlyReadsPlan(pathname: string, ctx: EarlyReadsContext): EarlyReadsPlan {
	const { page, slug } = earlyPageOf(pathname, ctx.productPrefix);
	if (ctx.license) {
		// #425: the license flow has none of the store reads (no stock, cart, session or core /api/live routes); its home's prices only.
		return { page, get: page === 'home' && ctx.shell ? [[liveReadUrl('license-catalog'), 1]] : [], checkout: false };
	}
	const get: [string, 0 | 1][] = [];
	const stock = (s: string) => { if (SAFE_SLUG.test(s)) get.push([stockReadUrl(s), 0]); };
	const live = (read: LiveReadName, s?: string) => { if (ctx.shell) get.push([liveReadUrl(read, s), 1]); };
	if (page === 'home') {
		if (ctx.brandHome && ctx.homeSpotlightSlug) {
			stock(ctx.homeSpotlightSlug);
			live('home-spotlight');
		}
		live('home-values');
	} else if (page === 'shop') {
		if (ctx.brandShop) {
			for (const s of ctx.detailSlugs) stock(s);
			live('shop-configurator');
			get.push([SHOP_CONFIG_URL, 1]);
		} else {
			live('shop-catalog');
		}
		if (ctx.shopLiveListing) get.push([LISTING_FIRST_PAGE_URL, 0]);
	} else if (page === 'product' && slug) {
		stock(slug);
		live(ctx.brandProduct ? 'product-live' : 'product-values', slug);
		get.push([SHOP_CONFIG_URL, 1]);
	} else if (page === 'checkout') {
		// A shell render paints its order summary from the fixed-URL summary read (the server reads the visitor's cart cookie): first,
		// it is the visible path. A dynamic or excluded render is today's server-rendered summary and reads nothing extra.
		if (ctx.shell) get.push([CHECKOUT_SUMMARY_URL, 0]);
		// The checkout reads the shop config on entry with or without a cart (payment methods, the empty-cart state included).
		get.push([SHOP_CONFIG_URL, 1]);
	}
	// DP-5/DP-6: only a shell render paints from its early reads (a dynamic or excluded render is today's server-rendered page).
	let paint: EarlyReadsPlan['paint'];
	if (ctx.shell && page === 'shop' && !ctx.brandShop) paint = { kind: 'shop', k: liveReadUrl('shop-catalog'), t: SHOP_REVEAL_TIMEOUT_MS };
	else if (ctx.shell && page === 'checkout') paint = { kind: 'checkout', k: CHECKOUT_SUMMARY_URL, dm: ctx.assetDomain ?? '', rev: ctx.assetRev ?? 3 };
	return { page, get, checkout: page === 'checkout', ...(paint ? { paint } : {}) };
}

// ---------------------------------------------------------------------------------------------------- pure: the Link header

/** At most this many preload entries on a shell response (each is a request the browser starts before the HTML arrives). */
export const EARLY_LINK_MAX = 6;

/** One `Link` preload entry. `as=fetch; crossorigin=use-credentials` is what a `fetch(url, { credentials: 'include' })` matches
 *  (the early script's reads, which are exactly these URLs). */
export const earlyLinkEntry = (url: string): string => `<${url}>; rel=preload; as=fetch; crossorigin=use-credentials`;

/** A same-origin path + query made of URL-safe characters only (nothing that could break out of `<...>` or split the header). */
const LINK_SAFE_URL = /^\/[A-Za-z0-9\-._~/?=&%]*$/;

/**
 * The `Link` response header of an ADR-0001 SHELL render of `/shop/` or `/checkout/`, derived from the same plan the early script runs
 * (one source of truth: the header lists exactly the reads the script starts, in plan order, capped). Cloudflare Early Hints stores this
 * header with the cached shell and sends it as a 103 when a request arrives, so the browser starts the reads while the HTML is in flight.
 *
 * It is cached with the shell, so it is identical for every visitor: only the plan's fixed URLs (no token, cookie value, country or
 * query-derived slug), computed from the path and the build's context alone. null (no header at all) for any render that is not a shell
 * (SHELL_CACHE off, SHELL_CACHE_EXCLUDE, dynamic), for every other page and for the license flow. Pure.
 */
export function earlyReadsLinkHeader(pathname: string, ctx: EarlyReadsContext): string | null {
	if (!ctx.shell || ctx.license) return null;
	const plan = buildEarlyReadsPlan(pathname, ctx);
	if (plan.page !== 'shop' && plan.page !== 'checkout') return null;
	const entries = plan.get.map(([url]) => url).filter((url) => LINK_SAFE_URL.test(url)).slice(0, EARLY_LINK_MAX).map(earlyLinkEntry);
	return entries.length ? entries.join(', ') : null;
}

// ---------------------------------------------------------------------------------------------------- pure: the script

/**
 * The script body (ES5, no dependency): `P` is the plan. Every fetch is credentialed like the SellRight client (`include`) and
 * `no-store`. Visitor reads: the session (only with a session marker cookie, session-customer.ts hasSessionMarker) and the cart
 * bootstrap read (only with an `sr_cart` token and no legacy cart transport or pending intent migration, CartService.bootstrapOnce;
 * the query is CartService.liveReadQuery's: the stored country preference, or on checkout the entry read's checkout intent, the
 * `countryCode` cookie and the shipping quote). A request key that does not match what the consumer would send is simply not
 * taken (the consumer reads live).
 */
/** #425 edge reads: how long the page waits for a read the edge Worker started before reading it itself. */
export const EDGE_WAIT_MS = 3000;
/** The <meta name> the edge Worker adds to name the reads it started (space-separated request keys). */
export const EDGE_READS_META = 'sr-edge';

const SCRIPT_BODY =
	"(function(w,d,P){try{if(!w.fetch)return;var c=d.cookie||'',S={h:location.pathname+location.search,r:{}};w." + EARLY_READS_GLOBAL + "=S;" +
	"var run=function(){c=d.cookie||'';" +
	"var F=function(u,l){try{var p=w.fetch(u,{credentials:'include',cache:'no-store',priority:l?'low':'auto'});p['catch'](function(){});S.r[u]=p;return p;}catch(e){}};" +
	// #425 edge reads: a read the edge Worker started at request arrival (named by its <meta name=sr-edge>) is not fetched here; its
	// promise resolves from the JSON block the Worker appends (<script type=application/json data-sr-edge=url data-ok=1|0>), or
	// falls back to the normal fetch on a failed edge read or after EDGE_WAIT_MS. Same promise, same consumers.
	"var E=d.querySelector('meta[name=sr-edge]'),EK=E?' '+E.getAttribute('content')+' ':'';S.e={};" +
	"var f=function(u,l){if(EK.indexOf(' '+u+' ')<0)return F(u,l);var res,dn=0,p=new Promise(function(r){res=r;});S.r[u]=p;" +
	"var fb=function(){var q=F(u,l);S.r[u]=p;return q||w.fetch(u,{credentials:'include',cache:'no-store'});};" +
	"S.e[u]=function(t,ok){if(dn)return;dn=1;res(ok?new Response(t,{status:200,headers:{'content-type':'application/json'}}):fb());};" +
	"setTimeout(function(){if(!dn){dn=1;res(fb());}}," + EDGE_WAIT_MS + ");return p;};" +
	"var X=function(){var x=d.querySelectorAll('script[data-sr-edge]');for(var i=0;i<x.length;i++){var k=x[i].getAttribute('data-sr-edge'),h=S.e[k];if(h){S.e[k]=null;h(x[i].textContent,x[i].getAttribute('data-ok')==='1');}}};" +
	"if(EK){try{var mo=new MutationObserver(X);mo.observe(d.documentElement,{childList:true,subtree:true});d.addEventListener('DOMContentLoaded',function(){X();mo.disconnect();});}catch(e){}}" +
	"try{w.navigation.addEventListener('navigate',function(e){var u=new URL(e.destination.url);if(u.pathname+u.search!==S.h)S.r={};});}catch(e){}" +
	"for(var i=0;i<P.g.length;i++)f(P.g[i][0],P.g[i][1]);" +
	"if(/(?:^|;\\s*)(?:sr_cust_csrf|authToken|sr_legacy_cart)=[^;\\s]/.test(c))f('/api/session/',1);" +
	"var m=c.match(/(?:^|; )sr_cart=([^;]*)/),t=null;try{t=m&&m[1]?decodeURIComponent(m[1]):null;}catch(e){}" +
	"if(t&&!/(?:^|;\\s*)(?:authToken=[^;]+|sr_legacy_cart=1)(?:;|$)/.test(c)){var L=w.localStorage,ok=1,co='US';" +
	"try{if(L.getItem('vendure_local_cart')!==null)ok=0;var it=JSON.parse(L.getItem('sr_cart_intent')||'null');" +
	"if(it&&it.token===t&&it.version!==2&&(typeof it.couponCode==='string'||it.couponCode===null))ok=0;" +
	"var cp=JSON.parse(L.getItem('sr_country_pref')||'null');if(cp&&/^[A-Z]{2}$/.test(cp.countryCode))co=cp.countryCode;}catch(e){ok=0;}" +
	"if(ok){var b='/v1/shop/cart/'+encodeURIComponent(t);if(P.k){var cc=c.match(/(?:^|;\\s*)countryCode=([^;]*)/);" +
	"S.ct=t;f(b+'?pricingIntent=checkout&shipCountry='+encodeURIComponent(cc&&cc[1]||co)+'&includeShippingMethods=1');}" +
	"else f(b+'?shipCountry='+encodeURIComponent(co));}}" +
	"};if(d.prerendering)d.addEventListener('prerenderingchange',run,{once:true});else run();" +
	"}catch(e){}})(window,document,";

/** JSON safe inside an HTML <script> element (no `</script>`, no `<!--`, no U+2028/2029). */
const scriptJson = (value: unknown): string =>
	JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** The script text for a plan (what the CSP hash covers). Pure. */
export function earlyReadsScriptSource(plan: EarlyReadsPlan): string {
	return `${SCRIPT_BODY}${scriptJson({ g: plan.get, k: plan.checkout ? 1 : 0 })});`;
}

const escapeAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The paint script text for a plan (shop reveal / checkout summary, early-paint.ts), or null when the page has none. Pure. */
export function earlyPaintScriptSource(plan: EarlyReadsPlan): string | null {
	if (!plan.paint) return null;
	return plan.paint.kind === 'shop' ? shopRevealScriptSource({ k: plan.paint.k, t: plan.paint.t }) : checkoutPaintScriptSource({ k: plan.paint.k, dm: plan.paint.dm, rev: plan.paint.rev });
}

/** The <script> element(s): classic inline scripts, nonce'd when the render has a nonce (a shell render is allowed by its sha256).
 *  The reads script first, then (shell /shop/ and /checkout/ only) the paint script. */
export function earlyReadsScriptTag(plan: EarlyReadsPlan, nonce?: string): string {
	const open = `<script${nonce ? ` nonce="${escapeAttr(nonce)}"` : ''}>`;
	const paint = earlyPaintScriptSource(plan);
	return `${open}${earlyReadsScriptSource(plan)}</script>${paint ? `${open}${paint}</script>` : ''}`;
}

/**
 * The document with the script inserted as the first executable element of <head>: right after `<head ...>` and, when it comes
 * first, the `<meta charset>` (the charset declaration stays in the first bytes). Before every stylesheet (an inline script after a
 * pending stylesheet waits for it) and before Qwik's loader and modulepreloads. A chunk without `<head` returns null.
 */
export function insertEarlyReads(html: string, tag: string): string | null {
	const open = /<head\b[^>]*>/i.exec(html);
	if (!open) return null;
	let at = open.index + open[0].length;
	const charset = /^<meta\b[^>]*\bcharset\s*=[^>]*>/i.exec(html.slice(at));
	if (charset) at += charset[0].length;
	return html.slice(0, at) + tag + html.slice(at);
}

// ---------------------------------------------------------------------------------------------------- server: the writer

/** The writer Qwik's renderToStream writes to (StreamWriter in @qwik.dev/core). */
export interface EarlyReadsStreamWriter {
	write(chunk: string): void | Promise<void>;
}

/**
 * Wraps the response writer: the first chunk that opens <head> gets the early-reads script inserted (insertEarlyReads); every chunk
 * passes straight through, nothing is buffered. `url` is the request URL (`opts.serverData.url`); only its path is used. A render
 * whose head never opens (or a URL that does not parse) passes through unchanged.
 */
export function earlyReadsWriter<W extends EarlyReadsStreamWriter>(stream: W, opts: { url?: string; nonce?: string; context: EarlyReadsContext }): W {
	let pathname: string | null;
	try {
		pathname = opts.url ? new URL(opts.url, 'http://localhost').pathname : null;
	} catch {
		pathname = null;
	}
	let done = pathname === null;
	const tag = done ? '' : earlyReadsScriptTag(buildEarlyReadsPlan(pathname!, opts.context), opts.nonce);
	const wrapped = Object.create(stream) as W;
	wrapped.write = (chunk: string) => {
		if (done) return stream.write(chunk);
		const out = insertEarlyReads(chunk, tag);
		if (out !== null) {
			done = true;
			return stream.write(out);
		}
		if (/<body\b/i.test(chunk)) done = true;
		return stream.write(chunk);
	};
	return wrapped;
}

// ---------------------------------------------------------------------------------------------------- browser: the hand-off

type EarlyWindow = { [EARLY_READS_GLOBAL]?: EarlyReadsStore };

const earlyStore = (): EarlyReadsStore | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as EarlyWindow)[EARLY_READS_GLOBAL]);

/**
 * Takes this document's early read of `key` (path + query) and deletes it: a second take returns undefined. On a document that is no
 * longer the one the script ran for (a client-side navigation), every unconsumed read is dropped and nothing is returned.
 */
export function takeEarlyRead(key: string): Promise<Response> | undefined {
	const store = earlyStore();
	if (!store || !store.r) return undefined;
	if (store.h !== window.location.pathname + window.location.search) {
		store.r = {};
		return undefined;
	}
	const read = store.r[key];
	delete store.r[key];
	return read;
}

/** The request key of a fetch input: same-origin path + query, or null (another origin, or not a GET). */
export function earlyKeyOf(input: RequestInfo | URL, init?: RequestInit): string | null {
	if (typeof window === 'undefined') return null;
	const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
	if (method !== 'GET') return null;
	const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	let url: URL;
	try { url = new URL(raw, window.location.href); } catch { return null; }
	return url.origin === window.location.origin ? url.pathname + url.search : null;
}

const abortError = () => (typeof DOMException === 'function' ? new DOMException('The operation was aborted.', 'AbortError') : new Error('AbortError'));

/**
 * A fetch that takes this document's early read of the same request (once) and otherwise, or when that read failed, sends its own
 * live request. The request's signal still applies (a superseded or timed-out read rejects). For the one automatic read of a page
 * load only: pass it as `fetch` to a SellRight client call, or as `fetchImpl`.
 */
export const earlyFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const key = earlyKeyOf(input, init);
	const early = key === null ? undefined : takeEarlyRead(key);
	if (!early) return fetch(input, init);
	const signal = init?.signal ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
	const read = early.then((res) => res, () => fetch(input, init));
	if (!signal) return read;
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise<Response>((resolve, reject) => {
		const onAbort = () => reject(abortError());
		signal.addEventListener('abort', onAbort, { once: true });
		read.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
	});
};

/**
 * The value of a live-values read: this document's early GET of `key` when it answered 200 with JSON, else `fallback()` (the
 * route's own server$ read, live). Never a reused result: the early read is taken once.
 */
export async function earlyJsonOr<T>(key: string, fallback: () => Promise<T>): Promise<T> {
	const early = takeEarlyRead(key);
	if (early) {
		try {
			const res = await early;
			if (res.ok) return (await res.json()) as T;
		} catch {
			// failed early read: the consumer's own live read below
		}
	}
	return fallback();
}
