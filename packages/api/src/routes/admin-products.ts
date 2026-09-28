import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { emitProductChanged, emitVariantProductChanged } from '../webhooks/catalog.js';
import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { HttpError, J, errBody, money, Page, requireAdmin, requireStore, requireWrite, guard } from './admin-helpers.js';
import { onStockChanged } from '../manifest/stock-hook.js';

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
          isPreOrder: s.productVariant.isPreOrder,
          preOrderPrice: s.productVariant.preOrderPrice,
          shipDate: s.productVariant.shipDate,
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
      await emitProductChanged(tx, st.storeId, id);
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
      isPreOrder: z.boolean().optional(),
      preOrderPrice: money.min(0).nullable().optional(),
      shipDate: z.iso.datetime({ offset: true }).nullable().optional(),
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
      await tx.update(s.productVariant).set({ ...patch, shipDate: patch.shipDate === undefined ? undefined : patch.shipDate === null ? null : new Date(patch.shipDate), updatedAt: new Date() }).where(eq(s.productVariant.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'variant', entityId: id, action: 'update', data: patch });
      await emitVariantProductChanged(tx, st.storeId, id);
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
        if (delta !== 0) await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: id, delta, reason: 'admin_adjust', actor: admin.email });
      } else {
        const [v] = await tx.select({ id: s.productVariant.id }).from(s.productVariant).where(eq(s.productVariant.id, id)).limit(1);
        if (!v) return false;
        await tx.insert(s.stock).values({ variantId: id, storeId: st.storeId, onHand, allocated: 0 });
        await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: id, delta: onHand, reason: 'admin_adjust', actor: admin.email });
      }
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'variant', entityId: id, action: 'stock', data: { onHand } });
      await emitVariantProductChanged(tx, st.storeId, id);
      return true;
    });
    if (!ok) throw new HttpError(404, 'variant not found');
    // Zero-cache stock rule: regenerate the manifest immediately, after this
    // commit — never inside the transaction above (a later throw would roll
    // the write back and the manifest would lie about a stock level that
    // never actually landed).
    // Single variant known precisely — scope the manifest regen to just its product.
    onStockChanged(st.slug, [id]);
    return c.json({ id, onHand }, 200);
  }),
);

adminProducts.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/variants/stock/bulk', summary: 'Set on-hand stock for many variants in one transaction',
    request: { body: { content: J(z.object({
      items: z.array(z.object({ id: z.string(), onHand: z.number().int().min(0) })).min(1).max(500),
    })) } },
    responses: {
      200: { description: 'OK', content: J(z.object({ updated: z.array(z.object({ id: z.string(), onHand: z.number().int() })) })) },
      404: { description: 'One or more variants not found (nothing written — atomic)', content: J(z.object({ error: z.string(), missing: z.array(z.string()) })) },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { items } = c.req.valid('json');
    // De-dupe by variant id — last write for a given id in the payload wins,
    // same as if the caller had sent two separate single-variant PATCHes in a
    // row. Prevents two rows in the request racing each other inside the loop.
    const byId = new Map(items.map((i) => [i.id, i.onHand]));
    const ids = [...byId.keys()];

    const updated = await withStore(st.storeId, async (tx) => {
      // Whole bulk write is one transaction: validate every id up front so a
      // typo/stale row aborts the ENTIRE batch (nothing partially applied)
      // rather than silently skipping it mid-loop.
      const knownVariants = await tx.select({ id: s.productVariant.id }).from(s.productVariant)
        .where(and(inArray(s.productVariant.id, ids), sql`${s.productVariant.deletedAt} is null`));
      const knownIds = new Set(knownVariants.map((v) => v.id));
      const missing = ids.filter((id) => !knownIds.has(id));
      if (missing.length) throw new HttpError(404, `variant(s) not found: ${missing.join(', ')}`);

      const existingStock = await tx.select().from(s.stock).where(inArray(s.stock.variantId, ids));
      const stockByVariant = new Map(existingStock.map((row) => [row.variantId, row]));

      const out: { id: string; onHand: number }[] = [];
      for (const id of ids) {
        const onHand = byId.get(id)!;
        const cur = stockByVariant.get(id);
        if (cur) {
          const delta = onHand - cur.onHand;
          await tx.update(s.stock).set({ onHand }).where(eq(s.stock.variantId, id));
          if (delta !== 0) await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: id, delta, reason: 'admin_bulk_adjust', actor: admin.email });
        } else {
          await tx.insert(s.stock).values({ variantId: id, storeId: st.storeId, onHand, allocated: 0 });
          await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: id, delta: onHand, reason: 'admin_bulk_adjust', actor: admin.email });
        }
        await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'variant', entityId: id, action: 'stock', data: { onHand, bulk: true } });
        await emitVariantProductChanged(tx, st.storeId, id);
        out.push({ id, onHand });
      }
      return out;
    });

    // Zero-cache stock rule: regenerate the manifest immediately, after this
    // commit, exactly once for the whole batch — never inside the transaction
    // above (a later throw would roll the write back). Matches the single-
    // variant PATCH above: fires unconditionally on success, delta or not.
    // onStockChanged's own state machine (manifest/stock-hook.ts) already
    // collapses concurrent triggers into a single trailing rerun, so one call
    // after N variant writes is correct, not a missed update.
    // Exact variant set for this batch is known — scope the regen to just their products.
    onStockChanged(st.slug, ids);
    return c.json({ updated }, 200);
  }),
);

