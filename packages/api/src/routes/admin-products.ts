import { shippingLabelSql } from '../lib/shipping-label.js';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { emitProductChanged, emitVariantProductChanged } from '../webhooks/catalog.js';
import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { lockStockRowsInOrder } from '../db/locks.js';
import * as s from '../db/schema.js';
import { HttpError, J, errBody, money, Page, requireAdmin, requireStore, requireWrite, guard } from './admin-helpers.js';
import { onStockChanged } from '../manifest/stock-hook.js';
import { sellableRaw, shipsNowQuantity, minIncoming, normalizeBackorderLabel, oversoldBackorderWarning } from '../orders/availability.js';

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
          stock: sql<number>`coalesce((select sum(st.on_hand + st.incoming - st.allocated) from product_variant pv join stock st on st.variant_id = pv.id where pv.product_id = ${s.product.id} and pv.deleted_at is null),0)::int`,
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
          shipDateLabel: shippingLabelSql(s.productVariant.metafields),
          enabled: s.productVariant.enabled,
          fulfillmentType: s.productVariant.fulfillmentType,
          appKey: s.productVariant.appKey,
          artifactKey: s.productVariant.artifactKey,
          licenseSeats: s.productVariant.licenseSeats,
          licenseDurationDays: s.productVariant.licenseDurationDays,
          updatesDurationDays: s.productVariant.updatesDurationDays,
          updatedAt: s.productVariant.updatedAt,
          onHand: s.stock.onHand,
          incoming: s.stock.incoming,
          allocated: s.stock.allocated,
          backorderLabel: s.productVariant.backorderLabel,
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
        id: p.id, slug: p.slug, name: p.name, description: p.description, status: p.status, assetPath, featuredAssetId: p.featuredAssetId, updatedAt: p.updatedAt.toISOString(), seoTitle: p.seoTitle, seoDescription: p.seoDescription,
        images: gallery.map((g) => ({ assetId: g.assetId, path: g.path, url: `/assets/${g.path}`, position: g.position })),
        variants: variants.map((v) => ({ ...v, updatedAt: v.updatedAt.toISOString(), onHand: v.onHand ?? 0, incoming: v.incoming ?? 0, allocated: v.allocated ?? 0, available: sellableRaw(v), shipsNow: shipsNowQuantity(v), optionIds: vopts.filter((o) => o.variantId === v.id).map((o) => o.optionId) })),
      };
    });
    if (!out) throw new HttpError(404, 'product not found');
    return c.json(out, 200);
  }),
);

