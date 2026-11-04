import { describe, expect, it, vi } from 'vitest';
import { composedHeaders, edgeBlock, geoCookie, edgeMeta, edgeReadKeys, isDocumentGet, readLive, safeJson, withoutPreloads } from '../../edge/edge-reads.worker.js';
import { CHECKOUT_SUMMARY_URL, EDGE_READS_META, buildEarlyReadsPlan, earlyReadsLinkHeader, liveReadUrl, type EarlyReadsContext } from './early-reads';

const req = (url: string, init: { headers?: Record<string, string>; method?: string; cf?: { country?: string } } = {}) => {
	const r = new Request(url, { headers: { accept: 'text/html,application/xhtml+xml', ...init.headers }, method: init.method });
	if (init.cf) Object.defineProperty(r, 'cf', { value: init.cf });
	return r;
};

// The same two stores as early-reads.test.ts.
const damned: EarlyReadsContext = {
	productPrefix: 'products', shell: true, brandHome: true, brandShop: false, brandProduct: false,
	homeSpotlightSlug: 'pocket-fixed-blade', detailSlugs: [], shopLiveListing: false,
};
const rotten: EarlyReadsContext = {
	productPrefix: 'shop', shell: true, brandHome: true, brandShop: true, brandProduct: true,
	homeSpotlightSlug: null, detailSlugs: ['shortsleeveshirt', 'longsleeveshirt'], shopLiveListing: true,
};

