import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above top-level const/let declarations — see
// manifest/stock-hook.test.ts for the same vi.hoisted pattern.
const { envMock, errError, purgeSpy } = vi.hoisted(() => ({
  envMock: {} as Record<string, string | undefined>,
  errError: vi.fn(),
  purgeSpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../env.js', () => ({ env: envMock }));
vi.mock('../lib/logger.js', () => ({ log: { info: vi.fn() }, err: { error: (...a: unknown[]) => errError(...a) } }));
vi.mock('./cloudflare-purge.js', () => ({ purgeCloudflareUrls: (...a: unknown[]) => purgeSpy(...a) }));

import { onCatalogCacheChanged } from './purge-hook.js';

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

  it('also purges the specific product page when productSlug is given', () => {
    envMock.STOREFRONT_URL = 'https://acme.example.com';
    onCatalogCacheChanged('acme', { productSlug: 'widget' });
    expect(purgeSpy).toHaveBeenCalledWith('acme', expect.arrayContaining(['https://acme.example.com/products/widget/']));
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
