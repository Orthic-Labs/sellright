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
import { invalidateStoreCache } from '../store-context.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireWrite, requireManage, guard } from './admin-helpers.js';
import { DEFAULT_ROBOTS_DISALLOW, DEFAULT_STATIC_PATHS, seoConfigFromStore, type SeoConfigPatch } from '../seo/config.js';
import { submitIndexNowUrls } from '../seo/indexnow.js';

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
  invalidateStoreCache(slug);
  return nextSeo;
}

const seoConfigOut = z.object({
  siteUrl: z.string().nullable(),
  contactEmail: z.string().nullable(),
  organization: z.object({ name: z.string(), logo: z.string().nullable(), sameAs: z.array(z.string()) }),
  robotsDisallow: z.array(z.string()),
  staticPaths: z.array(z.string()),
  indexNowConfigured: z.boolean(),
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
  indexNowKey: z.string().regex(/^[a-f0-9]{8,128}$/i).nullable().optional(),
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
      if (patch.indexNowKey !== undefined) next.indexNow = { ...(seo.indexNow as object | undefined), key: patch.indexNowKey };
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
