import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { HttpError, J, errBody, money, Page, requireAdmin, requireStore, requireWrite, guard, slugify } from './admin-helpers.js';
import { productMatchesRules, parseRules } from '../catalog/collection-rules.js';
import type { Tx } from '../db/client.js';

/** Products matching a smart collection's rules (dynamic membership, no stored rows). */
async function smartCollectionProducts(tx: Tx, rules: unknown) {
  const parsed = parseRules(rules);
  if (!parsed) return [];
  const rows = await tx
    .select({
      id: s.product.id, name: s.product.name, status: s.product.status, vendor: s.product.vendor,
      productType: s.product.productType, tags: s.product.tags,
      minPrice: sql<number | null>`(select min(price) from product_variant pv where pv.product_id = ${s.product.id} and pv.deleted_at is null)`,
    })
    .from(s.product)
    .where(isNull(s.product.deletedAt));
  return rows
    .filter((r) => productMatchesRules({ name: r.name, vendor: r.vendor, productType: r.productType, tags: r.tags, minPrice: r.minPrice }, parsed))
    .map((r) => ({ id: r.id, name: r.name, status: r.status, position: 0 }));
}

export const adminCatalog = new OpenAPIHono();

/** Make a store-unique slug from a base (append a short suffix on collision). */
async function uniqueSlug(tx: { select: Function }, table: typeof s.product | typeof s.collection, base: string): Promise<string> {
  let slug = base;
  for (let i = 0; i < 5; i++) {
    const [hit] = await (tx as any).select({ id: table.id }).from(table).where(eq(table.slug, slug)).limit(1);
    if (!hit) return slug;
    slug = `${base}-${randomBytes(2).toString('hex')}`;
  }
  return `${base}-${randomBytes(4).toString('hex')}`;
}

// ── products: create / delete; variants: create / delete ────────────────────
adminCatalog.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/products', summary: 'Create a product',
    request: { body: { content: J(z.object({ name: z.string().min(1), slug: z.string().optional(), description: z.string().optional(), status: z.enum(['draft', 'active']).default('draft') })) } },
    responses: { 200: { description: 'Created', content: J(z.object({ id: z.string(), slug: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const body = c.req.valid('json');
    const out = await withStore(st.storeId, async (tx) => {
      const slug = await uniqueSlug(tx, s.product, body.slug ? slugify(body.slug) : slugify(body.name));
      const [p] = await tx.insert(s.product).values({ storeId: st.storeId, name: body.name, slug, description: body.description ?? null, status: body.status }).returning({ id: s.product.id });
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'product', entityId: p!.id, action: 'create', data: { name: body.name, slug } });
      return { id: p!.id, slug };
    });
    return c.json(out, 200);
  }),
);

