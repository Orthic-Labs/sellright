// #415: the early-reads script (generator per page type, what it starts in the browser), the single-use hand-off, the consumers'
// fallback, fail-closed stock and the CSP coverage of the inline script.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildEarlyReadsPlan,
	earlyFetch,
	earlyLinkEntry,
	earlyReadsLinkHeader,
	earlyJsonOr,
	earlyReadsScriptSource,
	earlyReadsScriptTag,
	insertEarlyReads,
	earlyReadsWriter,
	liveReadUrl,
	stockReadUrl,
	takeEarlyRead,
	CHECKOUT_SUMMARY_URL,
	EARLY_LINK_MAX,
	EARLY_READS_GLOBAL,
	LISTING_FIRST_PAGE_URL,
	SHOP_CONFIG_URL,
	type EarlyReadsContext,
} from './early-reads';

import { executableInlineScripts, inlineScriptHashSources, withScriptHashes, buildCsp } from '~/utils/csp';
import { initialStockCtl, readStock } from './controllers/stock-read';

const damned: EarlyReadsContext = {
	productPrefix: 'products', shell: true, brandHome: true, brandShop: false, brandProduct: false,
	homeSpotlightSlug: 'pocket-fixed-blade', detailSlugs: [], shopLiveListing: false,
};
const rotten: EarlyReadsContext = {
	productPrefix: 'shop', shell: true, brandHome: true, brandShop: true, brandProduct: true,
	homeSpotlightSlug: null, detailSlugs: ['shortsleeveshirt', 'longsleeveshirt'], shopLiveListing: true,
};
const urls = (pathname: string, ctx: EarlyReadsContext) => buildEarlyReadsPlan(pathname, ctx).get.map(([u]) => u);

type W = Record<string, unknown>;
const store = () => (window as unknown as W)[EARLY_READS_GLOBAL] as { h: string; r: Record<string, Promise<Response>> } | undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const clearCookies = () => { for (const c of document.cookie.split(';')) { const n = c.split('=')[0]!.trim(); if (n) document.cookie = `${n}=; Max-Age=0; Path=/`; } };

