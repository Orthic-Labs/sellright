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
import { apiErrorSchema, errJson } from '../lib/api-error.js';
import { seoConfigFromStore } from '../seo/config.js';
import { listBlogSitemapEntries, listCollectionSitemapEntries, listProductSitemapEntries, productAvailability } from '../seo/queries.js';
import { blogSitemapXml, collectionsSitemapXml, mainSitemapXml, productsSitemapXml, sitemapIndexNames, sitemapIndexXml } from '../seo/sitemap.js';
import { robotsTxt } from '../seo/robots.js';
import { organizationSchema, productSchema, websiteSchema } from '../seo/jsonld.js';

export const seo = new OpenAPIHono();

const XML = { 200: { description: 'XML', content: { 'application/xml': { schema: z.string() } } } };
const errResponses = { 503: { description: 'siteUrl not configured', content: { 'application/json': { schema: apiErrorSchema() } } } };

function xml(c: { body: (b: string, s: number, h: Record<string, string>) => Response }, body: string) {
  return c.body(body, 200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=300' });
}

seo.openapi(
  createRoute({ method: 'get', path: '/v1/shop/seo/sitemap.xml', summary: 'Sitemap index', responses: { ...XML, ...errResponses } }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return errJson(c, 503, 'SITE_URL_NOT_CONFIGURED', 'siteUrl not configured for this store');
    // Only advertise the collection sitemap when the store publishes
    // collections — storefronts without collection pages serve no
    // /sitemap-collections.xml, and a 404 in the index is a crawl error.
    const collections = await withStore(st.id, (tx) => listCollectionSitemapEntries(tx, st.id));
    return xml(c, sitemapIndexXml(config.siteUrl, sitemapIndexNames(collections.length > 0)));
  },
);

seo.openapi(
  createRoute({ method: 'get', path: '/v1/shop/seo/sitemap-main.xml', summary: 'Static-page sitemap', responses: { ...XML, ...errResponses } }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return errJson(c, 503, 'SITE_URL_NOT_CONFIGURED', 'siteUrl not configured for this store');
    return xml(c, mainSitemapXml(config.siteUrl, config.staticPaths));
  },
);

seo.openapi(
  createRoute({ method: 'get', path: '/v1/shop/seo/sitemap-products.xml', summary: 'Product sitemap', responses: { ...XML, ...errResponses } }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return errJson(c, 503, 'SITE_URL_NOT_CONFIGURED', 'siteUrl not configured for this store');
    const entries = await withStore(st.id, (tx) => listProductSitemapEntries(tx, st.id));
    return xml(c, productsSitemapXml(config.siteUrl, entries, config.productUrlPattern));
  },
);

seo.openapi(
  createRoute({ method: 'get', path: '/v1/shop/seo/sitemap-collections.xml', summary: 'Collection sitemap', responses: { ...XML, ...errResponses } }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return errJson(c, 503, 'SITE_URL_NOT_CONFIGURED', 'siteUrl not configured for this store');
    const entries = await withStore(st.id, (tx) => listCollectionSitemapEntries(tx, st.id));
    return xml(c, collectionsSitemapXml(config.siteUrl, entries));
  },
);

seo.openapi(
  createRoute({ method: 'get', path: '/v1/shop/seo/sitemap-blog.xml', summary: 'Blog sitemap', responses: { ...XML, ...errResponses } }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return errJson(c, 503, 'SITE_URL_NOT_CONFIGURED', 'siteUrl not configured for this store');
    const entries = await withStore(st.id, (tx) => listBlogSitemapEntries(tx, st.id));
    return xml(c, blogSitemapXml(config.siteUrl, entries));
  },
);

seo.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/seo/robots.txt', summary: 'robots.txt',
    responses: { 200: { description: 'robots.txt', content: { 'text/plain': { schema: z.string() } } }, ...errResponses },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return errJson(c, 503, 'SITE_URL_NOT_CONFIGURED', 'siteUrl not configured for this store');
    return c.text(robotsTxt(config.siteUrl, config.robotsDisallow, config.robots), 200, { 'cache-control': 'public, max-age=300' });
  },
);

const JsonLd = z.record(z.string(), z.unknown());

seo.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/seo/jsonld/organization', summary: 'Organization + WebSite JSON-LD',
    responses: { 200: { description: 'JSON-LD', content: { 'application/json': { schema: z.object({ items: z.array(JsonLd) }) } } }, ...errResponses },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return errJson(c, 503, 'SITE_URL_NOT_CONFIGURED', 'siteUrl not configured for this store');
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
      404: { description: 'Not found', content: { 'application/json': { schema: apiErrorSchema() } } },
      503: { description: 'siteUrl not configured', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.siteUrl) return errJson<503, Record<never, never>>(c, 503, 'SITE_URL_NOT_CONFIGURED', 'siteUrl not configured for this store');
    const { slug } = c.req.valid('param');
    // Explicit empty extra-field type keeps the handler's return type shallow (this route's 200 body is an open record).
    const product = await withStore(st.id, (tx) => productAvailability(tx, st.config, st.currency, slug, st.id));
    if (!product) return errJson<404, Record<never, never>>(c, 404, 'PRODUCT_NOT_FOUND', 'not found');
    const schema = productSchema(config, product);
    // never cache — offers.price/availability are live-stock derived (org-wide "never cache stock" rule)
    return c.json((schema ?? {}) as Record<string, unknown>, 200, { 'cache-control': 'no-store' });
  },
);

seo.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/seo/indexnow-key.txt', summary: 'IndexNow key-file body',
    responses: {
      200: { description: 'Key file body (proxy this at /{key}.txt on the storefront domain)', content: { 'text/plain': { schema: z.string() } } },
      404: { description: 'IndexNow not configured', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const config = seoConfigFromStore(st);
    if (!config.indexNowKey) return errJson(c, 404, 'INDEXNOW_NOT_CONFIGURED', 'IndexNow is not configured for this store');
    return c.text(config.indexNowKey, 200, { 'cache-control': 'public, max-age=3600' });
  },
);
