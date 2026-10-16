/**
 * G11: admin preview of the generated sitemaps — pure (no DB, no fetch). The
 * route (routes/admin-seo.ts) loads the same entries the public sitemap routes
 * (routes/seo.ts) load and this module lists them with the same path builders,
 * so the preview cannot drift from what crawlers are served.
 */
import {
  blogSitemapPaths, collectionsSitemapPaths, mainSitemapPaths, productsSitemapPaths, sitemapIndexNames,
  type SitemapPath,
} from './sitemap.js';
import type { SitemapEntry } from './queries.js';

export const SITEMAP_PREVIEW_URL_LIMIT = 2000;

export interface SitemapPreviewFile {
  /** e.g. sitemap-products.xml */
  name: string;
  /** Absolute public URL of the sitemap file. */
  url: string;
  kind: 'main' | 'products' | 'collections' | 'blog';
  /** Total URLs in the file (not capped). */
  count: number;
  /** First SITEMAP_PREVIEW_URL_LIMIT URLs. */
  urls: Array<{ loc: string; lastmod: string | null }>;
  truncated: boolean;
}

export interface SitemapPreview {
  siteUrl: string;
  /** Absolute URL of the index. */
  indexUrl: string;
  /** Files listed in the index, in index order. */
  files: SitemapPreviewFile[];
  totalUrls: number;
}

export interface SitemapInputs {
  staticPaths: string[];
  productUrlPattern: string;
  products: SitemapEntry[];
  collections: SitemapEntry[];
  blog: SitemapEntry[];
}

export function buildSitemapPreview(siteUrl: string, input: SitemapInputs, limit: number = SITEMAP_PREVIEW_URL_LIMIT): SitemapPreview {
  const sources: Record<SitemapPreviewFile['kind'], { name: string; paths: SitemapPath[] }> = {
    main: { name: 'sitemap-main.xml', paths: mainSitemapPaths(input.staticPaths) },
    products: { name: 'sitemap-products.xml', paths: productsSitemapPaths(input.products, input.productUrlPattern) },
    collections: { name: 'sitemap-collections.xml', paths: collectionsSitemapPaths(input.collections) },
    blog: { name: 'sitemap-blog.xml', paths: blogSitemapPaths(input.blog) },
  };
  const byName = new Map(Object.entries(sources).map(([kind, v]) => [v.name, { kind: kind as SitemapPreviewFile['kind'], paths: v.paths }]));

  const files: SitemapPreviewFile[] = sitemapIndexNames(input.collections.length > 0).map((name) => {
    const { kind, paths } = byName.get(name)!;
    return {
      name, url: `${siteUrl}/${name}`, kind, count: paths.length,
      urls: paths.slice(0, limit).map((p) => ({ loc: siteUrl + p.path, lastmod: p.lastmod ?? null })),
      truncated: paths.length > limit,
    };
  });
  return { siteUrl, indexUrl: `${siteUrl}/sitemap.xml`, files, totalUrls: files.reduce((a, f) => a + f.count, 0) };
}

/** Every URL the sitemaps list, de-duplicated (what an IndexNow submission would send). */
export function allSitemapUrls(input: SitemapInputs, siteUrl: string): string[] {
  const p = buildSitemapPreview(siteUrl, input, Number.MAX_SAFE_INTEGER);
  return [...new Set(p.files.flatMap((f) => f.urls.map((u) => u.loc)))];
}

/** Public URLs to purge from the edge cache on refresh: the index plus EVERY sitemap file name,
 *  including the collections file when it is currently unlisted (a cached copy must not outlive its removal). */
export function sitemapPurgeUrls(preview: SitemapPreview): string[] {
  return [preview.indexUrl, ...sitemapIndexNames(true).map((n) => `${preview.siteUrl}/${n}`)];
}