beforeEach(() => {
	delete (window as unknown as W)[EARLY_READS_GLOBAL];
	clearCookies();
	localStorage.clear();
	window.history.replaceState(null, '', '/');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('plan per page type', () => {
	it('home: the spotlight stock first, then its values and the home values (shell only)', () => {
		expect(buildEarlyReadsPlan('/', damned).get).toEqual([[stockReadUrl('pocket-fixed-blade'), 0], [liveReadUrl('home-spotlight'), 1], [liveReadUrl('home-values'), 1]]);
		expect(urls('/', { ...damned, shell: false })).toEqual([stockReadUrl('pocket-fixed-blade')]);
		expect(urls('/', rotten)).toEqual([liveReadUrl('home-values')]);
	});
	it('shop: base reads its manifest values; a brand shop reads each detail product, its values, the config and the live listing', () => {
		expect(urls('/shop/', damned)).toEqual([liveReadUrl('shop-catalog')]);
		expect(urls('/shop/', rotten)).toEqual([stockReadUrl('shortsleeveshirt'), stockReadUrl('longsleeveshirt'), liveReadUrl('shop-configurator'), SHOP_CONFIG_URL, LISTING_FIRST_PAGE_URL]);
	});
	it('PDP: the slug from the path, under the brand product prefix', () => {
		expect(urls('/products/oni/', damned)).toEqual([stockReadUrl('oni'), liveReadUrl('product-values', 'oni'), SHOP_CONFIG_URL]);
		expect(urls('/shop/shortsleeveshirt/', rotten)).toEqual([stockReadUrl('shortsleeveshirt'), liveReadUrl('product-live', 'shortsleeveshirt'), SHOP_CONFIG_URL]);
		expect(urls('/shop/oni/', damned)).toEqual([]); // not Damned's product path
		expect(urls('/products/Bad%20Slug/', damned)).toEqual([]);
		expect(urls('/products/oni/', { ...damned, shell: false })).toEqual([stockReadUrl('oni'), SHOP_CONFIG_URL]);
	});
	it('checkout reads the config; blog nothing (visitor reads are decided in the browser); checkout flags the entry query', () => {
		expect(buildEarlyReadsPlan('/checkout/', damned)).toEqual({ page: 'checkout', get: [[CHECKOUT_SUMMARY_URL, 0], [SHOP_CONFIG_URL, 1]], checkout: true, paint: { kind: 'checkout', k: CHECKOUT_SUMMARY_URL, dm: '', rev: 3 } });
		expect(buildEarlyReadsPlan('/checkout/', { ...damned, shell: false })).toEqual({ page: 'checkout', get: [[SHOP_CONFIG_URL, 1]], checkout: true }); // rollback: no paint
		expect(buildEarlyReadsPlan('/blog/', damned)).toEqual({ page: 'other', get: [], checkout: false });
	});
	it('the script carries no visitor value and is safe inside <script>', () => {
		const src = earlyReadsScriptSource({ page: 'other', get: [['/x</script><b>', 0]], checkout: false });
		expect(src).not.toContain('</script>');
		expect(src).toContain('\\u003c/script\\u003e');
	});
});

/** Runs the generated script in this jsdom window with `fetch` stubbed. */
function runScript(pathname: string, ctx: EarlyReadsContext, fetchImpl: (u: string) => Promise<Response> = () => Promise.resolve(json({}))) {
	window.history.replaceState(null, '', pathname);
	const fetchMock = vi.fn((u: string, _init?: RequestInit) => fetchImpl(u));
	vi.stubGlobal('fetch', fetchMock);
	new Function(earlyReadsScriptSource(buildEarlyReadsPlan(new URL(pathname, 'http://x').pathname, ctx)))();
	return fetchMock;
}
const started = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map((c) => c[0]);

describe('the script in the browser', () => {
	it('starts every planned read with credentials and no-store, keyed by request, for this document', () => {
		const m = runScript('/products/oni/?utm_source=x', damned);
		expect(started(m)).toEqual([stockReadUrl('oni'), liveReadUrl('product-values', 'oni'), SHOP_CONFIG_URL]);
		expect(m.mock.calls[0]![1]).toMatchObject({ credentials: 'include', cache: 'no-store' });
		expect(store()!.h).toBe('/products/oni/?utm_source=x');
		expect(Object.keys(store()!.r)).toEqual(started(m));
	});
	it('#425: a document being prerendered starts no read (its consumers read live after activation)', () => {
		document.cookie = 'sr_cart=tok%2F1; Path=/';
		Object.defineProperty(document, 'prerendering', { value: true, configurable: true });
		try {
			const m = runScript('/checkout/', damned);
			expect(started(m)).toEqual([]);
			expect(store()!.r).toEqual({});
		} finally {
			delete (document as unknown as { prerendering?: boolean }).prerendering;
		}
		expect(started(runScript('/checkout/', damned)).length).toBeGreaterThan(0);
	});
	it('session only with a session marker cookie', () => {
		expect(started(runScript('/blog/', damned))).toEqual([]);
		document.cookie = 'sr_cust_csrf=abc; Path=/';
		expect(started(runScript('/blog/', damned))).toEqual(['/api/session/']);
	});
	it('cart boot read with the stored country preference; checkout uses the entry query', () => {
		document.cookie = 'sr_cart=tok%2F1; Path=/';
		localStorage.setItem('sr_country_pref', JSON.stringify({ countryCode: 'DE', source: 'explicit' }));
		expect(started(runScript('/blog/', damned))).toEqual(['/v1/shop/cart/tok%2F1?shipCountry=DE']);
		document.cookie = 'countryCode=CA; Path=/';
		expect(started(runScript('/checkout/', damned))).toEqual([CHECKOUT_SUMMARY_URL, SHOP_CONFIG_URL, '/v1/shop/cart/tok%2F1?pricingIntent=checkout&shipCountry=CA&includeShippingMethods=1']);
	});
	it('no cart read while a legacy cart or a pending intent migration means writes come first', () => {
		document.cookie = 'sr_cart=t1; Path=/';
		localStorage.setItem('vendure_local_cart', '{}');
		expect(started(runScript('/blog/', damned))).toEqual([]);
		localStorage.clear();
		localStorage.setItem('sr_cart_intent', JSON.stringify({ token: 't1', couponCode: 'X' }));
		expect(started(runScript('/blog/', damned))).toEqual([]);
		localStorage.clear();
		expect(started(runScript('/blog/', damned))).toEqual(['/v1/shop/cart/t1?shipCountry=US']);
	});
	it('a failing fetch() never throws out of the script or leaves an unhandled rejection', async () => {
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		runScript('/products/oni/', damned, () => Promise.reject(new TypeError('offline')));
		await new Promise((r) => setTimeout(r, 0));
		process.off('unhandledRejection', unhandled);
		expect(unhandled).not.toHaveBeenCalled();
	});
});

describe('single-use hand-off', () => {
	it('a second take returns undefined', () => {
		runScript('/products/oni/', damned);
		expect(takeEarlyRead(stockReadUrl('oni'))).toBeInstanceOf(Promise);
		expect(takeEarlyRead(stockReadUrl('oni'))).toBeUndefined();
	});
	it('another document (client-side navigation) takes nothing and drops every unconsumed read', () => {
		runScript('/products/oni/', damned);
		window.history.pushState(null, '', '/products/djinn/');
		expect(takeEarlyRead(SHOP_CONFIG_URL)).toBeUndefined();
		window.history.pushState(null, '', '/products/oni/');
		expect(takeEarlyRead(stockReadUrl('oni'))).toBeUndefined();
	});
	it('earlyFetch: takes the early response once, then reads live', async () => {
		const early = json({ sku: 'a' });
		runScript('/products/oni/', damned, (u) => Promise.resolve(u === stockReadUrl('oni') ? early : json({})));
		const live = vi.fn(() => Promise.resolve(json({ live: true })));
		vi.stubGlobal('fetch', live);
		expect(await earlyFetch(new Request(new URL(stockReadUrl('oni'), location.href)))).toBe(early);
		expect(live).not.toHaveBeenCalled();
		await earlyFetch(new Request(new URL(stockReadUrl('oni'), location.href)));
		expect(live).toHaveBeenCalledTimes(1);
	});
	it('earlyFetch: falls back to its own live request when absent or when the early read failed', async () => {
		runScript('/products/oni/', damned, () => Promise.reject(new TypeError('offline')));
		const live = vi.fn(() => Promise.resolve(json({ live: true })));
		vi.stubGlobal('fetch', live);
		expect(await (await earlyFetch(stockReadUrl('oni'))).json()).toEqual({ live: true }); // early rejected
		expect(await (await earlyFetch('/v1/shop/catalog/products/other/stock')).json()).toEqual({ live: true }); // absent
		expect(live).toHaveBeenCalledTimes(2);
	});
	it('earlyFetch honours the caller signal (a superseded read rejects)', async () => {
		runScript('/products/oni/', damned, () => new Promise(() => {}));
		const ac = new AbortController();
		const p = earlyFetch(stockReadUrl('oni'), { signal: ac.signal });
		ac.abort();
		await expect(p).rejects.toMatchObject({ name: 'AbortError' });
	});
	it('earlyJsonOr: the early 200 JSON, else the server$ fallback', async () => {
		runScript('/products/oni/', damned, (u) => Promise.resolve(u.startsWith('/api/live/') ? json({ variants: [] }) : json({})));
		const fallback = vi.fn(async () => ({ fallback: true }));
		expect(await earlyJsonOr(liveReadUrl('product-values', 'oni'), fallback)).toEqual({ variants: [] });
		expect(fallback).not.toHaveBeenCalled();
		expect(await earlyJsonOr(liveReadUrl('product-values', 'oni'), fallback)).toEqual({ fallback: true }); // second take: live
		runScript('/', damned, () => Promise.resolve(json({ error: 'x' }, 503)));
		expect(await earlyJsonOr(liveReadUrl('home-values'), fallback)).toEqual({ fallback: true }); // failed early read
	});
});

describe('LOCKED stock: fail closed', () => {
	const fetcher = (slug: string, o: { signal?: AbortSignal }) => earlyFetch(stockReadUrl(slug), { signal: o.signal }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
	it('an early read that rejects, with a live read that fails too, leaves the product in error (never purchasable)', async () => {
		runScript('/products/oni/', damned, () => Promise.reject(new TypeError('offline')));
		vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
		const ctl = initialStockCtl();
		await readStock(ctl, ['oni'], fetcher);
		expect(ctl.stock.oni).toEqual({ status: 'error', bySku: {} });
	});
	it('an early 5xx is the live answer of that read: error, fail closed', async () => {
		runScript('/products/oni/', damned, () => Promise.resolve(json({}, 503)));
		const ctl = initialStockCtl();
		await readStock(ctl, ['oni'], fetcher);
		expect(ctl.stock.oni!.status).toBe('error');
	});
});

describe('CSP and placement', () => {
	const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('base64');
	const html = '<!DOCTYPE html><html lang="en"><head q:head><meta charSet="utf-8"><meta name="viewport" content="x"><link rel="stylesheet" href="/build/s.css"><link rel="modulepreload" href="/build/core.js"><script async type="module" src="/build/ql.js"></script></head><body></body></html>';
	it('first executable element of <head>, after the charset, before the stylesheet and every Qwik tag', () => {
		const plan = buildEarlyReadsPlan('/products/oni/', damned);
		const out = insertEarlyReads(html, earlyReadsScriptTag(plan))!;
		expect(out.indexOf('<meta charSet')).toBeLessThan(out.indexOf('<script>'));
		expect(out.indexOf('<script>')).toBeLessThan(out.indexOf('rel="stylesheet"'));
		expect(out.indexOf('<script>')).toBeLessThan(out.indexOf('modulepreload'));
		expect(insertEarlyReads('<body>', 'x')).toBeNull();
	});
	it('a shell render (no nonce) is allowed by the sha256 the express layer adds for it', () => {
		const plan = buildEarlyReadsPlan('/products/oni/', damned);
		const out = insertEarlyReads(html, earlyReadsScriptTag(plan))!;
		expect(executableInlineScripts(out)).toContain(earlyReadsScriptSource(plan));
		const csp = withScriptHashes(buildCsp({ nonce: undefined }), inlineScriptHashSources(out, sha));
		expect(csp).toContain(`'sha256-${sha(earlyReadsScriptSource(plan))}'`);
	});
	it('a nonce render carries the request nonce', () => {
		expect(earlyReadsScriptTag(buildEarlyReadsPlan('/', damned), 'n0"nce')).toMatch(/^<script nonce="n0&quot;nce">/);
	});
	it('the writer inserts once, into the chunk that opens <head>, and passes everything else through', () => {
		const chunks: string[] = [];
		const w = earlyReadsWriter({ write: (c: string) => { chunks.push(c); } }, { url: 'https://x.test/products/oni/?utm_source=x', nonce: 'abc', context: damned });
		w.write(html);
		w.write('<div><head></head></div>');
		expect(chunks[0]).toContain(`<script nonce="abc">${earlyReadsScriptSource(buildEarlyReadsPlan('/products/oni/', damned))}</script>`);
		expect(chunks[1]).toBe('<div><head></head></div>');
	});
});

describe('#425 license flow (RightSites store.* hosts)', () => {
	const license: EarlyReadsContext = { ...damned, license: true };
	it('the shell home reads only the license catalog; no store reads (stock, cart, session, core /api/live)', () => {
		const plan = buildEarlyReadsPlan('/', { ...license, shell: true });
		expect(plan.get).toEqual([['/api/live/license-catalog/', 1]]);
		expect(plan.checkout).toBe(false);
	});
	it('a dynamic render and every other license page start nothing', () => {
		expect(buildEarlyReadsPlan('/', { ...license, shell: false }).get).toEqual([]);
		for (const p of ['/pricing/', '/checkout/', '/account/', '/products/x/']) expect(buildEarlyReadsPlan(p, { ...license, shell: true }).get, p).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------------- Link header (Early Hints)

describe('ADR-0001 Link preload header of the /shop/ and /checkout/ shells', () => {
	const entry = earlyLinkEntry;
	const parse = (header: string) => header.split(', ').map((e) => {
		const m = /^<([^>]+)>; rel=preload; as=fetch; crossorigin=use-credentials$/.exec(e);
		expect(m, e).not.toBeNull();
		return m![1]!;
	});
	it('the entry is exactly the preload a credentialed fetch() matches', () => {
		expect(entry('/x/')).toBe('</x/>; rel=preload; as=fetch; crossorigin=use-credentials');
	});
	it('non-brand shop (Damned): the live catalog; checkout: the summary, then the config', () => {
		expect(earlyReadsLinkHeader('/shop/', damned)).toBe('</api/live/shop-catalog/>; rel=preload; as=fetch; crossorigin=use-credentials');
		expect(earlyReadsLinkHeader('/checkout/', damned)).toBe(
			'</api/live/checkout-summary/>; rel=preload; as=fetch; crossorigin=use-credentials, </v1/shop/config>; rel=preload; as=fetch; crossorigin=use-credentials',
		);
	});
	it('brand shop (Rotten): each detail product stock, the configurator, the config and the live listing', () => {
		expect(earlyReadsLinkHeader('/shop/', rotten)).toBe([
			entry(stockReadUrl('shortsleeveshirt')), entry(stockReadUrl('longsleeveshirt')), entry(liveReadUrl('shop-configurator')), entry(SHOP_CONFIG_URL), entry(LISTING_FIRST_PAGE_URL),
		].join(', '));
		expect(earlyReadsLinkHeader('/checkout/', rotten)).toBe([entry(CHECKOUT_SUMMARY_URL), entry(SHOP_CONFIG_URL)].join(', '));
	});
	it('derived from the plan (single source): exactly the plan\'s reads, in order', () => {
		for (const [path, ctx] of [['/shop/', damned], ['/shop/', rotten], ['/checkout/', damned], ['/checkout/', rotten]] as const) {
			expect(parse(earlyReadsLinkHeader(path, ctx)!), `${path}`).toEqual(urls(path, ctx));
		}
	});
	it('capped, plan order kept (the first entries are the stock reads)', () => {
		const many = { ...rotten, detailSlugs: Array.from({ length: 10 }, (_, i) => `p${i}`) };
		const header = parse(earlyReadsLinkHeader('/shop/', many)!);
		expect(header).toHaveLength(EARLY_LINK_MAX);
		expect(header).toEqual(urls('/shop/', many).slice(0, EARLY_LINK_MAX));
	});
	it('no header at all for a render that is not a shell (SHELL_CACHE off, SHELL_CACHE_EXCLUDE, dynamic): rollback is today\'s page', () => {
		for (const path of ['/shop/', '/checkout/']) {
			expect(earlyReadsLinkHeader(path, { ...damned, shell: false }), path).toBeNull();
			expect(earlyReadsLinkHeader(path, { ...rotten, shell: false }), path).toBeNull();
		}
	});
	it('no header for any other page or for the license flow', () => {
		for (const path of ['/', '/products/oni/', '/blog/', '/about/', '/checkout/payment/', '/account/']) expect(earlyReadsLinkHeader(path, damned), path).toBeNull();
		expect(earlyReadsLinkHeader('/checkout/', { ...damned, license: true })).toBeNull();
		expect(earlyReadsLinkHeader('/shop/', { ...damned, license: true })).toBeNull();
	});
	it('identical for every visitor: no cookie, token, country or visitor value ever reaches it', () => {
		const compute = () => ['/shop/', '/checkout/'].map((p) => earlyReadsLinkHeader(p, damned));
		const anonymous = compute();
		document.cookie = 'sr_cart=tok-secret-1; Path=/';
		document.cookie = 'countryCode=DE; Path=/';
		document.cookie = 'sr_cust_csrf=abc; Path=/';
		localStorage.setItem('sr_country_pref', JSON.stringify({ countryCode: 'FR', source: 'explicit' }));
		window.history.replaceState(null, '', '/checkout/?utm_source=x');
		expect(compute()).toEqual(anonymous);
		for (const h of anonymous) {
			expect(h).not.toMatch(/tok-secret|shipCountry|countryCode|DE|FR|slug=|sr_cart|sr_cust/);
			expect(parse(h!).every((u) => !u.includes('?') || u === LISTING_FIRST_PAGE_URL)).toBe(true);
		}
	});
	it('the early script issues exactly the Link entries: same URL, credentials include, GET (no method), keeping cache no-store', () => {
		for (const [path, ctx] of [['/shop/', damned], ['/shop/', rotten], ['/checkout/', damned], ['/checkout/', rotten]] as const) {
			clearCookies();
			const m = runScript(path, ctx);
			expect(started(m), path).toEqual(parse(earlyReadsLinkHeader(path, ctx)!));
			for (const call of m.mock.calls) {
				const init = call[1] as RequestInit;
				expect(init.credentials, `${path} ${call[0]}`).toBe('include');
				expect(init.cache).toBe('no-store');
				expect(init.method).toBeUndefined(); // GET, as a preload is
			}
		}
	});
	it('the checkout summary read starts even without a cart cookie (it must match the preload); no cart read then', () => {
		const m = runScript('/checkout/', damned);
		expect(started(m)).toContain(CHECKOUT_SUMMARY_URL);
		expect(started(m).some((u) => String(u).startsWith('/v1/shop/cart/'))).toBe(false);
	});
	it('rollback: the checkout plan of a non-shell render starts no summary read', () => {
		expect(started(runScript('/checkout/', { ...damned, shell: false }))).toEqual([SHOP_CONFIG_URL]);
	});
});
