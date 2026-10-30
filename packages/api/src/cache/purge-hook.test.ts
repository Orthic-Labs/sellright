import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('./cloudflare-purge.js', () => ({ purgeCloudflareUrls: (...a: unknown[]) => purgeSpy(...a), resolveCloudflareConfig: () => cfConfig() }));

import { onCatalogCacheChanged, purgeAfterPublish } from './purge-hook.js';

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
    const { onBlogContentChanged } = await import('./purge-hook.js');
    envMock.STOREFRONT_URL = 'https://acme.example.com';
    purgeSpy.mockReset();
    purgeSpy.mockResolvedValue(true);
    onBlogContentChanged('acme', ['old-slug', 'new slug', 'old-slug']);
    expect(purgeSpy).toHaveBeenCalledWith('acme', ['https://acme.example.com/blog/', 'https://acme.example.com/sitemap-blog.xml', 'https://acme.example.com/sitemap.xml', 'https://acme.example.com/blog/old-slug/', 'https://acme.example.com/blog/new%20slug/']);
  });
});