adminProducts.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/products/{id}', summary: 'Update product',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ name: z.string().min(1).max(300).optional(), description: z.string().max(100000).nullable().optional(), status: z.enum(['draft', 'active']).optional(), vendor: z.string().nullable().optional(), productType: z.string().nullable().optional(), tags: z.array(z.string().max(100)).max(100).nullable().optional(), seoTitle: z.string().nullable().optional(), seoDescription: z.string().nullable().optional(), metafields: z.record(z.string(), z.any()).nullable().optional(), featuredAssetId: z.guid().nullable().optional(), expectedUpdatedAt: z.string().datetime().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), updatedAt: z.string() })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Changed since loaded', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { id } = c.req.valid('param');
    const { expectedUpdatedAt, ...patch } = c.req.valid('json');
    // #406: the editor sends the updatedAt it loaded; a newer row means someone else saved first (409, "Use theirs / Keep mine").
    const res = await withStore(st.storeId, async (tx) => {
      const [p] = await tx.select({ id: s.product.id, status: s.product.status, updatedAt: s.product.updatedAt }).from(s.product).where(eq(s.product.id, id)).limit(1).for('update');
      if (!p) return { kind: 'notfound' as const };
      if (expectedUpdatedAt && p.updatedAt.getTime() > new Date(expectedUpdatedAt).getTime()) return { kind: 'conflict' as const, updatedAt: p.updatedAt };
      const updatedAt = new Date();
      await tx.update(s.product).set({ ...patch, updatedAt }).where(eq(s.product.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'product', entityId: id, action: 'update', fromState: p.status, toState: patch.status ?? p.status, data: patch });
      await emitProductChanged(tx, st.storeId, id);
      return { kind: 'ok' as const, updatedAt };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'product not found');
    if (res.kind === 'conflict') throw new HttpError(409, 'Product changed since you opened it');
    return c.json({ id, updatedAt: res.updatedAt.toISOString() }, 200);
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
      shipDateLabel: z.string().max(255).nullable().optional(),
      /** #446: ship copy for backordered units; cannot be cleared while stock.incoming > 0. */
      backorderLabel: z.string().max(255).nullable().optional(),
      compareAtPrice: money.nullable().optional(),
      cost: money.nullable().optional(),
      barcode: z.string().nullable().optional(),
      weightG: z.number().int().min(0).nullable().optional(),
      dimensions: z.record(z.string(), z.any()).nullable().optional(),
      metafields: z.record(z.string(), z.any()).nullable().optional(),
      enabled: z.boolean().optional(),
      fulfillmentType: z.enum(['physical', 'digital_download', 'license', 'update_pass']).optional(),
      appKey: z.string().nullable().optional(),
      artifactKey: z.string().nullable().optional(),
      licenseSeats: z.number().int().min(1).max(100).optional(),
      licenseDurationDays: z.number().int().positive().max(36500).nullable().optional(),
      updatesDurationDays: z.number().int().positive().max(36500).nullable().optional(),
      expectedUpdatedAt: z.string().datetime().optional(),
    })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), updatedAt: z.string() })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Changed since loaded', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { id } = c.req.valid('param');
    const { shipDateLabel, expectedUpdatedAt, backorderLabel: rawBackorderLabel, ...patch } = c.req.valid('json');
    const backorderLabel = rawBackorderLabel === undefined ? undefined : normalizeBackorderLabel(rawBackorderLabel);
    // #406: like the product PATCH, a newer variant row than the editor loaded is a 409 (Use theirs / Keep mine).
    const res = await withStore(st.storeId, async (tx) => {
      // #446: stock row first, then the variant row (the same order the incoming route takes), so a label write cannot
      // deadlock against an incoming write; the label check reads the locked incoming.
      const [lockedStock] = backorderLabel !== undefined ? await lockStockRowsInOrder(tx, st.storeId, [id]) : [];
      if (backorderLabel === null && lockedStock) {
        const [inc] = await tx.select({ incoming: s.stock.incoming }).from(s.stock).where(eq(s.stock.variantId, id)).limit(1);
        if ((inc?.incoming ?? 0) > 0) return { kind: 'label_required' as const };
      }
      const [v] = await tx.select({ id: s.productVariant.id, updatedAt: s.productVariant.updatedAt }).from(s.productVariant).where(eq(s.productVariant.id, id)).limit(1).for('update');
      if (!v) return { kind: 'notfound' as const };
      if (expectedUpdatedAt && v.updatedAt.getTime() > new Date(expectedUpdatedAt).getTime()) return { kind: 'conflict' as const };
      const updatedAt = new Date();
      await tx.update(s.productVariant).set({ ...patch, ...(shipDateLabel === undefined ? {} : { metafields: sql`coalesce(${patch.metafields === undefined ? s.productVariant.metafields : sql`${JSON.stringify(patch.metafields ?? {})}::jsonb`}, '{}'::jsonb) || ${JSON.stringify({ shipDateLabel })}::jsonb` }), shipDate: patch.shipDate === undefined ? undefined : patch.shipDate === null ? null : new Date(patch.shipDate), ...(backorderLabel === undefined ? {} : { backorderLabel }), updatedAt }).where(eq(s.productVariant.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'variant', entityId: id, action: 'update', data: { ...patch, ...(shipDateLabel === undefined ? {} : { shipDateLabel }), ...(backorderLabel === undefined ? {} : { backorderLabel }) } });
      await emitVariantProductChanged(tx, st.storeId, id);
      return { kind: 'ok' as const, updatedAt };
    });
    if (res.kind === 'label_required') throw new HttpError(400, 'backorderLabel cannot be cleared while incoming stock is above zero', 'BACKORDER_LABEL_REQUIRED', 'backorderLabel');
    if (res.kind === 'notfound') throw new HttpError(404, 'variant not found');
    if (res.kind === 'conflict') throw new HttpError(409, 'Variant changed since you opened it');
    return c.json({ id, updatedAt: res.updatedAt.toISOString() }, 200);
  }),
);

