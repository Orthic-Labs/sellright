import { describe, expect, it, vi } from 'vitest';
import { seoConfigFromStore } from './config.js';
import { submitIndexNowUrls } from './indexnow.js';

const configured = seoConfigFromStore({ name: 'Acme', config: { seo: { siteUrl: 'https://acme.example.com', indexNow: { key: 'abcdef0123456789' } } } });
const noKey = seoConfigFromStore({ name: 'Acme', config: { seo: { siteUrl: 'https://acme.example.com' } } });
const noSiteUrl = seoConfigFromStore({ name: 'Acme', config: { seo: { indexNow: { key: 'abcdef0123456789' } } } });

describe('submitIndexNowUrls', () => {
  it('never calls fetch when the store has no IndexNow key configured', async () => {
    const fetchMock = vi.fn();
    const result = await submitIndexNowUrls(noKey, ['https://acme.example.com/products/widget/'], fetchMock);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('not configured') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never calls fetch when the store has no siteUrl configured', async () => {
    const fetchMock = vi.fn();
    const result = await submitIndexNowUrls(noSiteUrl, ['https://acme.example.com/products/widget/'], fetchMock);
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts host/key/keyLocation/urlList to the fixed IndexNow endpoint and reports success on 2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 202 }));
    const result = await submitIndexNowUrls(configured, ['https://acme.example.com/products/widget/', 'https://acme.example.com/products/widget/'], fetchMock);
    expect(result).toEqual({ ok: true, status: 202 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.indexnow.org/indexnow');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      host: 'acme.example.com',
      key: 'abcdef0123456789',
      keyLocation: 'https://acme.example.com/abcdef0123456789.txt',
      urlList: ['https://acme.example.com/products/widget/'], // deduped
    });
  });

  it('reports failure on a non-2xx response without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad key', { status: 422 }));
    const result = await submitIndexNowUrls(configured, ['https://acme.example.com/'], fetchMock);
    expect(result).toEqual({ ok: false, status: 422 });
  });

  it('fails closed on a network error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const result = await submitIndexNowUrls(configured, ['https://acme.example.com/'], fetchMock);
    expect(result).toEqual({ ok: false, error: 'network down' });
  });

  it('rejects an empty URL list without calling fetch', async () => {
    const fetchMock = vi.fn();
    const result = await submitIndexNowUrls(configured, [], fetchMock);
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
