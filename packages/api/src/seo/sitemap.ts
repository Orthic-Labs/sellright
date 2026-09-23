/**
 * SEO-1: pure XML builders — no DB, no fetch, fully unit-testable. Route
 * handlers (routes/seo.ts) supply the data; these functions only serialize.
 */
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

export function productsSitemapXml(siteUrl: string, entries: SitemapEntry[]): string {
  return urlsetXml(siteUrl, entries.map((e) => ({ path: `/products/${encodeURIComponent(e.slug)}/`, lastmod: e.lastmod })));
}

export function collectionsSitemapXml(siteUrl: string, entries: SitemapEntry[]): string {
  return urlsetXml(siteUrl, entries.map((e) => ({ path: `/collections/${encodeURIComponent(e.slug)}/`, lastmod: e.lastmod })));
}

export function blogSitemapXml(siteUrl: string, entries: SitemapEntry[]): string {
  return urlsetXml(siteUrl, entries.map((e) => ({ path: `/blog/${encodeURIComponent(e.slug)}/`, lastmod: e.lastmod })));
}