describe('#425 edge reads Worker', () => {
	it('starts exactly the reads the shell declares, which are the reads its early script makes (one source of truth)', () => {
		for (const ctx of [damned, rotten]) for (const path of ['/shop/', '/checkout/']) {
			const link = earlyReadsLinkHeader(path, ctx);
			expect(link).not.toBeNull();
			const planned = buildEarlyReadsPlan(path, ctx).get.map(([u]) => u);
			expect(edgeReadKeys(link)).toEqual(planned);
		}
		expect(edgeReadKeys(earlyReadsLinkHeader('/shop/', { ...damned, shell: false }))).toEqual([]); // not a shell: nothing to start
		expect(edgeReadKeys(earlyReadsLinkHeader('/checkout/', damned))).toContain(CHECKOUT_SUMMARY_URL);
		expect(edgeReadKeys(earlyReadsLinkHeader('/shop/', damned))).toContain(liveReadUrl('shop-catalog'));
	});
	it('ignores everything that is not a same-origin fetch preload', () => {
		expect(edgeReadKeys(null)).toEqual([]);
		expect(edgeReadKeys('</a.css>; rel=preload; as=style, </b.js>; rel=modulepreload, <https://x.test/c>; rel=preload; as=fetch, <//x.test/d>; rel=preload; as=fetch, </e/>; rel=preconnect'))
			.toEqual([]);
		expect(edgeReadKeys('</v1/x>; rel="preload"; as="fetch"; crossorigin=use-credentials, </v1/x>; rel=preload; as=fetch')).toEqual(['/v1/x']);
		expect(edgeReadKeys(Array.from({ length: 9 }, (_, i) => `</r${i}>; rel=preload; as=fetch`).join(', '))).toHaveLength(6);
	});
	it('composes document GETs only', () => {
		expect(isDocumentGet(req('https://s.test/shop/'))).toBe(true);
		expect(isDocumentGet(req('https://s.test/shop/', { method: 'HEAD' }))).toBe(false);
		expect(isDocumentGet(new Request('https://s.test/shop/', { headers: { accept: 'application/json' } }))).toBe(false);
		expect(edgeMeta(['/a/', '/b/'])).toBe(`<meta name="${EDGE_READS_META}" content="/a/ /b/">`);
	});
	it('drops only the preload of a read it serves', () => {
		const link = '</api/live/checkout-summary/>; rel=preload; as=fetch; crossorigin=use-credentials, </v1/shop/config>; rel=preload; as=fetch; crossorigin=use-credentials';
		expect(withoutPreloads(link, [CHECKOUT_SUMMARY_URL])).toBe('</v1/shop/config>; rel=preload; as=fetch; crossorigin=use-credentials');
		expect(withoutPreloads('</api/live/checkout-summary/>; rel=preload', [CHECKOUT_SUMMARY_URL])).toBeNull();
		expect(withoutPreloads(null, [CHECKOUT_SUMMARY_URL])).toBeNull();
	});
	it('the composed response is never stored and says which reads it carries', () => {
		const h = composedHeaders(new Headers({ 'cache-control': 'public, max-age=0, s-maxage=86400', 'cdn-cache-control': 'max-age=86400', etag: 'W/"1"', age: '30', link: '</api/live/shop-catalog/>; rel=preload', 'x-sr-edge': 'cacheable' }), [liveReadUrl('shop-catalog')]);
		expect(h.get('cache-control')).toBe('private, no-store');
		expect(h.get('cdn-cache-control')).toBeNull();
		expect(h.get('etag')).toBeNull();
		expect(h.get('age')).toBeNull();
		expect(h.get('link')).toBeNull();
		expect(h.get('x-sr-edge-reads')).toBe('/api/live/shop-catalog/');
	});
	it('sets the country cookie from the edge country only when the visitor has none', () => {
		expect(geoCookie(req('https://s.test/checkout/', { cf: { country: 'IN' } }))).toBe('countryCode=IN; Path=/; Max-Age=2592000; SameSite=Lax; Secure');
		expect(geoCookie(req('https://s.test/checkout/', { headers: { cookie: 'a=1; countryCode=DE' }, cf: { country: 'IN' } }))).toBeNull();
		expect(geoCookie(req('https://s.test/checkout/', { cf: { country: 'XX' } }))).toBeNull();
		expect(geoCookie(req('https://s.test/checkout/'))).toBeNull();
		const h = composedHeaders(new Headers({ 'x-sr-edge': 'cacheable' }), ['/a/'], req('https://s.test/checkout/', { cf: { country: 'in' } }));
		expect(h.get('set-cookie')).toBe('countryCode=IN; Path=/; Max-Age=2592000; SameSite=Lax; Secure');
	});
	it('the block is inert JSON with no `<` in it, and parses back to the same value', () => {
		const text = JSON.stringify({ name: '</script><img src=x onerror=alert(1)>', s: String.fromCharCode(0x2028) });
		const b = edgeBlock(CHECKOUT_SUMMARY_URL, { ok: true, text });
		expect(b.startsWith('<script type="application/json" data-sr-edge="/api/live/checkout-summary/" data-ok="1">')).toBe(true);
		const inner = b.slice(b.indexOf('>') + 1, b.lastIndexOf('</script>'));
		expect(inner).not.toContain('<');
		expect(inner).not.toContain(String.fromCharCode(0x2028));
		expect(JSON.parse(inner)).toEqual(JSON.parse(text));
		expect(safeJson('"a<b"')).toBe('"a\\u003cb"');
		expect(edgeBlock('/x/', { ok: false, text: 'ignored' })).toBe('<script type="application/json" data-sr-edge="/x/" data-ok="0"></script>');
	});
	it('reads with the visitor cookie and edge country; a failed, non-JSON or thrown read is not ok (never throws)', async () => {
		const f = vi.fn(async () => new Response('{"cart":null}', { headers: { 'content-type': 'application/json' } }));
		const r = await readLive('https://s.test', CHECKOUT_SUMMARY_URL, req('https://s.test/checkout/', { headers: { cookie: 'sr_cart=t1' }, cf: { country: 'IN' } }), f);
		expect(r).toEqual({ ok: true, text: '{"cart":null}' });
		const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Headers }];
		expect(url).toBe('https://s.test/api/live/checkout-summary/');
		expect(init.headers.get('cookie')).toBe('sr_cart=t1');
		expect(init.headers.get('cf-ipcountry')).toBe('IN');
		expect(await readLive('https://s.test', '/x/', req('https://s.test/shop/'), async () => new Response('x', { status: 500 }))).toEqual({ ok: false, text: '' });
		expect(await readLive('https://s.test', '/x/', req('https://s.test/shop/'), async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }))).toEqual({ ok: false, text: '' });
		expect(await readLive('https://s.test', '/x/', req('https://s.test/shop/'), async () => { throw new Error('net'); })).toEqual({ ok: false, text: '' });
	});
});
