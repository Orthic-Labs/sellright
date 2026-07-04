import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, ilike, inArray, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { HttpError, J, errBody, money, Page, requireAdmin, requireStore, requireWrite, guard } from './admin-helpers.js';

export const adminProducts = new OpenAPIHono();

// ── products: list / detail / edit; variants: price / stock ─────────────────
adminProducts.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/products', summary: 'List products',
    request: { query: z.object({ q: z.string().optional(), status: z.string().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }) },
    responses: { 200: { description: 'OK', content: J(Page) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { q, status, page, pageSize } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const conds = [sql`${s.product.deletedAt} is null`] as never[];
      if (q) conds.push(ilike(s.product.name, `%${q}%`) as never);
      if (status) conds.push(sql`${s.product.status} = ${status}` as never);
      const where = and(...conds);
      const rows = await tx
        .select({
          id: s.product.id, slug: s.product.slug, name: s.product.name, status: s.product.status,
          assetPath: s.asset.path,
          variants: sql<number>`(select count(*) from product_variant pv where pv.product_id = ${s.product.id} and pv.deleted_at is null)::int`,
          minPrice: sql<number | null>`(select min(coalesce(pv.sale_price, pv.price)) from product_variant pv where pv.product_id = ${s.product.id} and pv.deleted_at is null)::int`,
          stock: sql<number>`coalesce((select sum(st.on_hand - st.allocated) from product_variant pv join stock st on st.variant_id = pv.id where pv.product_id = ${s.product.id} and pv.deleted_at is null),0)::int`,
        })
        .from(s.product)
        .leftJoin(s.asset, eq(s.asset.id, s.product.featuredAssetId))
        .where(where)
        .orderBy(s.product.name)
        .limit(pageSize).offset((page - 1) * pageSize);
      const [cnt] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.product).where(where);
      return { items: rows, total: cnt?.n ?? 0, page, pageSize };
    });
    return c.json(out, 200);
  }),
);

adminProducts.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/products/{id}', summary: 'Product detail',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { id } = c.req.valid('param');
    const out = await withStore(st.storeId, async (tx) => {
      const [p] = await tx.select().from(s.product).where(eq(s.product.id, id)).limit(1);
      if (!p) return null;
      let assetPath: string | null = null;
      if (p.featuredAssetId) {
        const [a] = await tx.select({ path: s.asset.path }).from(s.asset).where(eq(s.asset.id, p.featuredAssetId)).limit(1);
        assetPath = a?.path ?? null;
      }
      const variants = await tx
        .select({
          id: s.productVariant.id,
          sku: s.productVariant.sku,
          name: s.productVariant.name,
          price: s.productVariant.price,
          salePrice: s.productVariant.salePrice,
          enabled: s.productVariant.enabled,
          fulfillmentType: s.productVariant.fulfillmentType,
          appKey: s.productVariant.appKey,
          artifactKey: s.productVariant.artifactKey,
          licenseSeats: s.productVariant.licenseSeats,
          licenseDurationDays: s.productVariant.licenseDurationDays,
          updatesDurationDays: s.productVariant.updatesDurationDays,
          onHand: s.stock.onHand,
          allocated: s.stock.allocated,
        })
        .from(s.productVariant)
        .leftJoin(s.stock, eq(s.stock.variantId, s.productVariant.id))
        .where(and(eq(s.productVariant.productId, id), sql`${s.productVariant.deletedAt} is null`))
        .orderBy(s.productVariant.name);
      // WP8c: gallery images (product_asset) + per-variant option assignments.
      const gallery = await tx
        .select({ assetId: s.productAsset.assetId, path: s.asset.path, position: s.productAsset.position })
        .from(s.productAsset)
        .innerJoin(s.asset, eq(s.asset.id, s.productAsset.assetId))
        .where(eq(s.productAsset.productId, id))
        .orderBy(s.productAsset.position);
      const vIds = variants.map((v) => v.id);
      const vopts = vIds.length
        ? await tx.select({ variantId: s.variantOption.variantId, optionId: s.variantOption.optionId }).from(s.variantOption).where(inArray(s.variantOption.variantId, vIds))
        : [];
      return {
        id: p.id, slug: p.slug, name: p.name, description: p.description, status: p.status, assetPath, featuredAssetId: p.featuredAssetId,
        images: gallery.map((g) => ({ assetId: g.assetId, path: g.path, url: `/assets/${g.path}`, position: g.position })),
        variants: variants.map((v) => ({ ...v, onHand: v.onHand ?? 0, allocated: v.allocated ?? 0, available: (v.onHand ?? 0) - (v.allocated ?? 0), optionIds: vopts.filter((o) => o.variantId === v.id).map((o) => o.optionId) })),
      };
    });
    if (!out) throw new HttpError(404, 'product not found');
    return c.json(out, 200);
  }),
);

