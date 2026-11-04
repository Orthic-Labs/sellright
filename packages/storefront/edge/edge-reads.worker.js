/* global HTMLRewriter */
// SellRight edge reads (#425, ADR-0001): a cached shell's live read, started at the edge when the request arrives.
//
// A cached shell page (/shop/, /checkout/) carries no live values: its early script (platform/early-reads.ts) reads them in the
// browser. That read can only start once the document's headers reach the browser, then pays a full trip to the origin. This Worker
// starts the same GET at request arrival, in parallel with the shell (served from Cloudflare's cache), and appends its answer to the
// page as a non-executing JSON block before </body>. The page's early script sees <meta name="sr-edge"> naming the read, takes the
// block instead of fetching (one read, same consumers), and falls back to its own fetch on a failed read or after EDGE_WAIT_MS.
//
// Invariants:
// - Only a cached shell is composed (`x-sr-edge: cacheable`); any other response passes through untouched.
// - The composed response carries live (and, for checkout, per-visitor) values: `private, no-store`, never stored by any cache.
// - Live reads are made with the visitor's own Cookie and are never cached (the endpoints answer `private, no-store`).
// - Fail open: any error returns the origin's response unchanged (the page then reads in the browser as before).
// - The JSON is escaped for the HTML context (no `<` survives) and the block is `type=application/json`: never executed.

/** Path -> the live reads the page's early script makes on a shell render (early-reads.ts buildEarlyReadsPlan). */
export const EDGE_READS = {
	'/shop/': ['/api/live/shop-catalog/'],
	'/checkout/': ['/api/live/checkout-summary/'],
};
/** An edge read slower than this is abandoned (data-ok=0): the page reads it itself. */
export const EDGE_READ_TIMEOUT_MS = 2500;

/** The reads to start for this request, or null to pass it through. */
export function edgeReadsFor(request) {
	if (request.method !== 'GET') return null;
	const url = new URL(request.url);
	if (url.search) return null; // a query URL is never a shell (route-cache-policy)
	const keys = EDGE_READS[url.pathname];
	if (!keys) return null;
	if (!(request.headers.get('accept') || '').includes('text/html')) return null;
	return keys;
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

/** The composed response's headers: live values in it, so never stored; no preload of a read already in the page. */
export function composedHeaders(headers, keys) {
	const h = new Headers(headers);
	const link = withoutPreloads(h.get('link'), keys);
	if (link) h.set('link', link); else h.delete('link');
	h.set('cache-control', 'private, no-store');
	for (const n of ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'etag', 'last-modified', 'age', 'content-length']) h.delete(n);
	h.set('x-sr-edge-reads', keys.join(' '));
	return h;
}

export default {
	async fetch(request) {
		const keys = edgeReadsFor(request);
		if (!keys) return fetch(request);
		const origin = new URL(request.url).origin;
		const reads = keys.map((k) => readLive(origin, k, request)); // started now, in parallel with the shell
		const res = await fetch(request);
		try {
			if (res.status !== 200 || !(res.headers.get('x-sr-edge') || '').startsWith('cacheable') || !(res.headers.get('content-type') || '').includes('text/html')) return res;
			const done = Promise.all(reads);
			return new HTMLRewriter()
				.on('head', { element(e) { e.prepend(edgeMeta(keys), { html: true }); } })
				.on('body', {
					element(e) {
						e.onEndTag(async (end) => {
							const got = await done;
							end.before(keys.map((k, i) => edgeBlock(k, got[i])).join(''), { html: true });
						});
					},
				})
				.transform(new Response(res.body, { status: res.status, statusText: res.statusText, headers: composedHeaders(res.headers, keys) }));
		} catch {
			return res;
		}
	},
};
