import type { RequestHandler } from '@qwik.dev/router';

// Thin proxies to the SellRight API's own SEO routes (packages/api
// src/routes/seo.ts) — the API is the source of truth for sitemaps, robots.txt,
// and the IndexNow key file; this storefront never reconstructs them locally.
const API = import.meta.env.VITE_SELLRIGHT_API_URL || 'http://127.0.0.1:3300';
const STORE = import.meta.env.VITE_SELLRIGHT_STORE_SLUG || 'demo';

async function proxy(path: string): Promise<{ status: number; body: string; contentType: string }> {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { 'x-store-slug': STORE, accept: '*/*' },
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.text();
    return { status: res.status, body, contentType: res.headers.get('content-type') || 'text/plain; charset=utf-8' };
  } catch {
    return { status: 503, body: '', contentType: 'text/plain; charset=utf-8' };
  }
}

export type SitemapKind = 'index' | 'main' | 'products' | 'blog' | 'collections';

const SITEMAP_PATH: Record<SitemapKind, string> = {
  index: '/v1/shop/seo/sitemap.xml',
  main: '/v1/shop/seo/sitemap-main.xml',
  products: '/v1/shop/seo/sitemap-products.xml',
  blog: '/v1/shop/seo/sitemap-blog.xml',
  collections: '/v1/shop/seo/sitemap-collections.xml',
};

export function sitemapHandler(kind: SitemapKind): RequestHandler {
  return async ({ send, headers }) => {
    const { status, body, contentType } = await proxy(SITEMAP_PATH[kind]);
    headers.set('Content-Type', contentType);
    headers.set('Cache-Control', status === 200 ? 'public, max-age=300' : 'no-store');
    send(status === 200 ? 200 : 503, body || '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
  };
}

export const robotsHandler: RequestHandler = async ({ send, headers }) => {
  const { status, body, contentType } = await proxy('/v1/shop/seo/robots.txt');
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', status === 200 ? 'public, max-age=300' : 'no-store');
  send(status === 200 ? 200 : 503, body || 'User-agent: *\nDisallow: /\n');
};

/** GET /{key}.txt IndexNow key-file — key value/existence is entirely backend
 *  config (`config.indexNowKey` on the store row); this route never hardcodes
 *  a key. Returns null when IndexNow isn't configured or the path doesn't match. */
export async function indexNowKeyFile(requestedFile: string): Promise<{ status: number; body: string } | null> {
  const { status, body } = await proxy('/v1/shop/seo/indexnow-key.txt');
  if (status !== 200 || !body.trim()) return null;
  const key = body.trim();
  if (requestedFile !== `${key}.txt`) return null;
  return { status: 200, body: key };
}

/** The IndexNow key VALUE, straight from backend store config — never an env
 *  var. Used by the /indexnow webhook + manual-submit routes to build the
 *  IndexNow API payload and keyLocation URL; `null` when not configured. */
export async function getIndexNowKey(): Promise<string | null> {
  const { status, body } = await proxy('/v1/shop/seo/indexnow-key.txt');
  if (status !== 200) return null;
  const key = body.trim();
  return key || null;
}

/** Organization + WebSite JSON-LD, live from backend store config — never
 *  generated locally (the storefront has no theme-derived org data of its
 *  own that's more current than the backend's). */
export async function jsonLdOrganization(): Promise<Record<string, unknown>[]> {
  const { status, body } = await proxy('/v1/shop/seo/jsonld/organization');
  if (status !== 200 || !body) return [];
  try {
    const parsed = JSON.parse(body) as { items?: Record<string, unknown>[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

/** Product JSON-LD for one slug — offers.price/availability are live-stock
 *  derived on the backend (org-wide "never cache stock" rule), so this is
 *  fetched per-request, never cached here either. Returns null on any
 *  failure (missing product, siteUrl not configured, network error) so the
 *  page still renders without a broken/stale schema. */
export async function jsonLdProduct(slug: string): Promise<Record<string, unknown> | null> {
  const { status, body } = await proxy(`/v1/shop/seo/jsonld/products/${encodeURIComponent(slug)}`);
  if (status !== 200 || !body) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}
