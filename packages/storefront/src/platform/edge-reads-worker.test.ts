import { describe, expect, it, vi } from 'vitest';
import { EDGE_READS, composedHeaders, edgeBlock, edgeMeta, edgeReadsFor, readLive, safeJson, withoutPreloads } from '../../edge/edge-reads.worker.js';
import { CHECKOUT_SUMMARY_URL, EDGE_READS_META, liveReadUrl } from './early-reads';

const req = (url: string, init: RequestInit & { cf?: { country?: string } } = {}) => {
	const r = new Request(url, { headers: { accept: 'text/html,application/xhtml+xml', ...(init.headers as Record<string, string> | undefined) }, method: init.method });
	if (init.cf) Object.defineProperty(r, 'cf', { value: init.cf });
	return r;
};

describe('#425 edge reads Worker', () => {
	it('names exactly the reads the page plan makes on a shell render', () => {
		expect(EDGE_READS).toEqual({ '/shop/': [liveReadUrl('shop-catalog')], '/checkout/': [CHECKOUT_SUMMARY_URL] });
		expect(edgeMeta(['/a/', '/b/'])).toBe(`<meta name="${EDGE_READS_META}" content="/a/ /b/">`);
	});
	it('only document GETs of /shop/ and /checkout/ without a query', () => {
		expect(edgeReadsFor(req('https://s.test/shop/'))).toEqual([liveReadUrl('shop-catalog')]);
		expect(edgeReadsFor(req('https://s.test/checkout/'))).toEqual([CHECKOUT_SUMMARY_URL]);
		expect(edgeReadsFor(req('https://s.test/shop/?facets=x'))).toBeNull();
		expect(edgeReadsFor(req('https://s.test/products/x/'))).toBeNull();
		expect(edgeReadsFor(req('https://s.test/shop/', { method: 'HEAD' }))).toBeNull();
		expect(edgeReadsFor(new Request('https://s.test/shop/', { headers: { accept: 'application/json' } }))).toBeNull();
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
	it('the block is inert JSON with no `<` in it, and parses back to the same value', () => {
		const text = JSON.stringify({ name: '</script><img src=x onerror=alert(1)>', s: ' ' });
		const b = edgeBlock(CHECKOUT_SUMMARY_URL, { ok: true, text });
		expect(b.startsWith('<script type="application/json" data-sr-edge="/api/live/checkout-summary/" data-ok="1">')).toBe(true);
		const inner = b.slice(b.indexOf('>') + 1, b.lastIndexOf('</script>'));
		expect(inner).not.toContain('<');
		expect(JSON.parse(inner)).toEqual(JSON.parse(text));
		expect(safeJson('"a<b"')).toBe('"a\\u003cb"');
		expect(edgeBlock('/x/', { ok: false, text: 'ignored' })).toBe('<script type="application/json" data-sr-edge="/x/" data-ok="0"></script>');
	});
	it('reads with the visitor cookie and edge country; a failed, non-JSON or slow read is not ok (never throws)', async () => {
		const f = vi.fn(async () => new Response('{"cart":null}', { headers: { 'content-type': 'application/json' } }));
		const r = await readLive('https://s.test', CHECKOUT_SUMMARY_URL, req('https://s.test/checkout/', { headers: { cookie: 'sr_cart=t1' }, cf: { country: 'IN' } }), f);
		expect(r).toEqual({ ok: true, text: '{"cart":null}' });
		const init = (f.mock.calls[0] as unknown[])[1] as { headers: Headers };
		expect((f.mock.calls[0] as unknown[])[0]).toBe('https://s.test/api/live/checkout-summary/');
		expect(init.headers.get('cookie')).toBe('sr_cart=t1');
		expect(init.headers.get('cf-ipcountry')).toBe('IN');
		expect(await readLive('https://s.test', '/x/', req('https://s.test/shop/'), async () => new Response('x', { status: 500 }))).toEqual({ ok: false, text: '' });
		expect(await readLive('https://s.test', '/x/', req('https://s.test/shop/'), async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }))).toEqual({ ok: false, text: '' });
		expect(await readLive('https://s.test', '/x/', req('https://s.test/shop/'), async () => { throw new Error('net'); })).toEqual({ ok: false, text: '' });
	});
});
