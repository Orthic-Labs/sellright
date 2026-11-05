/* global HTMLRewriter */
// SellRight edge reads (#425, ADR-0001): a cached shell's live read, started at the edge when the request arrives.
//
// A cached shell page (/shop/, /checkout/ today) carries no live values: its early script (platform/early-reads.ts) reads them in the
// browser. That read can only start once the document's headers reach the browser, then pays a full trip to the origin. This Worker
// starts the same GETs (the ones the shell's Link header declares) as soon as the cached shell's headers are in, and appends its answer to the
// page as a non-executing JSON block before </body>. The page's early script sees <meta name="sr-edge"> naming the read, takes the
// block instead of fetching (one read, same consumers), and falls back to its own fetch on a failed read or after EDGE_WAIT_MS.
//
// Invariants:
// - Only a cached shell is composed (`x-sr-edge: cacheable`); any other response passes through untouched.
// - The composed response carries live (and, for checkout, per-visitor) values: `private, no-store`, never stored by any cache.
// - Live reads are made with the visitor's own Cookie and are never cached (the endpoints answer `private, no-store`).
// - Fail open: any error returns the origin's response unchanged (the page then reads in the browser as before).
// - The JSON is escaped for the HTML context (no `<` survives) and the block is `type=application/json`: never executed.

/** Plain HTML body elements a data block may be inserted before (never inside svg, math, template, script or style). */
export const EARLY_SELECTOR = 'body > div, body > main, body > header, body > section, body > footer, body div, body main, body section, body form, body p';
/** An edge read slower than this is abandoned (data-ok=0): the page reads it itself. */
export const EDGE_READ_TIMEOUT_MS = 2500;
/** At most this many reads per page (a shell declares 1-3; early-reads.ts EARLY_LINK_MAX is 6). */
export const EDGE_MAX_READS = 6;

/** A document request this Worker may compose; anything else is passed straight through. */
export const isDocumentGet = (request) => request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html')
	// The ADR-0001 edge-conformance watcher (deploy/edge-conformance.mjs) audits what the CACHE holds: it gets the shell untouched.
	&& !(request.headers.get('user-agent') || '').includes('sellright-edge-conformance');

/** #425: a checkout request with no cart cookie. The cached checkout shell cannot know there is no cart and paints the form first
 *  (the uncached render paints the empty-cart view straight from the server: routes/checkout useCheckoutNoCartCookie). Such a
 *  request is sent to the uncached render instead: a query URL is never a shell (route-cache-policy), and the URL the browser shows
 *  is unchanged. Bots, crawlers and audits land here; a shopper with a cart keeps the edge-cached path. */
export function noCartCheckout(request) {
	const url = new URL(request.url);
	return url.pathname === '/checkout/' && !url.search && !/(?:^|;\s*)sr_cart=[^;\s]/.test(request.headers.get('cookie') || '');
}
export const NO_CART_PARAM = 'sr_nocart';

/** The live reads a cached shell declares: its `Link` entries with rel=preload and as=fetch, same-origin paths only. The storefront
 *  derives that header from the same plan its early script runs (early-reads.ts earlyReadsLinkHeader), so these are exactly the reads
 *  the page would start, for any store and page, with no list kept here. */
export function edgeReadKeys(link) {
	if (!link) return [];
	const out = [];
	for (const entry of link.split(/,(?=\s*<)/)) {
		const m = entry.trim().match(/^<([^>]*)>(.*)$/);
		if (!m) continue;
		const params = m[2].toLowerCase();
		if (!/;\s*rel="?preload"?(?:;|$|\s)/.test(params) || !/;\s*as="?fetch"?(?:;|$|\s)/.test(params)) continue;
		const url = m[1];
		if (!url.startsWith('/') || url.startsWith('//')) continue;
		if (!out.includes(url)) out.push(url);
		if (out.length >= EDGE_MAX_READS) break;
	}
	return out;
}

/** The Link header without the preloads of reads the Worker serves (the browser would otherwise fetch them a second time). */
export function withoutPreloads(link, keys) {
	if (!link) return null;
	const kept = link.split(/,(?=\s*<)/).map((s) => s.trim()).filter((e) => e && !keys.some((k) => e.startsWith(`<${k}>`)));
	return kept.length ? kept.join(', ') : null;
}

const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
/** JSON text safe inside <script>: every `<` (and the two JS line terminators) escaped; still valid JSON with the same value. */
const LS = new RegExp(String.fromCharCode(0x2028), 'g');
const PS = new RegExp(String.fromCharCode(0x2029), 'g');
export const safeJson = (text) => text.replace(/</g, '\\u003c').replace(LS, '\\u2028').replace(PS, '\\u2029');

