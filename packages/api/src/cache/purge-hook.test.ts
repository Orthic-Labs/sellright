import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above top-level const/let declarations — see
// manifest/stock-hook.test.ts for the same vi.hoisted pattern.
const { envMock, errError, purgeSpy, cfConfig } = vi.hoisted(() => ({
  envMock: {} as Record<string, string | undefined>,
  errError: vi.fn(),
  purgeSpy: vi.fn().mockResolvedValue(undefined),
  cfConfig: vi.fn((): unknown => ({ zoneId: 'z', apiToken: 't' })),
}));

vi.mock('../env.js', () => ({ env: envMock }));
vi.mock('../lib/logger.js', () => ({ log: { info: vi.fn() }, err: { error: (...a: unknown[]) => errError(...a) } }));
const { hostSpy } = vi.hoisted(() => ({ hostSpy: vi.fn().mockResolvedValue(true) }));
vi.mock('./cloudflare-purge.js', () => ({ purgeCloudflareUrls: (...a: unknown[]) => purgeSpy(...a), purgeCloudflareHosts: (...a: unknown[]) => hostSpy(...a), resolveCloudflareConfig: () => cfConfig() }));

import { onBlogContentChanged, onCatalogCacheChanged, onCollectionChanged, onStoreShellConfigChanged, planPurge, purgeAfterPublish, purgeHostForMaintenance, PURGE_URL_FALLBACK_THRESHOLD, runPurge, _setPurgeRetryPolicyForTest } from './purge-hook.js';

beforeEach(() => {
  for (const k of Object.keys(envMock)) delete envMock[k];
  errError.mockClear();
  purgeSpy.mockClear();
});

describe('onCatalogCacheChanged', () => {
  it('purges the shop root/listing/sitemaps using STOREFRONT_URL', () => {
    envMock.STOREFRONT_URL = 'https://acme.example.com';
    onCatalogCacheChanged('acme');
    expect(purgeSpy).toHaveBeenCalledWith('acme', [
      'https://acme.example.com/',
      'https://acme.example.com/shop/',
      'https://acme.example.com/sitemap.xml',
      'https://acme.example.com/sitemap-products.xml',
    ]);
  });

  it('also purges the specific product page at the path the caller resolved from the store config', () => {
    envMock.STOREFRONT_URL = 'https://acme.example.com';
    onCatalogCacheChanged('acme', { productPath: '/products/widget/' });
    expect(purgeSpy).toHaveBeenCalledWith('acme', expect.arrayContaining(['https://acme.example.com/products/widget/']));
    onCatalogCacheChanged('acme', { productPath: '/shop/widget/' });
    expect(purgeSpy).toHaveBeenLastCalledWith('acme', expect.arrayContaining(['https://acme.example.com/shop/widget/']));
    expect(purgeSpy.mock.lastCall?.[1]).not.toContain('https://acme.example.com/products/widget/');
  });

  it('prefers a per-store origin override over the single fallback', () => {
    envMock.STOREFRONT_URL = 'https://fallback.example.com';
    envMock.STOREFRONT_ORIGIN_BY_STORE = 'acme=https://acme-brand.com';
    onCatalogCacheChanged('acme');
    expect(purgeSpy).toHaveBeenCalledWith('acme', expect.arrayContaining(['https://acme-brand.com/']));
  });

  it('strips a trailing slash from the configured origin before building urls', () => {
    envMock.STOREFRONT_URL = 'https://acme.example.com/';
    onCatalogCacheChanged('acme');
    expect(purgeSpy).toHaveBeenCalledWith('acme', expect.arrayContaining(['https://acme.example.com/']));
    // no double slash
    const urls = purgeSpy.mock.calls[0]![1] as string[];
    expect(urls.some((u) => u.includes('//shop'))).toBe(false);
  });

  it('never throws when STOREFRONT_URL is missing/misconfigured — logs and no-ops', () => {
    // envMock.STOREFRONT_URL intentionally left unset
    expect(() => onCatalogCacheChanged('acme')).not.toThrow();
    expect(purgeSpy).not.toHaveBeenCalled();
  });
});

