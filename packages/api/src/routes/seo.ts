/**
 * SEO-1: generic, per-store public SEO surface — sitemaps, robots.txt,
 * JSON-LD, and the IndexNow key file. Any storefront a store is bound to can
 * proxy these instead of building sitemap/robots/JSON-LD logic itself (the
 * approach RightSites' storefront previously took by deriving sitemaps from
 * /v1/shop/catalog/* on every request — this centralizes that logic once,
 * store-config-driven, with no hardcoded domain anywhere in this file).
 *
 * Store resolution matches every other shop route (resolveStoreFromCtx —
 * x-store-slug header or Host, see routes/store-context.ts). A store with no
 * seo.siteUrl / config.storefrontUrl configured gets a 503 from the
 * URL-dependent endpoints (sitemaps, robots, JSON-LD) rather than emitting
 * broken relative-origin URLs — same fail-loud posture as DOWNLOAD_URL_SECRET
 * elsewhere in this codebase.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { withStore } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import { seoConfigFromStore } from '../seo/config.js';
import { listBlogSitemapEntries, listCollectionSitemapEntries, listProductSitemapEntries, productAvailability } from '../seo/queries.js';
import { blogSitemapXml, collectionsSitemapXml, mainSitemapXml, productsSitemapXml, sitemapIndexXml } from '../seo/sitemap.js';
import { robotsTxt } from '../seo/robots.js';
import { organizationSchema, productSchema, websiteSchema } from '../seo/jsonld.js';

export const seo = new OpenAPIHono();

const XML = { 200: { description: 'XML', content: { 'application/xml': { schema: z.string() } } } };
const errJson = { 503: { description: 'siteUrl not configured', content: { 'application/json': { schema: z.object({ error: z.string() }) } } } };

function xml(c: { body: (b: string, s: number, h: Record<string, string>) => Response }, body: string) {
  return c.body(body, 200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=300' });
}

seo.openapi(
  createRoute({ method: 'get', path: '/v1/shop/seo/sitemap.xml', summary: 'Sitemap index', responses: { ...XML, ...errJson } }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return c.json({ error: 'siteUrl not configured for this store' }, 503);
    return xml(c, sitemapIndexXml(config.siteUrl, ['sitemap-main.xml', 'sitemap-products.xml', 'sitemap-collections.xml', 'sitemap-blog.xml']));
  },
);

seo.openapi(
  createRoute({ method: 'get', path: '/v1/shop/seo/sitemap-main.xml', summary: 'Static-page sitemap', responses: { ...XML, ...errJson } }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return c.json({ error: 'siteUrl not configured for this store' }, 503);
    return xml(c, mainSitemapXml(config.siteUrl, config.staticPaths));
  },
);

seo.openapi(
  createRoute({ method: 'get', path: '/v1/shop/seo/sitemap-products.xml', summary: 'Product sitemap', responses: { ...XML, ...errJson } }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return c.json({ error: 'siteUrl not configured for this store' }, 503);
    const entries = await withStore(st.id, (tx) => listProductSitemapEntries(tx, st.id));
    return xml(c, productsSitemapXml(config.siteUrl, entries));
  },
);

seo.openapi(
  createRoute({ method: 'get', path: '/v1/shop/seo/sitemap-collections.xml', summary: 'Collection sitemap', responses: { ...XML, ...errJson } }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return c.json({ error: 'siteUrl not configured for this store' }, 503);
    const entries = await withStore(st.id, (tx) => listCollectionSitemapEntries(tx, st.id));
    return xml(c, collectionsSitemapXml(config.siteUrl, entries));
  },
);

seo.openapi(
  createRoute({ method: 'get', path: '/v1/shop/seo/sitemap-blog.xml', summary: 'Blog sitemap', responses: { ...XML, ...errJson } }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return c.json({ error: 'siteUrl not configured for this store' }, 503);
    const entries = await withStore(st.id, (tx) => listBlogSitemapEntries(tx, st.id));
    return xml(c, blogSitemapXml(config.siteUrl, entries));
  },
);

seo.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/seo/robots.txt', summary: 'robots.txt',
    responses: { 200: { description: 'robots.txt', content: { 'text/plain': { schema: z.string() } } }, ...errJson },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return c.json({ error: 'siteUrl not configured for this store' }, 503);
    return c.text(robotsTxt(config.siteUrl, config.robotsDisallow), 200, { 'cache-control': 'public, max-age=300' });
  },
);

const JsonLd = z.record(z.string(), z.unknown());

seo.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/seo/jsonld/organization', summary: 'Organization + WebSite JSON-LD',
    responses: { 200: { description: 'JSON-LD', content: { 'application/json': { schema: z.object({ items: z.array(JsonLd) }) } } }, ...errJson },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return c.json({ error: 'siteUrl not configured for this store' }, 503);
    const items = [organizationSchema(config), websiteSchema(config)].filter((x): x is Record<string, unknown> => x != null);
    return c.json({ items }, 200, { 'cache-control': 'public, max-age=300' });
  },
);

seo.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/seo/jsonld/products/{slug}', summary: 'Product JSON-LD (live price + stock)',
    request: { params: z.object({ slug: z.string() }) },
    responses: {
      200: { description: 'JSON-LD', content: { 'application/json': { schema: JsonLd } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      ...errJson,
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return c.json({ error: 'siteUrl not configured for this store' }, 503);
    const { slug } = c.req.valid('param');
    const product = await withStore(st.id, (tx) => productAvailability(tx, st.config, st.currency, slug, st.id));
    if (!product) return c.json({ error: 'not found' }, 404);
    const schema = productSchema(config, product);
    // never cache — offers.price/availability are live-stock derived (org-wide "never cache stock" rule)
    return c.json(schema ?? {}, 200, { 'cache-control': 'no-store' });
  },
);

seo.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/seo/indexnow-key.txt', summary: 'IndexNow key-file body',
    responses: {
      200: { description: 'Key file body (proxy this at /{key}.txt on the storefront domain)', content: { 'text/plain': { schema: z.string() } } },
      404: { description: 'IndexNow not configured', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.indexNowKey) return c.json({ error: 'IndexNow is not configured for this store' }, 404);
    return c.text(config.indexNowKey, 200, { 'cache-control': 'public, max-age=3600' });
  },
);
