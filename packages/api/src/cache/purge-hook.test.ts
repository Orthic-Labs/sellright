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

import { onBlogContentChanged, onCatalogCacheChanged, onCollectionChanged, onStoreShellConfigChanged, planPurge, purgeAfterPublish, purgeHostForMaintenance, PURGE_MAX_ATTEMPTS, PURGE_URL_FALLBACK_THRESHOLD, runPurge, _setPurgeRetryPolicyForTest } from './purge-hook.js';

beforeEach(() => {
  for (const k of Object.keys(envMock)) delete envMock[k];
  errError.mockClear();
  purgeSpy.mockClear();
});

describe('onCatalogCacheChanged (no catalog published: purge at once)', () => {
  const O = 'https://acme.example.com';
  beforeEach(() => {
    cfConfig.mockImplementation(() => ({ zoneId: 'z', apiToken: 't' }));
    purgeSpy.mockReset(); purgeSpy.mockResolvedValue(true);
    hostSpy.mockReset(); hostSpy.mockResolvedValue(true);
    _setPurgeRetryPolicyForTest({ attemptTimeoutMs: 20, backoffBaseMs: 1 });
  });
  afterEach(() => _setPurgeRetryPolicyForTest());

  it('I-4: purges the product page, /, /shop/, every collection page listing it and the sitemaps', () => {
    envMock.STOREFRONT_URL = O;
    onCatalogCacheChanged('acme', { productPath: '/shop/widget/', collectionSlugs: ['summer', 'new in', 'summer'] });
    expect(purgeSpy).toHaveBeenCalledWith('acme', [
      `${O}/`, `${O}/shop/`, `${O}/sitemap.xml`, `${O}/sitemap-products.xml`,
      `${O}/shop/widget/`,
      `${O}/sitemap-collections.xml`, `${O}/collections/summer/`, `${O}/collections/new%20in/`,
    ]);
    expect(hostSpy).not.toHaveBeenCalled();
  });

  it('a product in no collection still purges its page, / and /shop/', () => {
    envMock.STOREFRONT_URL = O;
    onCatalogCacheChanged('acme', { productPath: '/products/w/', collectionSlugs: [] });
    expect(purgeSpy.mock.calls[0]![1]).toEqual([`${O}/`, `${O}/shop/`, `${O}/sitemap.xml`, `${O}/sitemap-products.xml`, `${O}/products/w/`]);
  });

  it('falls back to a host purge when the affected set is unknown (no collection set or no product path)', async () => {
    envMock.STOREFRONT_URL = O;
    onCatalogCacheChanged('acme', { productPath: '/products/w/' });
    onCatalogCacheChanged('acme', { collectionSlugs: ['summer'] });
    onCatalogCacheChanged('acme');
    await vi.waitFor(() => expect(hostSpy).toHaveBeenCalledTimes(3));
    expect(hostSpy).toHaveBeenCalledWith('acme', ['acme.example.com']);
    expect(purgeSpy).not.toHaveBeenCalled();
  });

  it('falls back to a host purge past the URL threshold', async () => {
    envMock.STOREFRONT_URL = O;
    const collectionSlugs = Array.from({ length: PURGE_URL_FALLBACK_THRESHOLD }, (_, i) => `c${i}`);
    onCatalogCacheChanged('acme', { productPath: '/products/w/', collectionSlugs });
    await vi.waitFor(() => expect(hostSpy).toHaveBeenCalledTimes(1));
    expect(purgeSpy).not.toHaveBeenCalled();
  });

  it('prefers a per-store origin override and strips a trailing slash', () => {
    envMock.STOREFRONT_URL = 'https://fallback.example.com';
    envMock.STOREFRONT_ORIGIN_BY_STORE = 'acme=https://acme-brand.com/';
    onCatalogCacheChanged('acme', { productPath: '/products/w/', collectionSlugs: [] });
    const urls = purgeSpy.mock.calls[0]![1] as string[];
    expect(urls).toContain('https://acme-brand.com/');
    expect(urls.some((u) => u.includes('//shop') || u.includes('//products'))).toBe(false);
  });

  it('never throws when STOREFRONT_URL is missing — no-ops', () => {
    expect(() => onCatalogCacheChanged('acme')).not.toThrow();
    expect(purgeSpy).not.toHaveBeenCalled();
    expect(hostSpy).not.toHaveBeenCalled();
  });
});