describe('purgeAfterPublish (N9 / F5)', () => {
  beforeEach(() => { cfConfig.mockImplementation(() => ({ zoneId: 'z', apiToken: 't' })); purgeSpy.mockReset(); });

  it('purges the standard set plus every affected product page and reports success', async () => {
    envMock.STOREFRONT_URL = 'https://acme.example.com';
    purgeSpy.mockResolvedValueOnce(true);
    await expect(purgeAfterPublish('acme', ['/products/old/', '/products/new/', '/products/new/'])).resolves.toBe('purged');
    const urls = purgeSpy.mock.calls[0]![1] as string[];
    expect(urls).toEqual(expect.arrayContaining(['https://acme.example.com/', 'https://acme.example.com/products/old/', 'https://acme.example.com/products/new/']));
    expect(urls.filter((u) => u.endsWith('/products/new/'))).toHaveLength(1);
  });

  it('is skipped (not failed) without an origin or Cloudflare config', async () => {
    await expect(purgeAfterPublish('acme')).resolves.toBe('skipped');
    envMock.STOREFRONT_URL = 'https://acme.example.com';
    cfConfig.mockImplementation(() => null);
    await expect(purgeAfterPublish('acme')).resolves.toBe('skipped');
    expect(purgeSpy).not.toHaveBeenCalled();
  });

  it('reports a rejected purge as failed (retryable)', async () => {
    envMock.STOREFRONT_URL = 'https://acme.example.com';
    purgeSpy.mockResolvedValueOnce(false);
    await expect(purgeAfterPublish('acme')).resolves.toBe('failed');
  });

  it('bounds a hung purge by its deadline', async () => {
    envMock.STOREFRONT_URL = 'https://acme.example.com';
    purgeSpy.mockImplementationOnce(() => new Promise(() => {}));
    await expect(purgeAfterPublish('acme', [], 20)).resolves.toBe('failed');
    expect(errError).toHaveBeenCalled();
  });
});

describe('onBlogContentChanged (P4b purge-on-publish)', () => {
  it('purges the blog index, sitemaps and every changed post', async () => {
    envMock.STOREFRONT_URL = 'https://acme.example.com';
    purgeSpy.mockReset();
    purgeSpy.mockResolvedValue(true);
    onBlogContentChanged('acme', ['old-slug', 'new slug', 'old-slug']);
    expect(purgeSpy).toHaveBeenCalledWith('acme', ['https://acme.example.com/', 'https://acme.example.com/blog/', 'https://acme.example.com/sitemap-blog.xml', 'https://acme.example.com/sitemap.xml', 'https://acme.example.com/blog/old-slug/', 'https://acme.example.com/blog/new%20slug/']);
  });
});

