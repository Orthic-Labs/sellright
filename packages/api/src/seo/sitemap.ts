/**
 * SEO-1: pure XML builders — no DB, no fetch, fully unit-testable. Route
 * handlers (routes/seo.ts) supply the data; these functions only serialize.
 */
import { DEFAULT_PRODUCT_URL_PATTERN, productPath } from './config.js';
import type { SitemapEntry } from './queries.js';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';
const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

/** Escapes the five XML-significant characters. Space is intentionally left
 *  alone — callers pass already-encodeURIComponent'd path segments where a
 *  literal space could appear (it won't, in practice, but this mirrors the
 *  narrower, more correct escaping a spec-compliant XML writer needs). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function urlEntry(loc: string, lastmod: string | null): string {
  const lastmodTag = lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : '';
  return `<url><loc>${escapeXml(loc)}</loc>${lastmodTag}</url>`;
}

/** `siteUrl` is the canonical origin (no trailing slash — see seo/config.ts::seoConfigFromStore). */
export function urlsetXml(siteUrl: string, paths: { path: string; lastmod?: string | null }[]): string {
  const body = paths.map((p) => urlEntry(siteUrl + p.path, p.lastmod ?? null)).join('');
  return `${XML_HEADER}<urlset xmlns="${SITEMAP_NS}">${body}</urlset>`;
}

export function sitemapIndexXml(siteUrl: string, sitemapFilenames: string[]): string {
  const body = sitemapFilenames.map((name) => `<sitemap><loc>${escapeXml(`${siteUrl}/${name}`)}</loc></sitemap>`).join('');
  return `${XML_HEADER}<sitemapindex xmlns="${SITEMAP_NS}">${body}</sitemapindex>`;
}

export function mainSitemapXml(siteUrl: string, staticPaths: string[]): string {
  return urlsetXml(siteUrl, staticPaths.map((path) => ({ path })));
}

// Path builders — shared by the XML serializers below and the admin sitemap
// preview (seo/sitemap-preview.ts), so what the admin sees is exactly what is served.
export type SitemapPath = { path: string; lastmod?: string | null };
export const mainSitemapPaths = (staticPaths: string[]): SitemapPath[] => staticPaths.map((path) => ({ path }));
export const productsSitemapPaths = (entries: SitemapEntry[], productUrlPattern: string = DEFAULT_PRODUCT_URL_PATTERN): SitemapPath[] =>
  entries.map((e) => ({ path: productPath({ productUrlPattern }, e.slug), lastmod: e.lastmod }));
export const collectionsSitemapPaths = (entries: SitemapEntry[]): SitemapPath[] =>
  entries.map((e) => ({ path: `/collections/${encodeURIComponent(e.slug)}/`, lastmod: e.lastmod }));
export const blogSitemapPaths = (entries: SitemapEntry[]): SitemapPath[] =>
  entries.map((e) => ({ path: `/blog/${encodeURIComponent(e.slug)}/`, lastmod: e.lastmod }));

/** Filenames listed in the sitemap index. The collection sitemap is only
 *  advertised when the store publishes collections — a 404 in the index is a crawl error. */
export const sitemapIndexNames = (hasCollections: boolean): string[] =>
  ['sitemap-main.xml', 'sitemap-products.xml', ...(hasCollections ? ['sitemap-collections.xml'] : []), 'sitemap-blog.xml'];

export function productsSitemapXml(siteUrl: string, entries: SitemapEntry[], productUrlPattern: string = DEFAULT_PRODUCT_URL_PATTERN): string {
  return urlsetXml(siteUrl, productsSitemapPaths(entries, productUrlPattern));
}

export function collectionsSitemapXml(siteUrl: string, entries: SitemapEntry[]): string {
  return urlsetXml(siteUrl, collectionsSitemapPaths(entries));
}

export function blogSitemapXml(siteUrl: string, entries: SitemapEntry[]): string {
  return urlsetXml(siteUrl, blogSitemapPaths(entries));
}
