import { describe, expect, it } from 'vitest';
import { allSitemapUrls, buildSitemapPreview, sitemapPurgeUrls, type SitemapInputs } from './sitemap-preview.js';
import { productsSitemapXml } from './sitemap.js';

const input: SitemapInputs = {
  staticPaths: ['/', '/about/'],
  productUrlPattern: '/shop/{slug}/',
  products: [{ slug: 'a b', lastmod: '2026-10-01T00:00:00.000Z' }, { slug: 'c', lastmod: null }],
  collections: [],
  blog: [{ slug: 'post', lastmod: null }],
};
const SITE = 'https://x.example';

describe('sitemap preview', () => {
  it('lists the same files as the public index, with counts and absolute URLs', () => {
    const p = buildSitemapPreview(SITE, input);
    expect(p.indexUrl).toBe(`${SITE}/sitemap.xml`);
    expect(p.files.map((f) => [f.name, f.count])).toEqual([['sitemap-main.xml', 2], ['sitemap-products.xml', 2], ['sitemap-blog.xml', 1]]);
    expect(p.totalUrls).toBe(5);
    expect(p.files[1]!.urls[0]).toEqual({ loc: `${SITE}/shop/a%20b/`, lastmod: '2026-10-01T00:00:00.000Z' });
  });

  it('is generated from the same paths as the served XML', () => {
    const served = productsSitemapXml(SITE, input.products, input.productUrlPattern);
    for (const u of buildSitemapPreview(SITE, input).files[1]!.urls) expect(served).toContain(`<loc>${u.loc}</loc>`);
  });

  it('advertises the collections file only when collections exist, but always purges it', () => {
    const withCol = buildSitemapPreview(SITE, { ...input, collections: [{ slug: 'k', lastmod: null }] });
    expect(withCol.files.map((f) => f.name)).toContain('sitemap-collections.xml');
    const without = buildSitemapPreview(SITE, input);
    expect(without.files.map((f) => f.name)).not.toContain('sitemap-collections.xml');
    expect(sitemapPurgeUrls(without)).toContain(`${SITE}/sitemap-collections.xml`);
    expect(sitemapPurgeUrls(without)[0]).toBe(`${SITE}/sitemap.xml`);
  });

  it('caps listed URLs per file but keeps the true count', () => {
    const many = { ...input, products: Array.from({ length: 5 }, (_, i) => ({ slug: `p${i}`, lastmod: null })) };
    const f = buildSitemapPreview(SITE, many, 2).files[1]!;
    expect(f).toMatchObject({ count: 5, truncated: true });
    expect(f.urls).toHaveLength(2);
    expect(allSitemapUrls(many, SITE)).toHaveLength(2 + 5 + 1);
  });
});