/** The data block for one read. A failed read is an empty block with data-ok=0. */
export function edgeBlock(key, read) {
	const ok = !!(read && read.ok);
	return `<script type="application/json" data-sr-edge="${attr(key)}" data-ok="${ok ? 1 : 0}">${ok ? safeJson(read.text) : ''}</script>`;
}

export const edgeMeta = (keys) => `<meta name="sr-edge" content="${attr(keys.join(' '))}">`;

/** One live read with the visitor's cookie and country, bounded by EDGE_READ_TIMEOUT_MS. Never throws. */
export async function readLive(origin, key, request, fetchImpl = fetch) {
	const headers = new Headers({ accept: 'application/json' });
	const cookie = request.headers.get('cookie');
	if (cookie) headers.set('cookie', cookie);
	const country = (request.cf && request.cf.country) || request.headers.get('cf-ipcountry');
	if (country) headers.set('cf-ipcountry', country);
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), EDGE_READ_TIMEOUT_MS);
	try {
		const res = await fetchImpl(new URL(key, origin).toString(), { headers, signal: ac.signal, redirect: 'manual' });
		if (!res.ok || !(res.headers.get('content-type') || '').includes('application/json')) return { ok: false, text: '' };
		return { ok: true, text: await res.text() };
	} catch {
		return { ok: false, text: '' };
	} finally {
		clearTimeout(timer);
	}
}

/** #425: the `countryCode` cookie for a visitor without one, from the edge's own country (the storefront's checkout document sets the
 *  same, routes/checkout/summary-cart.ts COUNTRY_COOKIE_OPTIONS): the page's parse-time cart read and the checkout boot read it
 *  first, so they price the visitor's destination from the start. Null when the request has one or the country is unknown. */
export function geoCookie(request) {
	if (/(?:^|;\s*)countryCode=/.test(request.headers.get('cookie') || '')) return null;
	const c = String((request.cf && request.cf.country) || '').toUpperCase();
	if (!/^[A-Z]{2}$/.test(c) || c === 'XX' || c === 'T1') return null;
	return `countryCode=${c}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`;
}

/** The composed response's headers: live values in it, so never stored; no preload of a read already in the page. */
export function composedHeaders(headers, keys, request) {
	const h = new Headers(headers);
	const geo = request ? geoCookie(request) : null;
	if (geo) h.append('set-cookie', geo);
	const link = withoutPreloads(h.get('link'), keys);
	if (link) h.set('link', link); else h.delete('link');
	h.set('cache-control', 'private, no-store');
	for (const n of ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'etag', 'last-modified', 'age', 'content-length']) h.delete(n);
	h.set('x-sr-edge-reads', keys.join(' '));
	return h;
}

export default {
	async fetch(request) {
		if (!isDocumentGet(request)) return fetch(request);
		if (noCartCheckout(request)) {
			const url = new URL(request.url);
			url.searchParams.set(NO_CART_PARAM, '1');
			return fetch(new Request(url.toString(), request));
		}
		const res = await fetch(request); // a cached shell: a cache HIT, its headers in a few ms
		try {
			if (res.status !== 200 || !(res.headers.get('x-sr-edge') || '').startsWith('cacheable') || !(res.headers.get('content-type') || '').includes('text/html')) return res;
			const keys = edgeReadKeys(res.headers.get('link'));
			if (!keys.length) return res;
			const origin = new URL(request.url).origin;
			const done = Promise.all(keys.map((k) => readLive(origin, k, request))); // started now, while the shell streams
			// The blocks go in at the first plain body element the rewriter reaches after the reads are back (the shell streams at the
			// visitor's pace, so near the origin that is the top of the page), never holding the stream; </body> is the fallback.
			let got = null, placed = false;
			done.then((g) => { got = g; });
			const blocks = () => keys.map((k, i) => edgeBlock(k, got[i])).join('');
			const early = { element(e) { if (got && !placed) { placed = true; e.before(blocks(), { html: true }); } } };
			return new HTMLRewriter()
				.on('head', { element(e) { e.prepend(edgeMeta(keys), { html: true }); } })
				.on(EARLY_SELECTOR, early)
				.on('body', {
					element(e) {
						e.onEndTag(async (end) => {
							if (placed) return;
							got = await done;
							placed = true;
							end.before(blocks(), { html: true });
						});
					},
				})
				.transform(new Response(res.body, { status: res.status, statusText: res.statusText, headers: composedHeaders(res.headers, keys, request) }));
		} catch {
			return res;
		}
	},
};
