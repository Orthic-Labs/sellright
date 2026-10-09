/**
 * SEO-1: admin surface for the generic per-store SEO config
 * (store.config.seo — see seo/config.ts) and admin-triggered IndexNow
 * submission. Deliberately its own route file/config-mutation helper rather
 * than extending admin-settings.ts's `mutateStoreConfig` (private, not
 * exported there) — this task owns only new files, not admin-settings.ts.
 *
 * IndexNow submission is admin-triggered (a dedicated endpoint the operator
 * or admin UI calls after publishing), not an automatic hook wired into
 * admin-catalog.ts / admin-content.ts's publish paths — this task doesn't
 * own those files either.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { broadcastStoreCacheInvalidation } from '../store-context.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireWrite, requireManage, guard } from './admin-helpers.js';
import { DEFAULT_ROBOTS_DISALLOW, DEFAULT_STATIC_PATHS, isProductUrlPattern, seoConfigFromStore, type SeoConfigPatch } from '../seo/config.js';
import { submitIndexNowUrls } from '../seo/indexnow.js';
import { listBlogSitemapEntries, listCollectionSitemapEntries, listProductSitemapEntries } from '../seo/queries.js';
import { allSitemapUrls, buildSitemapPreview, sitemapPurgeUrls, type SitemapInputs } from '../seo/sitemap-preview.js';
import { purgeCloudflareUrls, resolveCloudflareConfig } from '../cache/cloudflare-purge.js';

export const adminSeo = new OpenAPIHono();

/** Same read-modify-write-under-row-lock shape as admin-settings.ts's
 *  mutateStoreConfig, scoped to the `seo` sub-object so an admin editing SEO
 *  settings can't clobber concurrent writes to `payments`/`pricing`/etc. */