describe('ADR-0001 item 5 triggers', () => {
  const O = 'https://acme.example.com';
  beforeEach(() => {
    envMock.STOREFRONT_URL = O;
    cfConfig.mockImplementation(() => ({ zoneId: 'z', apiToken: 't' }));
    purgeSpy.mockReset(); purgeSpy.mockResolvedValue(true);
    hostSpy.mockReset(); hostSpy.mockResolvedValue(true);
    _setPurgeRetryPolicyForTest({ attemptTimeoutMs: 20, backoffBaseMs: 1 });
  });
  afterEach(() => _setPurgeRetryPolicyForTest());

  it('blog publish/edit/delete purges the post, /blog/ and / (and the sitemaps)', () => {
    onBlogContentChanged('acme', ['hello']);
    const urls = purgeSpy.mock.calls[0]![1] as string[];
    expect(urls).toEqual(expect.arrayContaining([`${O}/blog/hello/`, `${O}/blog/`, `${O}/`]));
    expect(hostSpy).not.toHaveBeenCalled();
  });

  it('collection create/update/delete/membership purges the collection page and /shop/', () => {
    onCollectionChanged('acme', ['summer', 'summer']);
    const urls = purgeSpy.mock.calls[0]![1] as string[];
    expect(urls).toEqual(expect.arrayContaining([`${O}/collections/summer/`, `${O}/shop/`]));
    expect(urls.filter((u) => u.endsWith('/collections/summer/'))).toHaveLength(1);
  });

  it('theme/identity/CSP settings purge everything for the host (host purge, no URL list)', async () => {
    onStoreShellConfigChanged('acme');
    await vi.waitFor(() => expect(hostSpy).toHaveBeenCalledWith('acme', ['acme.example.com']));
    expect(purgeSpy).not.toHaveBeenCalled();
  });

  it('maintenance toggle purges everything for the host and resolves purged', async () => {
    await expect(purgeHostForMaintenance('acme')).resolves.toBe('purged');
    expect(hostSpy).toHaveBeenCalledWith('acme', ['acme.example.com']);
  });

  it('product content edit purges the standard set + the product page; price has no purge entry point', () => {
    onCatalogCacheChanged('acme', { productPath: '/products/w/' });
    expect(purgeSpy.mock.calls[0]![1]).toEqual(expect.arrayContaining([`${O}/`, `${O}/shop/`, `${O}/products/w/`]));
  });

  it('skips (no failure, no call) without origin or Cloudflare config', async () => {
    cfConfig.mockImplementation(() => null);
    await expect(runPurge('collection', 'acme', { urls: [`${O}/x/`] })).resolves.toBe('skipped');
    expect(purgeSpy).not.toHaveBeenCalled();
    expect(errError).not.toHaveBeenCalled();
  });

  it('retries a rejected purge and succeeds without alerting', async () => {
    purgeSpy.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(runPurge('blog-content', 'acme', { urls: [`${O}/`] })).resolves.toBe('purged');
    expect(purgeSpy).toHaveBeenCalledTimes(3);
    expect(errError).not.toHaveBeenCalled();
  });

  it('retries a thrown error and a hung call (timeout)', async () => {
    purgeSpy.mockRejectedValueOnce(new Error('boom')).mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(true);
    await expect(runPurge('blog-content', 'acme', { urls: [`${O}/`] })).resolves.toBe('purged');
    expect(purgeSpy).toHaveBeenCalledTimes(3);
  });

  it('after the final failure logs ONE structured error line carrying the alert key', async () => {
    purgeSpy.mockResolvedValue(false);
    await expect(runPurge('collection', 'acme', { urls: [`${O}/shop/`] })).resolves.toBe('failed');
    expect(purgeSpy).toHaveBeenCalledTimes(3);
    expect(errError).toHaveBeenCalledTimes(1);
    expect(errError.mock.calls[0]![0]).toBe('cache purge failed after retries');
    expect(errError.mock.calls[0]![2]).toMatchObject({ alert: 'cache_purge_failed', event: 'collection', storeSlug: 'acme', mode: 'urls', urlCount: 1, attempts: 3 });
  });

  it('K-3: a trigger over the URL threshold falls back to one host purge instead of many URL calls', async () => {
    const urls = Array.from({ length: PURGE_URL_FALLBACK_THRESHOLD + 1 }, (_, i) => `${O}/collections/c${i}/`);
    expect(planPurge({ urls })).toEqual({ mode: 'host', reason: 'over-threshold' });
    await expect(runPurge('collection', 'acme', { urls })).resolves.toBe('purged');
    expect(hostSpy).toHaveBeenCalledTimes(1);
    expect(purgeSpy).not.toHaveBeenCalled();
  });

  it('K-3: exactly the threshold stays a URL purge (deduplicated)', () => {
    const urls = Array.from({ length: PURGE_URL_FALLBACK_THRESHOLD }, (_, i) => `${O}/p${i}/`);
    expect(planPurge({ urls: [...urls, urls[0]!] })).toEqual({ mode: 'urls', urls });
  });
});