adminProducts.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/variants/{id}/stock', summary: 'Set variant on-hand stock',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ onHand: z.number().int().min(0), expectedOnHand: z.number().int().min(0).optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), onHand: z.number().int(), warning: z.string().optional() })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Stock changed since loaded', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { id } = c.req.valid('param');
    const { onHand, expectedOnHand } = c.req.valid('json');
    // #406: onHand is absolute, so a fulfilment or another admin's change since the editor loaded would be silently
    // overwritten. With expectedOnHand the write only lands if on-hand is still what the editor showed.
    let warning: string | null = null;
    const ok = await withStore(st.storeId, async (tx) => {
      // Locked read: the movement delta must be computed from the row this write replaces.
      const [cur] = await lockStockRowsInOrder(tx, st.storeId, [id]);
      if (expectedOnHand !== undefined && (cur?.onHand ?? 0) !== expectedOnHand) return 'conflict' as const;
      if (cur) {
        const delta = onHand - cur.onHand;
        await tx.update(s.stock).set({ onHand }).where(eq(s.stock.variantId, id));
        warning = oversoldBackorderWarning({ onHand, incoming: cur.incoming, allocated: cur.allocated });
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
    if (ok === 'conflict') throw new HttpError(409, 'Stock changed since you opened it');
    if (!ok) throw new HttpError(404, 'variant not found');
    // Zero-cache stock rule: regenerate the manifest immediately, after this
    // commit — never inside the transaction above (a later throw would roll
    // the write back and the manifest would lie about a stock level that
    // never actually landed).
    // Single variant known precisely — scope the manifest regen to just its product.
    onStockChanged(st.slug, [id]);
    return c.json({ id, onHand, ...(warning ? { warning } : {}) }, 200);
  }),
);

adminProducts.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/variants/stock/bulk', summary: 'Set on-hand stock for many variants in one transaction',
    request: { body: { content: J(z.object({
      items: z.array(z.object({ id: z.string(), onHand: z.number().int().min(0) })).min(1).max(500),
    })) } },
    responses: {
      200: { description: 'OK', content: J(z.object({ updated: z.array(z.object({ id: z.string(), onHand: z.number().int(), warning: z.string().optional() })) })) },
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

      // B3/N12: lock every existing stock row of the batch in canonical variant order BEFORE reading or writing
      // any of them, so this bulk write cannot deadlock against checkout reservations or another bulk write that
      // names the same variants in a different order, and each movement delta is computed from the locked row.
      const existingStock = await lockStockRowsInOrder(tx, st.storeId, ids);
      const stockByVariant = new Map(existingStock.map((row) => [row.variantId, row]));

      const out: { id: string; onHand: number; warning?: string }[] = [];
      for (const id of [...ids].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0))) {
        const onHand = byId.get(id)!;
        const cur = stockByVariant.get(id);
        let bulkWarning: string | null = null;
        if (cur) {
          const delta = onHand - cur.onHand;
          await tx.update(s.stock).set({ onHand }).where(eq(s.stock.variantId, id));
          bulkWarning = oversoldBackorderWarning({ onHand, incoming: cur.incoming, allocated: cur.allocated });
          if (delta !== 0) await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: id, delta, reason: 'admin_bulk_adjust', actor: admin.email });
        } else {
          await tx.insert(s.stock).values({ variantId: id, storeId: st.storeId, onHand, allocated: 0 });
          await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: id, delta: onHand, reason: 'admin_bulk_adjust', actor: admin.email });
        }
        await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'variant', entityId: id, action: 'stock', data: { onHand, bulk: true } });
        await emitVariantProductChanged(tx, st.storeId, id);
        out.push({ id, onHand, ...(bulkWarning ? { warning: bulkWarning } : {}) });
      }
      // Response keeps payload order (writes above ran in canonical order).
      return ids.map((id) => out.find((row) => row.id === id)!);
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

