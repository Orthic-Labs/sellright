import { afterEach, describe, expect, it, vi } from 'vitest';
import { sitemapHandler, robotsHandler, indexNowKeyFile, getIndexNowKey, jsonLdOrganization, jsonLdProduct } from './sellright-seo';

afterEach(() => vi.unstubAllGlobals());

function makeCtx() {
  const sent: { status: number; body: string }[] = [];
  const headerMap = new Map<string, string>();
  return {
    send: (status: number, body: string) => sent.push({ status, body }),
    headers: { set: (k: string, v: string) => headerMap.set(k, v) },
    sent,
    headerMap,
  } as any;
}

describe('SellRight SEO proxies', () => {
  it('proxies the sitemap XML body and content-type from the API', async () => {
    const xml = '<?xml version="1.0"?><urlset></urlset>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } })));
    const ctx = makeCtx();
    await sitemapHandler('main')(ctx);
    expect(ctx.sent[0]).toEqual({ status: 200, body: xml });
    expect(ctx.headerMap.get('Content-Type')).toBe('application/xml');
  });

  it('fails closed with an empty urlset when the API is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const ctx = makeCtx();
    await sitemapHandler('products')(ctx);
    expect(ctx.sent[0].status).toBe(503);
    expect(ctx.sent[0].body).toContain('<urlset');
  });

  it('proxies robots.txt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('User-agent: *\nDisallow: /admin/\n', { status: 200, headers: { 'content-type': 'text/plain' } })));
    const ctx = makeCtx();
    await robotsHandler(ctx);
    expect(ctx.sent[0].body).toContain('Disallow: /admin/');
  });

  it('serves the IndexNow key file only when the requested filename matches the configured key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('abc123', { status: 200 })));
    expect(await indexNowKeyFile('abc123.txt')).toEqual({ status: 200, body: 'abc123' });
    expect(await indexNowKeyFile('wrong.txt')).toBeNull();
  });

  it('returns null when IndexNow is not configured on the store', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    expect(await indexNowKeyFile('anything.txt')).toBeNull();
  });

  it('getIndexNowKey reads the key value from the backend, never an env var', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('backend-key-123', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getIndexNowKey()).toBe('backend-key-123');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/shop/seo/indexnow-key.txt');
  });

  it('getIndexNowKey returns null when not configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    expect(await getIndexNowKey()).toBeNull();
  });

  it('jsonLdOrganization proxies the backend org+website schemas', async () => {
    const items = [{ '@type': 'Organization', name: 'Demo' }, { '@type': 'WebSite', name: 'Demo' }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } })));
    expect(await jsonLdOrganization()).toEqual(items);
  });

  it('jsonLdOrganization fails closed to an empty array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    expect(await jsonLdOrganization()).toEqual([]);
  });

  it('jsonLdProduct proxies live product schema by slug', async () => {
    const schema = { '@type': 'Product', name: 'Widget', offers: { availability: 'https://schema.org/InStock' } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(schema), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await jsonLdProduct('widget')).toEqual(schema);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/shop/seo/jsonld/products/widget');
  });

  it('jsonLdProduct returns null on 404 (product not found)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'not found' }), { status: 404 })));
    expect(await jsonLdProduct('missing')).toBeNull();
  });
});
