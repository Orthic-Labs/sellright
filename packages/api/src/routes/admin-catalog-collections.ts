import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireWrite, guard, slugify } from './admin-helpers.js';
import { smartCollectionProducts, uniqueSlug } from './admin-catalog-utils.js';

export function registerCollectionRoutes(adminCatalog: any) {
  adminCatalog.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/collections', summary: 'List collections',
      responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
    }),
    async (c: any) => guard(c, async () => {
      const { admin } = await requireAdmin(c);
      const st = requireStore(admin, c);
      const items = await withStore(st.storeId, async (tx) =>
        tx.select({
          id: s.collection.id, slug: s.collection.slug, name: s.collection.name, parentId: s.collection.parentId,
          products: sqlCountCollectionProducts(),
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
    async (c: any) => guard(c, async () => {
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
    async (c: any) => guard(c, async () => {
      const { admin } = await requireAdmin(c);
      const st = requireStore(admin, c);
      const { id } = c.req.valid('param');
      const out = await withStore(st.storeId, async (tx) => {
        const [col] = await tx.select().from(s.collection).where(eq(s.collection.id, id)).limit(1);
        if (!col) return null;
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
    async (c: any) => guard(c, async () => {
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
    async (c: any) => guard(c, async () => {
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
    async (c: any) => guard(c, async () => {
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
    async (c: any) => guard(c, async () => {
      const { admin } = await requireAdmin(c);
      const st = requireStore(admin, c); requireWrite(st);
      const { id, productId } = c.req.valid('param');
      await withStore(st.storeId, async (tx) => {
        await tx.delete(s.collectionProduct).where(and(eq(s.collectionProduct.collectionId, id), eq(s.collectionProduct.productId, productId)));
      });
      return c.json({ ok: true }, 200);
    }),
  );
}

function sqlCountCollectionProducts() {
  return sql<number>`(select count(*) from collection_product cp where cp.collection_id = ${s.collection.id})::int`;
}
