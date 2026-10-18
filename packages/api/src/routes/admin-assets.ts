/**
 * Asset upload + management (WP8). Storage: local disk under ASSET_DIR,
 * nginx-served at /assets/<path> with long cache. asset.path is a relative
 * key (<storeSlug>/YYYY/MM/<uuid>.webp) so a future S3/R2 swap is drop-in.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MiddlewareHandler } from 'hono';
import { sql, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { afterCommit } from '../db/after-commit.js';
import { env } from '../env.js';
import { AssetImageError, reencodeAssetImage, withAssetImageSlot } from '../lib/asset-image.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireWrite, guard } from './admin-helpers.js';
import * as s from '../db/schema.js';

const MAX_BYTES = 10 * 1024 * 1024;
/** App-wide body cap for this one route (app.ts): the file limit plus multipart framing / the alt field. */
export const ASSET_UPLOAD_LIMIT_BYTES = MAX_BYTES + 256 * 1024;

export const adminAssets = new OpenAPIHono();

/** Mounted by app.ts before bodyLimit & OpenAPI's multipart validator can read the body. */
export const assetUploadAdmission: MiddlewareHandler = async (c, next) => guard(c, async () => {
  const { admin } = await requireAdmin(c);
  requireWrite(requireStore(admin, c));
  const declaredLen = Number(c.req.header('content-length') ?? '0');
  if (declaredLen > MAX_BYTES) throw new HttpError(413, `max ${MAX_BYTES / 1024 / 1024}MB`);
  try {
    await withAssetImageSlot(next);
  } catch (error) {
    if (error instanceof AssetImageError) {
      if (error.status === 503) c.header('Retry-After', '1');
      throw new HttpError(error.status, error.message);
    }
    throw error;
  }
});

// POST /v1/admin/assets — multipart upload (field "file"; optional "alt")
adminAssets.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/assets', summary: 'Upload an image asset',
    request: { body: { required: true, content: { 'multipart/form-data': { schema: z.object({ file: z.instanceof(File).openapi({ type: 'string', format: 'binary' }), alt: z.string().optional() }) } } } },
    responses: {
      201: { description: 'Created', content: J(z.object({ id: z.string(), path: z.string(), url: z.string(), width: z.number().int().nullable(), height: z.number().int().nullable(), alt: z.string().nullable() })) },
      400: { description: 'Bad request', ...errBody },
      413: { description: 'Too large', ...errBody },
      415: { description: 'Unsupported format', ...errBody },
      503: { description: 'Image processing busy; retry shortly', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    try {
      const body = c.req.valid('form');
      const file = body['file'];
      if (!(file instanceof File)) throw new HttpError(400, 'file required (multipart field "file")');
      if (file.size > MAX_BYTES) throw new HttpError(413, `max ${MAX_BYTES / 1024 / 1024}MB`);
      const buf = Buffer.from(await file.arrayBuffer());
      const image = await reencodeAssetImage(buf);

      const yyyymm = new Date().toISOString().slice(0, 7);
      const key = `${st.slug}/${yyyymm}/${randomUUID()}.webp`;
      const absDir = path.join(env.ASSET_DIR, st.slug, yyyymm);
      await fs.mkdir(absDir, { recursive: true });
      const absPath = path.join(env.ASSET_DIR, key);
      try {
        await fs.writeFile(absPath, image.data);
        const alt = ((body['alt']?.toString() ?? '').trim().slice(0, 1000)) || null;
        const id = randomUUID();
        await withStore(st.storeId, (tx) =>
          tx.insert(s.asset).values({ id, storeId: st.storeId, type: 'image', path: key, width: image.width, height: image.height, alt }).returning());
        return c.json({ id, path: key, url: `/assets/${key}`, width: image.width, height: image.height, alt }, 201);
      } catch (error) {
        await fs.rm(absPath, { force: true }).catch(() => { /* preserve the original failure */ });
        throw error;
      }
    } catch (error) {
      if (error instanceof AssetImageError) {
        throw new HttpError(error.status, error.message);
      }
      throw error;
    }
  }),
);

// GET /v1/admin/assets — paged list for a picker.
adminAssets.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/assets', summary: 'List assets',
    request: { query: z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) }) },
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()), total: z.number().int() })) } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { page, pageSize } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const rows = await tx.select({ id: s.asset.id, path: s.asset.path, width: s.asset.width, height: s.asset.height, alt: s.asset.alt, createdAt: s.asset.createdAt }).from(s.asset).orderBy(s.asset.createdAt).limit(pageSize).offset((page - 1) * pageSize);
      const [cnt] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.asset);
      return { items: rows, total: cnt?.n ?? 0 };
    });
    return c.json({ items: out.items.map((r) => ({ ...r, url: `/assets/${r.path}` })), total: out.total }, 200);
  }),
);

// DELETE /v1/admin/assets/{id} — refuses if referenced.
adminAssets.openapi(
  createRoute({
    method: 'delete', path: '/v1/admin/assets/{id}', summary: 'Delete an asset (refuses if referenced)',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Referenced', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const res = await withStore(st.storeId, async (tx) => {
      const [a] = await tx.select().from(s.asset).where(eq(s.asset.id, id)).limit(1);
      if (!a) return { kind: 'notfound' as const };
      // Sum the reference counts across the 5 FKs into a single typed scalar.
      // Drizzle's `tx.execute` returns a raw driver row which is awkward to cast
      // per-driver, so we collapse this into a typed sum() over a UNION ALL of
      // tiny 1-row subqueries. SQL stays identical, type is `number`.
      // The `.where(eq(s.asset.id, id))` keeps the outer query to 1 row so the
      // scalar subqueries only run once (no asset-table scan).
      const refCountRow = await tx
        .select({
          refCount: sql<number>`(
            (select count(*) from product where featured_asset_id = ${id})
          + (select count(*) from product_asset where asset_id = ${id})
          + (select count(*) from variant_asset where asset_id = ${id})
          + (select count(*) from collection where image_asset_id = ${id})
          + (select count(*) from blog_post where featured_asset_id = ${id})
          )::int`,
        })
        .from(s.asset)
        .where(eq(s.asset.id, id))
        .limit(1);
      const refCount = refCountRow[0]?.refCount ?? 0;
      if (refCount > 0) return { kind: 'referenced' as const };
      await tx.delete(s.asset).where(eq(s.asset.id, id));
      afterCommit(tx, () => {
        fs.rm(path.join(env.ASSET_DIR, a.path), { force: true }).catch(() => { /* best-effort */ });
      });
      return { kind: 'ok' as const };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'asset not found');
    if (res.kind === 'referenced') throw new HttpError(409, 'asset is referenced by a product/variant/collection; remove the reference first');
    return c.json({ ok: true }, 200);
  }),
);