// ── stock adjustments: +/- delta with a mandatory reason (admin-essentials) ──
// Distinct from PATCH /variants/{id}/stock above (which SETS an absolute
// on-hand value for the inline editor/CSV-style bulk-set UI and stays as-is
// for that caller). This route is the "why did this number change" primitive:
// every call is a signed delta, every call requires a reason, and every call
// is one more row in stock_movement — never an edit of a previous row. That
// makes "never overwrite silently" true structurally: there is no operation
// in this codebase that can change on_hand without leaving a movement row
// behind (this route, the PATCH above, fulfillment, refund restock, and
// catalog import all insert one), and this route is additionally the only
// one that asks the operator WHY.
adminProducts.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/variants/{id}/stock/adjust', summary: 'Adjust variant on-hand stock by a +/- delta, with a reason',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: J(z.object({
        delta: z.number().int().refine((n) => n !== 0, 'delta must be non-zero'),
        reason: z.string().trim().min(1).max(500),
      })) },
    },
    responses: {
      200: { description: 'OK', content: J(z.object({ id: z.string(), onHand: z.number().int() })) },
      404: { description: 'Not found', ...errBody },
      409: { description: 'Conflict (would go negative)', ...errBody },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { id } = c.req.valid('param');
    const { delta, reason } = c.req.valid('json');
    const res = await withStore(st.storeId, async (tx): Promise<{ kind: 'ok'; onHand: number } | { kind: 'notfound' } | { kind: 'negative' }> => {
      const [cur] = await tx.select().from(s.stock).where(eq(s.stock.variantId, id)).limit(1).for('update');
      if (!cur) {
        const [v] = await tx.select({ id: s.productVariant.id }).from(s.productVariant).where(eq(s.productVariant.id, id)).limit(1);
        if (!v) return { kind: 'notfound' };
        if (delta < 0) return { kind: 'negative' };
        await tx.insert(s.stock).values({ variantId: id, storeId: st.storeId, onHand: delta, allocated: 0 });
        await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: id, delta, reason, actor: admin.email });
        await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'variant', entityId: id, action: 'stock_adjust', data: { delta, reason, onHand: delta } });
        return { kind: 'ok', onHand: delta };
      }
      const onHand = cur.onHand + delta;
      if (onHand < 0) return { kind: 'negative' };
      await tx.update(s.stock).set({ onHand }).where(eq(s.stock.variantId, id));
      await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: id, delta, reason, actor: admin.email });
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'variant', entityId: id, action: 'stock_adjust', data: { delta, reason, onHand } });
      return { kind: 'ok', onHand };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'variant not found');
    if (res.kind === 'negative') throw new HttpError(409, 'adjustment would take on-hand stock negative');
    onStockChanged(st.slug, [id]);
    return c.json({ id, onHand: res.onHand }, 200);
  }),
);

// ── stock adjustment history: the append-only ledger a merchant reads to
//    answer "why is this number what it is" — every PATCH/adjust/fulfillment/
//    refund-restock/import write lands here (stock_movement), oldest last. ──
adminProducts.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/variants/{id}/stock/history', summary: 'Stock adjustment history for a variant',
    request: { params: z.object({ id: z.string() }), query: z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }) },
    responses: { 200: { description: 'OK', content: J(Page) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { id } = c.req.valid('param');
    const { page, pageSize } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const rows = await tx.select({
        id: s.stockMovement.id, delta: s.stockMovement.delta, reason: s.stockMovement.reason,
        actor: s.stockMovement.actor, refOrderId: s.stockMovement.refOrderId, createdAt: s.stockMovement.createdAt,
      }).from(s.stockMovement).where(eq(s.stockMovement.variantId, id))
        .orderBy(desc(s.stockMovement.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
      const [cnt] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.stockMovement).where(eq(s.stockMovement.variantId, id));
      return { items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })), total: cnt?.n ?? 0, page, pageSize };
    });
    return c.json(out, 200);
  }),
);

// ── per-location stock breakdown (admin-essentials) — read-only surface over
//    the existing multi-location `stock_location` table (previously written
//    but never rendered anywhere in the admin). Locked stock rule: reads the
//    live table directly, same as every other stock read in this codebase —
//    no cache, no TTL. ────────────────────────────────────────────────────────
adminProducts.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/variants/{id}/stock/locations', summary: 'Per-location on-hand stock for a variant',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.object({ locationId: z.string(), name: z.string(), code: z.string(), onHand: z.number().int() })) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { id } = c.req.valid('param');
    const items = await withStore(st.storeId, (tx) =>
      tx.select({ locationId: s.location.id, name: s.location.name, code: s.location.code, onHand: s.stockLocation.onHand })
        .from(s.stockLocation).innerJoin(s.location, eq(s.location.id, s.stockLocation.locationId))
        .where(eq(s.stockLocation.variantId, id)));
    return c.json({ items }, 200);
  }),
);