// Product gallery (product_asset): add / remove an image. WP8c.
// (Product field/featured-image updates use the existing PATCH in admin.ts.)
adminCatalog.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/products/{id}/assets', summary: 'Attach a gallery image',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ assetId: z.string().uuid(), position: z.number().int().min(0).optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const { assetId, position } = c.req.valid('json');
    const res = await withStore(st.storeId, async (tx): Promise<'notfound' | 'ok'> => {
      const [p] = await tx.select({ id: s.product.id }).from(s.product).where(and(eq(s.product.id, id), isNull(s.product.deletedAt))).limit(1);
      if (!p) return 'notfound';
      const [a] = await tx.select({ id: s.asset.id }).from(s.asset).where(eq(s.asset.id, assetId)).limit(1);
      if (!a) return 'notfound';
      await tx.insert(s.productAsset).values({ storeId: st.storeId, productId: id, assetId, position: position ?? 0 }).onConflictDoNothing();
      return 'ok';
    });
    if (res === 'notfound') throw new HttpError(404, 'product or asset not found');
    return c.json({ ok: true }, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'delete', path: '/v1/admin/products/{id}/assets/{assetId}', summary: 'Detach a gallery image',
    request: { params: z.object({ id: z.string(), assetId: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id, assetId } = c.req.valid('param');
    await withStore(st.storeId, (tx) => tx.delete(s.productAsset).where(and(eq(s.productAsset.productId, id), eq(s.productAsset.assetId, assetId))));
    return c.json({ ok: true }, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'delete', path: '/v1/admin/products/{id}', summary: 'Delete (archive) a product',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const ok = await withStore(st.storeId, async (tx) => {
      const [p] = await tx.select({ id: s.product.id }).from(s.product).where(and(eq(s.product.id, id), isNull(s.product.deletedAt))).limit(1);
      if (!p) return false;
      // Soft-delete the product and its variants (order history keeps snapshots).
      await tx.update(s.product).set({ deletedAt: new Date(), status: 'draft' }).where(eq(s.product.id, id));
      await tx.update(s.productVariant).set({ deletedAt: new Date(), enabled: false }).where(eq(s.productVariant.productId, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'product', entityId: id, action: 'delete' });
      return true;
    });
    if (!ok) throw new HttpError(404, 'product not found');
    return c.json({ id }, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/products/{id}/variants', summary: 'Add a variant',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ sku: z.string().min(1), name: z.string().min(1), price: money, salePrice: money.nullable().optional(), onHand: z.number().int().min(0).default(0) })) } },
    responses: { 200: { description: 'Created', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'SKU exists', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const res = await withStore(st.storeId, async (tx) => {
      const [p] = await tx.select({ id: s.product.id }).from(s.product).where(and(eq(s.product.id, id), isNull(s.product.deletedAt))).limit(1);
      if (!p) return { kind: 'notfound' as const };
      const [dupe] = await tx.select({ id: s.productVariant.id }).from(s.productVariant).where(eq(s.productVariant.sku, body.sku)).limit(1);
      if (dupe) return { kind: 'dupe' as const };
      const [v] = await tx.insert(s.productVariant).values({ storeId: st.storeId, productId: id, sku: body.sku, name: body.name, price: body.price, salePrice: body.salePrice ?? null }).returning({ id: s.productVariant.id });
      await tx.insert(s.stock).values({ variantId: v!.id, storeId: st.storeId, onHand: body.onHand, allocated: 0 });
      if (body.onHand > 0) await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: v!.id, delta: body.onHand, reason: 'admin_create' });
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'variant', entityId: v!.id, action: 'create', data: { sku: body.sku } });
      return { kind: 'ok' as const, id: v!.id };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'product not found');
    if (res.kind === 'dupe') throw new HttpError(409, `sku already exists: ${body.sku}`);
    return c.json({ id: res.id }, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'delete', path: '/v1/admin/variants/{id}', summary: 'Delete (archive) a variant',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const ok = await withStore(st.storeId, async (tx) => {
      const [v] = await tx.select({ id: s.productVariant.id }).from(s.productVariant).where(and(eq(s.productVariant.id, id), isNull(s.productVariant.deletedAt))).limit(1);
      if (!v) return false;
      await tx.update(s.productVariant).set({ deletedAt: new Date(), enabled: false }).where(eq(s.productVariant.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'variant', entityId: id, action: 'delete' });
      return true;
    });
    if (!ok) throw new HttpError(404, 'variant not found');
    return c.json({ id }, 200);
  }),
);

// ── collections ──────────────────────────────────────────────────────────────
adminCatalog.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/collections', summary: 'List collections',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const items = await withStore(st.storeId, async (tx) =>
      tx.select({
        id: s.collection.id, slug: s.collection.slug, name: s.collection.name, parentId: s.collection.parentId,
        products: sql<number>`(select count(*) from collection_product cp where cp.collection_id = ${s.collection.id})::int`,
      }).from(s.collection).orderBy(s.collection.name),
    );
    return c.json({ items }, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/collections', summary: 'Create a collection',
    request: { body: { content: J(z.object({ name: z.string().min(1), slug: z.string().optional(), description: z.string().optional(), parentId: z.string().nullable().optional(), rules: z.any().optional(), published: z.boolean().optional(), seoTitle: z.string().optional(), seoDescription: z.string().optional() })) } },
    responses: { 200: { description: 'Created', content: J(z.object({ id: z.string(), slug: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const body = c.req.valid('json');
    const out = await withStore(st.storeId, async (tx) => {
      const slug = await uniqueSlug(tx, s.collection, body.slug ? slugify(body.slug) : slugify(body.name));
      const [col] = await tx.insert(s.collection).values({ storeId: st.storeId, name: body.name, slug, description: body.description ?? null, parentId: body.parentId ?? null, rules: body.rules ?? null, published: body.published ?? true, seoTitle: body.seoTitle ?? null, seoDescription: body.seoDescription ?? null }).returning({ id: s.collection.id });
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'collection', entityId: col!.id, action: 'create', data: { name: body.name } });
      return { id: col!.id, slug };
    });
    return c.json(out, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/collections/{id}', summary: 'Collection detail + products',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { id } = c.req.valid('param');
    const out = await withStore(st.storeId, async (tx) => {
      const [col] = await tx.select().from(s.collection).where(eq(s.collection.id, id)).limit(1);
      if (!col) return null;
      // Smart collection (has rules) → dynamic membership; else manual join.
      const products = col.rules
        ? await smartCollectionProducts(tx, col.rules)
        : await tx
            .select({ id: s.product.id, name: s.product.name, status: s.product.status, position: s.collectionProduct.position })
            .from(s.collectionProduct)
            .innerJoin(s.product, eq(s.product.id, s.collectionProduct.productId))
            .where(and(eq(s.collectionProduct.collectionId, id), isNull(s.product.deletedAt)))
            .orderBy(asc(s.collectionProduct.position), s.product.name);
      return { id: col.id, slug: col.slug, name: col.name, description: col.description, parentId: col.parentId, rules: col.rules, published: col.published, seoTitle: col.seoTitle, seoDescription: col.seoDescription, smart: !!col.rules, products };
    });
    if (!out) throw new HttpError(404, 'collection not found');
    return c.json(out, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/collections/{id}', summary: 'Update a collection',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ name: z.string().optional(), description: z.string().nullable().optional(), parentId: z.string().nullable().optional(), rules: z.any().nullable().optional(), published: z.boolean().optional(), seoTitle: z.string().nullable().optional(), seoDescription: z.string().nullable().optional(), imageAssetId: z.string().nullable().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const ok = await withStore(st.storeId, async (tx) => {
      const [col] = await tx.select({ id: s.collection.id }).from(s.collection).where(eq(s.collection.id, id)).limit(1);
      if (!col) return false;
      await tx.update(s.collection).set(patch).where(eq(s.collection.id, id));
      return true;
    });
    if (!ok) throw new HttpError(404, 'collection not found');
    return c.json({ id }, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'delete', path: '/v1/admin/collections/{id}', summary: 'Delete a collection',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const ok = await withStore(st.storeId, async (tx) => {
      const [col] = await tx.select({ id: s.collection.id }).from(s.collection).where(eq(s.collection.id, id)).limit(1);
      if (!col) return false;
      await tx.delete(s.collectionProduct).where(eq(s.collectionProduct.collectionId, id));
      await tx.delete(s.collection).where(eq(s.collection.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'collection', entityId: id, action: 'delete' });
      return true;
    });
    if (!ok) throw new HttpError(404, 'collection not found');
    return c.json({ id }, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/collections/{id}/products', summary: 'Add product to collection',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ productId: z.string() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const { productId } = c.req.valid('json');
    const ok = await withStore(st.storeId, async (tx) => {
      const [col] = await tx.select({ id: s.collection.id }).from(s.collection).where(eq(s.collection.id, id)).limit(1);
      const [p] = await tx.select({ id: s.product.id }).from(s.product).where(eq(s.product.id, productId)).limit(1);
      if (!col || !p) return false;
      await tx.insert(s.collectionProduct).values({ storeId: st.storeId, collectionId: id, productId }).onConflictDoNothing();
      return true;
    });
    if (!ok) throw new HttpError(404, 'collection or product not found');
    return c.json({ ok: true }, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'delete', path: '/v1/admin/collections/{id}/products/{productId}', summary: 'Remove product from collection',
    request: { params: z.object({ id: z.string(), productId: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id, productId } = c.req.valid('param');
    await withStore(st.storeId, async (tx) => {
      await tx.delete(s.collectionProduct).where(and(eq(s.collectionProduct.collectionId, id), eq(s.collectionProduct.productId, productId)));
    });
    return c.json({ ok: true }, 200);
  }),
);

// ── inventory ────────────────────────────────────────────────────────────────
adminCatalog.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/inventory', summary: 'Inventory list (stock per variant)',
    request: { query: z.object({ q: z.string().optional(), lowStock: z.coerce.boolean().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) }) },
    responses: { 200: { description: 'OK', content: J(Page) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { q, lowStock, page, pageSize } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const conds = [isNull(s.productVariant.deletedAt)] as never[];
      if (q) conds.push(sql`(${s.productVariant.sku} ilike ${'%' + q + '%'} or ${s.productVariant.name} ilike ${'%' + q + '%'})` as never);
      if (lowStock) conds.push(sql`(${s.stock.onHand} - ${s.stock.allocated}) <= 3` as never);
      const where = and(...conds);
      const base = tx
        .select({
          variantId: s.productVariant.id, sku: s.productVariant.sku, name: s.productVariant.name,
          productName: s.product.name,
          onHand: s.stock.onHand, allocated: s.stock.allocated,
          available: sql<number>`coalesce(${s.stock.onHand},0) - coalesce(${s.stock.allocated},0)`,
        })
        .from(s.productVariant)
        .leftJoin(s.stock, eq(s.stock.variantId, s.productVariant.id))
        .innerJoin(s.product, eq(s.product.id, s.productVariant.productId))
        .$dynamic();
      const rows = await base.where(where).orderBy(asc(sql`coalesce(${s.stock.onHand},0) - coalesce(${s.stock.allocated},0)`)).limit(pageSize).offset((page - 1) * pageSize);
      const [cnt] = await tx.select({ n: count() }).from(s.productVariant).leftJoin(s.stock, eq(s.stock.variantId, s.productVariant.id)).where(where);
      return { items: rows, total: cnt?.n ?? 0, page, pageSize };
    });
    return c.json(out, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/variants/{id}/movements', summary: 'Stock movement history',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { id } = c.req.valid('param');
    const items = await withStore(st.storeId, async (tx) =>
      tx.select({ delta: s.stockMovement.delta, reason: s.stockMovement.reason, refOrderId: s.stockMovement.refOrderId, createdAt: s.stockMovement.createdAt })
        .from(s.stockMovement).where(eq(s.stockMovement.variantId, id)).orderBy(desc(s.stockMovement.createdAt)).limit(100),
    );
    return c.json({ items: items.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })) }, 200);
  }),
);

// ── multi-location inventory (P3) ─────────────────────────────────────────────
adminCatalog.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/locations', summary: 'List inventory locations',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const items = await withStore(st.storeId, async (tx) => tx.select().from(s.location).orderBy(desc(s.location.isDefault), s.location.name));
    return c.json({ items }, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/locations', summary: 'Create a location',
    request: { body: { content: J(z.object({ name: z.string().min(1), code: z.string().min(1), isDefault: z.boolean().default(false), address: z.record(z.string(), z.any()).optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const b = c.req.valid('json');
    const id = await withStore(st.storeId, async (tx) => {
      if (b.isDefault) await tx.update(s.location).set({ isDefault: false }).where(eq(s.location.isDefault, true));
      const [l] = await tx.insert(s.location).values({ storeId: st.storeId, name: b.name, code: b.code, isDefault: b.isDefault, address: b.address ?? null }).returning({ id: s.location.id });
      return l!.id;
    });
    return c.json({ id }, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/variants/{id}/location-stock', summary: 'Set a variant on-hand at a location (recomputes aggregate)',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ locationId: z.string(), onHand: z.number().int().min(0) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), onHand: z.number().int() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const total = await withStore(st.storeId, async (tx) => {
      await tx.insert(s.stockLocation).values({ storeId: st.storeId, variantId: id, locationId: b.locationId, onHand: b.onHand })
        .onConflictDoUpdate({ target: [s.stockLocation.variantId, s.stockLocation.locationId], set: { onHand: b.onHand } });
      const [sum] = await tx.select({ n: sql<number>`coalesce(sum(${s.stockLocation.onHand}),0)::int` }).from(s.stockLocation).where(eq(s.stockLocation.variantId, id));
      const agg = sum?.n ?? 0;
      await tx.insert(s.stock).values({ storeId: st.storeId, variantId: id, onHand: agg, allocated: 0 })
        .onConflictDoUpdate({ target: s.stock.variantId, set: { onHand: agg } });
      return agg;
    });
    return c.json({ id, onHand: total }, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/variants/{id}/transfer', summary: 'Transfer stock between locations (aggregate unchanged)',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ fromLocationId: z.string(), toLocationId: z.string(), quantity: z.number().int().min(1) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 409: { description: 'Insufficient at source', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const res = await withStore(st.storeId, async (tx) => {
      const [from] = await tx.select({ onHand: s.stockLocation.onHand }).from(s.stockLocation).where(and(eq(s.stockLocation.variantId, id), eq(s.stockLocation.locationId, b.fromLocationId))).limit(1);
      if (!from || from.onHand < b.quantity) return { ok: false as const };
      await tx.update(s.stockLocation).set({ onHand: sql`${s.stockLocation.onHand} - ${b.quantity}` }).where(and(eq(s.stockLocation.variantId, id), eq(s.stockLocation.locationId, b.fromLocationId)));
      await tx.insert(s.stockLocation).values({ storeId: st.storeId, variantId: id, locationId: b.toLocationId, onHand: b.quantity })
        .onConflictDoUpdate({ target: [s.stockLocation.variantId, s.stockLocation.locationId], set: { onHand: sql`${s.stockLocation.onHand} + ${b.quantity}` } });
      return { ok: true as const };
    });
    if (!res.ok) throw new HttpError(409, 'insufficient stock at the source location');
    return c.json({ id }, 200);
  }),
);

// ── option-group editor (variant options) (P3) ────────────────────────────────
adminCatalog.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/products/{id}/options', summary: 'Option groups + values for a product',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ groups: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { id } = c.req.valid('param');
    const groups = await withStore(st.storeId, async (tx) => {
      const gs = await tx.select().from(s.productOptionGroup).where(eq(s.productOptionGroup.productId, id));
      const opts = gs.length ? await tx.select().from(s.productOption).where(inArray(s.productOption.groupId, gs.map((g) => g.id))) : [];
      return gs.map((g) => ({ id: g.id, name: g.name, options: opts.filter((o) => o.groupId === g.id).map((o) => ({ id: o.id, value: o.value })) }));
    });
    return c.json({ groups }, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/products/{id}/option-groups', summary: 'Add an option group to a product',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ name: z.string().min(1), values: z.array(z.string()).optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const gid = await withStore(st.storeId, async (tx) => {
      const [g] = await tx.insert(s.productOptionGroup).values({ storeId: st.storeId, productId: id, name: b.name }).returning({ id: s.productOptionGroup.id });
      if (b.values?.length) await tx.insert(s.productOption).values(b.values.map((v: string) => ({ storeId: st.storeId, groupId: g!.id, value: v })));
      return g!.id;
    });
    return c.json({ id: gid }, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/option-groups/{groupId}/options', summary: 'Add a value to an option group',
    request: { params: z.object({ groupId: z.string() }), body: { content: J(z.object({ value: z.string().min(1) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { groupId } = c.req.valid('param');
    const b = c.req.valid('json');
    const oid = await withStore(st.storeId, async (tx) => {
      const [o] = await tx.insert(s.productOption).values({ storeId: st.storeId, groupId, value: b.value }).returning({ id: s.productOption.id });
      return o!.id;
    });
    return c.json({ id: oid }, 200);
  }),
);

adminCatalog.openapi(
  createRoute({
    method: 'put', path: '/v1/admin/variants/{id}/options', summary: 'Set the option values for a variant (replaces the set)',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ optionIds: z.array(z.string()) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    await withStore(st.storeId, async (tx) => {
      await tx.delete(s.variantOption).where(eq(s.variantOption.variantId, id));
      if (b.optionIds.length) await tx.insert(s.variantOption).values(b.optionIds.map((oid: string) => ({ storeId: st.storeId, variantId: id, optionId: oid })));
    });
    return c.json({ id }, 200);
  }),
);