async function mutateSeoConfig(storeId: string, actor: string, mutate: (seo: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>> {
  const { slug, nextSeo } = await withStore(storeId, async (tx) => {
    const [row] = await tx.select({ slug: s.store.slug, config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).for('update').limit(1);
    const prevConfig = (row?.config as Record<string, unknown> | null) ?? {};
    const prevSeo = (prevConfig.seo as Record<string, unknown> | undefined) ?? {};
    const nextSeo = mutate(prevSeo);
    const nextConfig = { ...prevConfig, seo: nextSeo };
    await tx.update(s.store).set({ config: nextConfig }).where(eq(s.store.id, storeId));
    // SR-16: durable audit record. seo config carries no secrets (indexNowKey
    // is a public verification token by design — IndexNow publishes it at a
    // world-readable URL), so the full before/after is safe to log.
    await tx.insert(s.auditLog).values({ storeId, actor, entity: 'store', entityId: storeId, action: 'seo_config_updated', fromState: JSON.stringify(prevSeo), toState: JSON.stringify(nextSeo) });
    return { slug: row!.slug, nextSeo };
  });
  await broadcastStoreCacheInvalidation(slug);
  return nextSeo;
}

const seoConfigOut = z.object({
  siteUrl: z.string().nullable(),
  contactEmail: z.string().nullable(),
  organization: z.object({ name: z.string(), logo: z.string().nullable(), sameAs: z.array(z.string()) }),
  robotsDisallow: z.array(z.string()),
  staticPaths: z.array(z.string()),
  productUrlPattern: z.string(),
  indexNowConfigured: z.boolean(),
  // The IndexNow key is a public verification token (served at /<key>.txt), so
  // returning it is not a secret leak; the admin SEO page masks it by default.
  indexNowKey: z.string().nullable(),
  robots: z.object({ header: z.array(z.string()).optional(), directives: z.array(z.string()).optional(), extra: z.string().nullable().optional(), sitemaps: z.array(z.string()).optional(), footer: z.string().nullable().optional() }),
});

adminSeo.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/seo/config', summary: 'Effective SEO config for the current store',
    responses: { 200: { description: 'OK', content: J(seoConfigOut) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const [row] = await withStore(st.storeId, (tx) => tx.select({ name: s.store.name, config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1));
    const config = seoConfigFromStore(row!);
    return c.json({ ...config, indexNowConfigured: config.indexNowKey != null }, 200);
  }),
);

const patchBody = z.object({
  siteUrl: z.string().url().nullable().optional(),
  contactEmail: z.string().email().nullable().optional(),
  organization: z.object({ name: z.string().optional(), logo: z.string().url().nullable().optional(), sameAs: z.array(z.string().url()).optional() }).optional(),
  robotsDisallow: z.array(z.string()).optional(),
  staticPaths: z.array(z.string()).optional(),
  productUrlPattern: z.string().refine(isProductUrlPattern, 'must be an absolute path containing {slug}, e.g. /shop/{slug}/').nullable().optional(),
  indexNowKey: z.string().regex(/^[a-f0-9]{8,128}$/i).nullable().optional(),
  robotsHeader: z.array(z.string().max(500)).optional(),
  robotsDirectives: z.array(z.string().max(500)).optional(),
  robotsExtra: z.string().max(16_384).nullable().optional(),
  robotsSitemaps: z.array(z.string().regex(/^\/?[A-Za-z0-9._\/-]+$/)).optional(),
  robotsFooter: z.string().max(16_384).nullable().optional(),
});

adminSeo.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/seo/config', summary: 'Update SEO config',
    request: { body: { content: J(patchBody) } },
    responses: { 200: { description: 'OK', content: J(seoConfigOut) }, 401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireManage(st);
    const patch: SeoConfigPatch = c.req.valid('json');
    await mutateSeoConfig(st.storeId, admin.email, (seo) => {
      const next: Record<string, unknown> = { ...seo };
      if (patch.siteUrl !== undefined) next.siteUrl = patch.siteUrl;
      if (patch.contactEmail !== undefined) next.contactEmail = patch.contactEmail;
      if (patch.organization !== undefined) next.organization = { ...(seo.organization as object | undefined), ...patch.organization };
      if (patch.robotsDisallow !== undefined) next.robotsDisallow = patch.robotsDisallow.length ? patch.robotsDisallow : [...DEFAULT_ROBOTS_DISALLOW];
      if (patch.staticPaths !== undefined) next.staticPaths = patch.staticPaths.length ? patch.staticPaths : [...DEFAULT_STATIC_PATHS];
      if (patch.productUrlPattern !== undefined) next.productUrlPattern = patch.productUrlPattern ?? undefined;
      if (patch.indexNowKey !== undefined) next.indexNow = { ...(seo.indexNow as object | undefined), key: patch.indexNowKey };
      for (const k of ['robotsHeader', 'robotsDirectives', 'robotsExtra', 'robotsSitemaps', 'robotsFooter'] as const) {
        if (patch[k] !== undefined) next[k] = patch[k] ?? undefined;
      }
      return next;
    });
    const [row] = await withStore(st.storeId, (tx) => tx.select({ name: s.store.name, config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1));
    const config = seoConfigFromStore(row!);
    return c.json({ ...config, indexNowConfigured: config.indexNowKey != null }, 200);
  }),
);

const submitBody = z.object({ urls: z.array(z.string().url()).min(1).max(10_000) });

adminSeo.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/seo/indexnow/submit', summary: 'Submit URLs to IndexNow (admin-triggered, e.g. after publishing a product/blog post)',
    request: { body: { content: J(submitBody) } },
    responses: {
      200: { description: 'OK', content: J(z.object({ ok: z.boolean(), status: z.number().optional(), error: z.string().optional() })) },
      401: { description: 'Unauthorized', ...errBody },
      403: { description: 'Forbidden', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { urls } = c.req.valid('json');
    const [row] = await withStore(st.storeId, (tx) => tx.select({ name: s.store.name, config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1));
    const config = seoConfigFromStore(row!);
    // Outbound call only when the store has a key configured — otherwise this
    // is a documented no-op, never a silent network attempt.
    if (!config.indexNowKey) throw new HttpError(409, 'IndexNow is not configured for this store — set indexNowKey via PATCH /v1/admin/seo/config first');
    const result = await submitIndexNowUrls(config, urls);
    return c.json(result, 200);
  }),
);

// ── G11: sitemap preview + refresh ───────────────────────────────────────────
// Sitemaps are generated live from the database on every request (routes/seo.ts),
// so there is nothing to "rebuild". Refresh therefore means: drop the copies the
// CDN may still hold (Cloudflare purge, when configured) and optionally tell
// search engines (IndexNow, when a key is configured).

async function loadSitemapInputs(storeId: string, config: ReturnType<typeof seoConfigFromStore>): Promise<SitemapInputs> {
  return withStore(storeId, async (tx) => ({
    staticPaths: config.staticPaths,
    productUrlPattern: config.productUrlPattern,
    products: await listProductSitemapEntries(tx, storeId),
    collections: await listCollectionSitemapEntries(tx, storeId),
    blog: await listBlogSitemapEntries(tx, storeId),
  }));
}

const previewFile = z.object({
  name: z.string(), url: z.string(), kind: z.enum(['main', 'products', 'collections', 'blog']), count: z.number().int(),
  urls: z.array(z.object({ loc: z.string(), lastmod: z.string().nullable() })), truncated: z.boolean(),
});
const sitemapsOut = z.object({
  configured: z.boolean(),
  siteUrl: z.string().nullable(),
  indexUrl: z.string().nullable(),
  totalUrls: z.number().int(),
  files: z.array(previewFile),
  indexNowConfigured: z.boolean(),
  cloudflareConfigured: z.boolean(),
});

adminSeo.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/seo/sitemaps', summary: 'Preview the generated sitemaps (files, URL counts and URLs)',
    responses: { 200: { description: 'OK', content: J(sitemapsOut) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const [row] = await withStore(st.storeId, (tx) => tx.select({ name: s.store.name, config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1));
    const config = seoConfigFromStore(row!);
    const flags = { indexNowConfigured: config.indexNowKey != null, cloudflareConfigured: resolveCloudflareConfig(st.slug) != null };
    if (!config.siteUrl) return c.json({ configured: false, siteUrl: null, indexUrl: null, totalUrls: 0, files: [], ...flags }, 200);
    const preview = buildSitemapPreview(config.siteUrl, await loadSitemapInputs(st.storeId, config));
    return c.json({ configured: true, siteUrl: preview.siteUrl, indexUrl: preview.indexUrl, totalUrls: preview.totalUrls, files: preview.files, ...flags }, 200);
  }),
);

const refreshOut = z.object({
  totalUrls: z.number().int(),
  cdn: z.object({ configured: z.boolean(), purged: z.boolean(), urls: z.array(z.string()) }),
  indexNow: z.object({ attempted: z.boolean(), submitted: z.number().int(), ok: z.boolean().nullable(), status: z.number().int().nullable(), error: z.string().nullable() }),
});

adminSeo.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/seo/sitemaps/refresh', summary: 'Refresh sitemaps: purge the CDN copies and optionally submit every sitemap URL to IndexNow',
    request: { body: { content: J(z.object({ indexNow: z.boolean().default(false) })) } },
    responses: {
      200: { description: 'OK', content: J(refreshOut) },
      409: { description: 'siteUrl not configured, or IndexNow requested without a key', ...errBody },
      401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { indexNow } = c.req.valid('json');
    const [row] = await withStore(st.storeId, (tx) => tx.select({ name: s.store.name, config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1));
    const config = seoConfigFromStore(row!);
    if (!config.siteUrl) throw new HttpError(409, 'siteUrl is not configured for this store — set it via PATCH /v1/admin/seo/config first');
    if (indexNow && !config.indexNowKey) throw new HttpError(409, 'IndexNow is not configured for this store — set indexNowKey via PATCH /v1/admin/seo/config first');

    const inputs = await loadSitemapInputs(st.storeId, config);
    const preview = buildSitemapPreview(config.siteUrl, inputs, 0);

    // purgeCloudflareUrls never throws; false covers both "no Cloudflare config" and "rejected".
    const cdnConfigured = resolveCloudflareConfig(st.slug) != null;
    const purgeUrls = sitemapPurgeUrls(preview);
    const purged = cdnConfigured ? await purgeCloudflareUrls(st.slug, purgeUrls) : false;

    let indexNowOut = { attempted: false, submitted: 0, ok: null as boolean | null, status: null as number | null, error: null as string | null };
    if (indexNow) {
      // IndexNow caps one submission at 10,000 URLs.
      const urls = allSitemapUrls(inputs, config.siteUrl).slice(0, 10_000);
      const r = await submitIndexNowUrls(config, urls);
      indexNowOut = { attempted: true, submitted: r.ok ? urls.length : 0, ok: r.ok, status: r.status ?? null, error: r.error ?? null };
    }

    await withStore(st.storeId, (tx) => tx.insert(s.auditLog).values({
      storeId: st.storeId, actor: admin.email, entity: 'store', entityId: st.storeId, action: 'sitemaps_refreshed',
      data: { totalUrls: preview.totalUrls, cdnConfigured, cdnPurged: purged, indexNow: indexNowOut },
    }));
    return c.json({ totalUrls: preview.totalUrls, cdn: { configured: cdnConfigured, purged, urls: purgeUrls }, indexNow: indexNowOut }, 200);
  }),
);