// ── Bulk Stock page read model (the previous platform order-tools BulkStockPage parity) ─────
// Every non-deleted product with its non-deleted variants and live stock, in one
// round trip, so the page can render the product -> variant tree and save every
// changed variant through PATCH /variants/stock/bulk above (one transaction).
// `enabled` is the previous platform's product/variant enabled flag (product.status = active).
// Capped like the previous platform's `take: 300`-style single fetch, but with headroom.
const STOCK_TREE_MAX_PRODUCTS = 2000;
adminProducts.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/stock/tree', summary: 'Products with their variants and stock (Bulk Stock page)',
    responses: {
      200: { description: 'OK', content: J(z.object({
        items: z.array(z.object({
          id: z.string(), name: z.string(), enabled: z.boolean(),
          variants: z.array(z.object({ id: z.string(), name: z.string(), sku: z.string(), enabled: z.boolean(), onHand: z.number().int(), allocated: z.number().int(), incoming: z.number().int().optional() })),
        })),
        total: z.number().int(), truncated: z.boolean(),
      })) },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const out = await withStore(st.storeId, async (tx) => {
      const products = await tx
        .select({ id: s.product.id, name: s.product.name, status: s.product.status })
        .from(s.product)
        .where(sql`${s.product.deletedAt} is null`)
        .orderBy(s.product.name)
        .limit(STOCK_TREE_MAX_PRODUCTS + 1);
      const truncated = products.length > STOCK_TREE_MAX_PRODUCTS;
      const page = truncated ? products.slice(0, STOCK_TREE_MAX_PRODUCTS) : products;
      const variants = page.length
        ? await tx
          .select({
            id: s.productVariant.id, productId: s.productVariant.productId, name: s.productVariant.name, sku: s.productVariant.sku,
            enabled: s.productVariant.enabled, onHand: s.stock.onHand, allocated: s.stock.allocated, incoming: s.stock.incoming,
          })
          .from(s.productVariant)
          .leftJoin(s.stock, eq(s.stock.variantId, s.productVariant.id))
          .where(and(inArray(s.productVariant.productId, page.map((p) => p.id)), sql`${s.productVariant.deletedAt} is null`))
          .orderBy(s.productVariant.name, s.productVariant.sku)
        : [];
      const byProduct = new Map<string, typeof variants>();
      for (const v of variants) {
        const list = byProduct.get(v.productId);
        if (list) list.push(v); else byProduct.set(v.productId, [v]);
      }
      const items = page
        .map((p) => ({
          id: p.id, name: p.name, enabled: p.status === 'active',
          variants: (byProduct.get(p.id) ?? []).map((v) => ({ id: v.id, name: v.name, sku: v.sku, enabled: v.enabled, onHand: v.onHand ?? 0, allocated: v.allocated ?? 0, incoming: v.incoming ?? 0 })),
        }))
        .filter((p) => p.variants.length > 0);
      return { items, total: items.length, truncated };
    });
    return c.json(out, 200);
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
      200: { description: 'OK', content: J(z.object({ id: z.string(), onHand: z.number().int(), warning: z.string().optional() })) },
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
    const res = await withStore(st.storeId, async (tx): Promise<{ kind: 'ok'; onHand: number; warning?: string } | { kind: 'notfound' } | { kind: 'negative' }> => {
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
      const w = oversoldBackorderWarning({ onHand, incoming: cur.incoming, allocated: cur.allocated });
      return { kind: 'ok', onHand, ...(w ? { warning: w } : {}) };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'variant not found');
    if (res.kind === 'negative') throw new HttpError(409, 'adjustment would take on-hand stock negative');
    onStockChanged(st.slug, [id]);
    return c.json({ id, onHand: res.onHand, ...(res.warning ? { warning: res.warning } : {}) }, 200);
  }),
);

