import { describe, expect, it } from 'vitest';
import { blogSitemapXml, collectionsSitemapXml, escapeXml, mainSitemapXml, productsSitemapXml, sitemapIndexXml, urlsetXml } from './sitemap.js';

describe('escapeXml', () => {
  it('escapes all five XML-significant characters', () => {
    expect(escapeXml(`<a>&"'</a>`)).toBe('&lt;a&gt;&amp;&quot;&apos;&lt;/a&gt;');
  });
});

describe('urlsetXml', () => {
  it('emits a valid urlset with loc + optional lastmod', () => {
    const xml = urlsetXml('https://example.com', [
      { path: '/a/', lastmod: '2026-01-01T00:00:00.000Z' },
      { path: '/b/' },
    ]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<url><loc>https://example.com/a/</loc><lastmod>2026-01-01T00:00:00.000Z</lastmod></url>');
    expect(xml).toContain('<url><loc>https://example.com/b/</loc></url>');
  });

  it('escapes special characters inside a slug path', () => {
    const xml = urlsetXml('https://example.com', [{ path: '/products/foo&bar/' }]);
    expect(xml).toContain('/products/foo&amp;bar/');
    expect(xml).not.toContain('foo&bar/</loc>'); // raw ampersand never lands in output
  });
});

describe('sitemapIndexXml', () => {
  it('links each named sitemap file under the site origin', () => {
    const xml = sitemapIndexXml('https://example.com', ['sitemap-main.xml', 'sitemap-products.xml']);
    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://example.com/sitemap-main.xml</loc>');
    expect(xml).toContain('<loc>https://example.com/sitemap-products.xml</loc>');
  });
});

describe('mainSitemapXml / productsSitemapXml / collectionsSitemapXml / blogSitemapXml', () => {
  it('build /products/, /collections/, /blog/ paths from slug entries', () => {
    expect(productsSitemapXml('https://example.com', [{ slug: 'widget', lastmod: null }])).toContain('<loc>https://example.com/products/widget/</loc>');
    expect(collectionsSitemapXml('https://example.com', [{ slug: 'sale', lastmod: null }])).toContain('<loc>https://example.com/collections/sale/</loc>');
    expect(blogSitemapXml('https://example.com', [{ slug: 'hello-world', lastmod: null }])).toContain('<loc>https://example.com/blog/hello-world/</loc>');
  });

  it('URL-encodes slugs that need it', () => {
    expect(productsSitemapXml('https://example.com', [{ slug: 'a b', lastmod: null }])).toContain('/products/a%20b/');
  });

  it('mainSitemapXml lists exactly the configured static paths', () => {
    const xml = mainSitemapXml('https://example.com', ['/', '/about/']);
    expect(xml).toContain('<loc>https://example.com/</loc>');
    expect(xml).toContain('<loc>https://example.com/about/</loc>');
  });
});