describe('purgeAfterPublish (N9 / F5)', () => {
  const O = 'https://acme.example.com';
  beforeEach(() => {
    cfConfig.mockImplementation(() => ({ zoneId: 'z', apiToken: 't' }));
    purgeSpy.mockReset(); hostSpy.mockReset(); hostSpy.mockResolvedValue(true);
    _setPurgeRetryPolicyForTest({ attemptTimeoutMs: 20, backoffBaseMs: 1 });
  });
  afterEach(() => _setPurgeRetryPolicyForTest());

  it('purges the standard set, every affected product page and its collection pages', async () => {
    envMock.STOREFRONT_URL = O;
    purgeSpy.mockResolvedValueOnce(true);
    await expect(purgeAfterPublish('acme', { productPaths: ['/products/old/', '/products/new/', '/products/new/'], collectionSlugs: ['summer'] })).resolves.toBe('purged');
    const urls = purgeSpy.mock.calls[0]![1] as string[];
    expect(urls).toEqual(expect.arrayContaining([`${O}/`, `${O}/shop/`, `${O}/products/old/`, `${O}/products/new/`, `${O}/collections/summer/`]));
    expect(urls.filter((u) => u.endsWith('/products/new/'))).toHaveLength(1);
  });

  it('an unknown affected set (full rebuild) purges the whole host', async () => {
    envMock.STOREFRONT_URL = O;
    await expect(purgeAfterPublish('acme', null)).resolves.toBe('purged');
    expect(hostSpy).toHaveBeenCalledWith('acme', ['acme.example.com']);
    expect(purgeSpy).not.toHaveBeenCalled();
  });

  it('is skipped (not failed) without an origin or Cloudflare config', async () => {
    await expect(purgeAfterPublish('acme', null)).resolves.toBe('skipped');
    envMock.STOREFRONT_URL = O;
    cfConfig.mockImplementation(() => null);
    await expect(purgeAfterPublish('acme', { productPaths: [], collectionSlugs: [] })).resolves.toBe('skipped');
    expect(purgeSpy).not.toHaveBeenCalled();
    expect(hostSpy).not.toHaveBeenCalled();
  });

  it('retries a rejected purge (PURGE_MAX_ATTEMPTS) and succeeds without alerting', async () => {
    envMock.STOREFRONT_URL = O;
    purgeSpy.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(purgeAfterPublish('acme', { productPaths: ['/products/a/'], collectionSlugs: [] })).resolves.toBe('purged');
    expect(purgeSpy).toHaveBeenCalledTimes(PURGE_MAX_ATTEMPTS);
    expect(errError).not.toHaveBeenCalled();
  });

  it('bounds hung attempts by the per-attempt timeout, then reports failed with ONE cache_purge_failed alert', async () => {
    envMock.STOREFRONT_URL = O;
    purgeSpy.mockImplementation(() => new Promise(() => {}));
    await expect(purgeAfterPublish('acme', { productPaths: ['/products/a/'], collectionSlugs: [] })).resolves.toBe('failed');
    expect(purgeSpy).toHaveBeenCalledTimes(PURGE_MAX_ATTEMPTS);
    expect(errError).toHaveBeenCalledTimes(1);
    expect(errError.mock.calls[0]![2]).toMatchObject({ alert: 'cache_purge_failed', event: 'product-content', storeSlug: 'acme', mode: 'urls', attempts: PURGE_MAX_ATTEMPTS, last: 'timeout' });
  });

  it('a failed host fallback also alerts and reports failed', async () => {
    envMock.STOREFRONT_URL = O;
    hostSpy.mockResolvedValue(false);
    await expect(purgeAfterPublish('acme', null)).resolves.toBe('failed');
    expect(hostSpy).toHaveBeenCalledTimes(PURGE_MAX_ATTEMPTS);
    expect(errError.mock.calls[0]![2]).toMatchObject({ alert: 'cache_purge_failed', event: 'product-content', mode: 'host', reason: 'everything' });
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

  it('product content edit purges the product page, /, /shop/ and its collections; price has no purge entry point', () => {
    onCatalogCacheChanged('acme', { productPath: '/products/w/', collectionSlugs: ['summer'] });
    expect(purgeSpy.mock.calls[0]![1]).toEqual(expect.arrayContaining([`${O}/`, `${O}/shop/`, `${O}/products/w/`, `${O}/collections/summer/`]));
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