// ── #446 backorder: incoming stock + ship label, and the receive action ──────────────────────────────────────────────
// `incoming` = units not in the warehouse yet that may be sold ahead of arrival. Setting it needs a non-empty ship label
// whenever it is > 0, and may not drop below the backorder quantity already sold, greatest(allocated - on_hand, 0). The
// row is locked first (lockStockRowsInOrder, the repo-wide stock lock order) so the floor is checked against the same
// allocated/on_hand the write lands on; a checkout reserving concurrently serialises behind this lock.
adminProducts.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/variants/{id}/incoming', summary: 'Set variant incoming (backorder) quantity and ship label',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({
      incoming: z.number().int().min(0).max(100_000_000),
      backorderLabel: z.string().max(255).nullable().optional(),
      expectedIncoming: z.number().int().min(0).optional(),
    })) } },
    responses: {
      200: { description: 'OK', content: J(z.object({ id: z.string(), incoming: z.number().int(), backorderLabel: z.string().nullable(), minIncoming: z.number().int() })) },
      400: { description: 'Label missing, or incoming below the quantity already sold on backorder', ...errBody },
      404: { description: 'Not found', ...errBody }, 409: { description: 'Incoming changed since loaded', ...errBody }, 401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const res = await withStore(st.storeId, async (tx) => {
      const [cur] = await lockStockRowsInOrder(tx, st.storeId, [id]);
      const [v] = await tx.select({ id: s.productVariant.id, fulfillmentType: s.productVariant.fulfillmentType, isPreOrder: s.productVariant.isPreOrder, label: s.productVariant.backorderLabel })
        .from(s.productVariant).where(eq(s.productVariant.id, id)).limit(1).for('update');
      if (!v) return { kind: 'notfound' as const };
      const label = body.backorderLabel === undefined ? normalizeBackorderLabel(v.label) : normalizeBackorderLabel(body.backorderLabel);
      if (body.incoming > 0 && !label) return { kind: 'label' as const };
      if (body.incoming > 0 && (v.fulfillmentType !== 'physical' || v.isPreOrder)) return { kind: 'unsupported' as const };
      const onHand = cur?.onHand ?? 0, allocated = cur?.allocated ?? 0;
      const floor = minIncoming({ onHand, allocated });
      if (body.incoming < floor) return { kind: 'floor' as const, floor };
      let prev = 0;
      if (cur) {
        const [r] = await tx.select({ incoming: s.stock.incoming }).from(s.stock).where(eq(s.stock.variantId, id)).limit(1);
        prev = r?.incoming ?? 0;
        if (body.expectedIncoming !== undefined && prev !== body.expectedIncoming) return { kind: 'conflict' as const };
        await tx.update(s.stock).set({ incoming: body.incoming }).where(eq(s.stock.variantId, id));
      } else {
        if (body.expectedIncoming !== undefined && body.expectedIncoming !== 0) return { kind: 'conflict' as const };
        await tx.insert(s.stock).values({ variantId: id, storeId: st.storeId, onHand: 0, allocated: 0, incoming: body.incoming });
      }
      await tx.update(s.productVariant).set({ backorderLabel: label, updatedAt: new Date() }).where(eq(s.productVariant.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'variant', entityId: id, action: 'stock_incoming', data: { incoming: body.incoming, previousIncoming: prev, backorderLabel: label } });
      await emitVariantProductChanged(tx, st.storeId, id);
      return { kind: 'ok' as const, incoming: body.incoming, label, floor };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'variant not found');
    if (res.kind === 'conflict') throw new HttpError(409, 'Incoming stock changed since you opened it', 'INCOMING_CHANGED');
    if (res.kind === 'label') throw new HttpError(400, 'a non-empty backorderLabel is required when incoming is above zero', 'BACKORDER_LABEL_REQUIRED', 'backorderLabel');
    if (res.kind === 'unsupported') throw new HttpError(400, 'only physical, non-pre-order variants can have incoming stock', 'BACKORDER_UNSUPPORTED', 'incoming');
    if (res.kind === 'floor') throw new HttpError(400, `incoming cannot be below ${res.floor}: that many units are already sold on backorder`, 'INCOMING_BELOW_SOLD', 'incoming', { minIncoming: res.floor });
    // Zero-cache stock rule: sellable changed; regenerate the manifest after commit, scoped to this variant's product.
    onStockChanged(st.slug, [id]);
    return c.json({ id, incoming: res.incoming, backorderLabel: res.label, minIncoming: res.floor }, 200);
  }),
);

// Receive: the warehouse took delivery of N incoming units. on_hand += n, incoming -= n in ONE statement (sellable is
// unchanged, so nothing oversells), with a stock_movement row; backordered orders can then be fulfilled.
adminProducts.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/variants/{id}/stock/receive', summary: 'Receive incoming stock into the warehouse (on-hand += n, incoming -= n)',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ quantity: z.number().int().min(1).max(100_000_000) })) } },
    responses: {
      200: { description: 'OK', content: J(z.object({ id: z.string(), onHand: z.number().int(), incoming: z.number().int() })) },
      404: { description: 'Not found', ...errBody }, 409: { description: 'More than is incoming', ...errBody }, 401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { id } = c.req.valid('param');
    const { quantity } = c.req.valid('json');
    const res = await withStore(st.storeId, async (tx) => {
      await lockStockRowsInOrder(tx, st.storeId, [id]);
      const r = await tx.execute(sql`UPDATE "stock" SET on_hand = on_hand + ${quantity}, incoming = incoming - ${quantity}
        WHERE variant_id = ${id} AND store_id = ${st.storeId} AND incoming >= ${quantity} RETURNING on_hand, incoming`);
      const row = r.rows[0] as { on_hand: number; incoming: number } | undefined;
      if (!row) {
        const [exists] = await tx.select({ variantId: s.stock.variantId }).from(s.stock).where(and(eq(s.stock.variantId, id), eq(s.stock.storeId, st.storeId))).limit(1);
        return { kind: exists ? 'toomany' as const : 'notfound' as const };
      }
      await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: id, delta: quantity, reason: 'receive_incoming', actor: admin.email });
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'variant', entityId: id, action: 'stock_receive', data: { quantity, onHand: Number(row.on_hand), incoming: Number(row.incoming) } });
      await emitVariantProductChanged(tx, st.storeId, id);
      return { kind: 'ok' as const, onHand: Number(row.on_hand), incoming: Number(row.incoming) };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'variant not found');
    if (res.kind !== 'ok') throw new HttpError(409, `cannot receive ${quantity}: fewer units are incoming`, 'RECEIVE_EXCEEDS_INCOMING');
    onStockChanged(st.slug, [id]);
    return c.json({ id, onHand: res.onHand, incoming: res.incoming }, 200);
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