adminProducts.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/products/{id}', summary: 'Update product',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ name: z.string().optional(), description: z.string().nullable().optional(), status: z.enum(['draft', 'active']).optional(), vendor: z.string().nullable().optional(), productType: z.string().nullable().optional(), tags: z.array(z.string()).nullable().optional(), seoTitle: z.string().nullable().optional(), seoDescription: z.string().nullable().optional(), metafields: z.record(z.string(), z.any()).nullable().optional(), featuredAssetId: z.guid().nullable().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const ok = await withStore(st.storeId, async (tx) => {
      const [p] = await tx.select({ id: s.product.id, status: s.product.status }).from(s.product).where(eq(s.product.id, id)).limit(1);
      if (!p) return false;
      await tx.update(s.product).set({ ...patch, updatedAt: new Date() }).where(eq(s.product.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'product', entityId: id, action: 'update', fromState: p.status, toState: patch.status ?? p.status, data: patch });
      return true;
    });
    if (!ok) throw new HttpError(404, 'product not found');
    return c.json({ id }, 200);
  }),
);

adminProducts.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/variants/{id}', summary: 'Update variant price/availability',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({
      price: money.optional(),
      salePrice: money.nullable().optional(),
      compareAtPrice: money.nullable().optional(),
      cost: money.nullable().optional(),
      barcode: z.string().nullable().optional(),
      weightG: z.number().int().nullable().optional(),
      dimensions: z.record(z.string(), z.any()).nullable().optional(),
      metafields: z.record(z.string(), z.any()).nullable().optional(),
      enabled: z.boolean().optional(),
      fulfillmentType: z.enum(['physical', 'digital_download', 'license', 'update_pass']).optional(),
      appKey: z.string().nullable().optional(),
      artifactKey: z.string().nullable().optional(),
      licenseSeats: z.number().int().min(1).max(100).optional(),
      licenseDurationDays: z.number().int().positive().max(36500).nullable().optional(),
      updatesDurationDays: z.number().int().positive().max(36500).nullable().optional(),
    })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const ok = await withStore(st.storeId, async (tx) => {
      const [v] = await tx.select({ id: s.productVariant.id }).from(s.productVariant).where(eq(s.productVariant.id, id)).limit(1);
      if (!v) return false;
      await tx.update(s.productVariant).set({ ...patch, updatedAt: new Date() }).where(eq(s.productVariant.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'variant', entityId: id, action: 'update', data: patch });
      return true;
    });
    if (!ok) throw new HttpError(404, 'variant not found');
    return c.json({ id }, 200);
  }),
);

adminProducts.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/variants/{id}/stock', summary: 'Set variant on-hand stock',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ onHand: z.number().int().min(0) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), onHand: z.number().int() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { id } = c.req.valid('param');
    const { onHand } = c.req.valid('json');
    const ok = await withStore(st.storeId, async (tx) => {
      const [cur] = await tx.select().from(s.stock).where(eq(s.stock.variantId, id)).limit(1);
      if (cur) {
        const delta = onHand - cur.onHand;
        await tx.update(s.stock).set({ onHand }).where(eq(s.stock.variantId, id));
        if (delta !== 0) await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: id, delta, reason: 'admin_adjust' });
      } else {
        const [v] = await tx.select({ id: s.productVariant.id }).from(s.productVariant).where(eq(s.productVariant.id, id)).limit(1);
        if (!v) return false;
        await tx.insert(s.stock).values({ variantId: id, storeId: st.storeId, onHand, allocated: 0 });
        await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: id, delta: onHand, reason: 'admin_adjust' });
      }
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'variant', entityId: id, action: 'stock', data: { onHand } });
      return true;
    });
    if (!ok) throw new HttpError(404, 'variant not found');
    return c.json({ id, onHand }, 200);
  }),
);

