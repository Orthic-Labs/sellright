import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { desc, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { sanitizeBlogHtml } from '../lib/sanitize-html.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireWrite, guard, slugify } from './admin-helpers.js';
import { BLOG_CONTRACT, CREATE_CONTRACT, blogRevision, createKey, existingCreate, lockedBlog, ownedFeaturedAsset, recordCreate } from './admin-blog-protocol.js';

export const adminContent = new OpenAPIHono();

function readingTime(body: string): number {
  const words = body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

adminContent.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/blog', summary: 'List blog posts',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()), seoContract: z.string(), createContract: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const items = await withStore(st.storeId, async (tx) =>
      tx.select({ id: s.blogPost.id, title: s.blogPost.title, slug: s.blogPost.slug, isPublished: s.blogPost.isPublished, publishDate: s.blogPost.publishDate, authorName: s.blogPost.authorName })
        .from(s.blogPost).orderBy(desc(s.blogPost.publishDate)),
    );
    return c.json({ items: items.map((p) => ({ ...p, publishDate: p.publishDate?.toISOString() ?? null })), seoContract: BLOG_CONTRACT, createContract: CREATE_CONTRACT }, 200);
  }),
);

const postBody = z.object({ title: z.string().min(1), slug: z.string().optional(), excerpt: z.string().optional(), body: z.string().optional(), authorName: z.string().optional(), tags: z.array(z.string()).optional(), isPublished: z.boolean().optional(), publishDate: z.string().datetime().nullable().optional(), seoTitle: z.string().optional(), seoDescription: z.string().optional(), featuredAssetId: z.string().uuid().nullable().optional() });
const updateBody = postBody.partial().extend({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() });

adminContent.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/blog', summary: 'Create blog post',
    request: { body: { content: J(postBody) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), slug: z.string() })) }, 401: { description: 'Unauthorized', ...errBody }, 409: { description: 'Conflicting create request', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const b = c.req.valid('json');
    const key = createKey(c.req.header('idempotency-key'));
    const out = await withStore(st.storeId, async (tx) => {
      const prior = await existingCreate(tx, st.storeId, key, b);
      if (prior.result) return prior.result;
      await ownedFeaturedAsset(tx, st.storeId, b.featuredAssetId);
      let slug = b.slug ? slugify(b.slug) : slugify(b.title);
      const [dupe] = await tx.select({ id: s.blogPost.id }).from(s.blogPost).where(eq(s.blogPost.slug, slug)).limit(1);
      if (dupe && key !== undefined) throw new HttpError(409, 'slug already exists; select the existing post');
      if (dupe) slug = `${slug}-${Date.now().toString(36)}`;
      const [p] = await tx.insert(s.blogPost).values({
        storeId: st.storeId, title: b.title, slug, excerpt: b.excerpt ?? null, body: b.body ?? null, bodyHtml: sanitizeBlogHtml(b.body ?? ''),
        authorName: b.authorName ?? admin.email, readingTime: readingTime(b.body ?? ''), tags: b.tags ?? null,
        isPublished: b.isPublished ?? false, publishDate: b.publishDate === undefined ? (b.isPublished ? new Date() : null) : (b.publishDate ? new Date(b.publishDate) : null), seoTitle: b.seoTitle ?? null, seoDescription: b.seoDescription ?? null,
        featuredAssetId: b.featuredAssetId ?? null,
      }).returning({ id: s.blogPost.id });
      const result = { id: p!.id, slug };
      await recordCreate(tx, st.storeId, admin.email, prior.receiptId, prior.requestHash, result);
      return result;
    });
    return c.json(out, 200);
  }),
);

adminContent.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/blog/{id}', summary: 'Blog post detail',
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { id } = c.req.valid('param');
    const out = await withStore(st.storeId, async (tx) => (await tx.select().from(s.blogPost).where(eq(s.blogPost.id, id)).limit(1))[0]);
    if (!out) throw new HttpError(404, 'post not found');
    return c.json({ ...out, publishDate: out.publishDate?.toISOString() ?? null, seoRevision: blogRevision(out), seoContract: BLOG_CONTRACT }, 200);
  }),
);

adminContent.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/blog/{id}', summary: 'Update blog post',
    request: { params: z.object({ id: z.string().uuid() }), body: { content: J(updateBody) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), seoRevision: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody }, 409: { description: 'Revision conflict', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const result = await withStore(st.storeId, async (tx) => {
      const p = await lockedBlog(tx, st.storeId, id, b.expectedRevision);
      await ownedFeaturedAsset(tx, st.storeId, b.featuredAssetId);
      const patch: Record<string, unknown> = {};
      for (const k of ['title', 'excerpt', 'authorName', 'tags', 'seoTitle', 'seoDescription', 'featuredAssetId'] as const) if (b[k] !== undefined) patch[k] = b[k];
      if (b.body !== undefined) { patch.body = b.body; patch.bodyHtml = sanitizeBlogHtml(b.body ?? ''); patch.readingTime = readingTime(b.body ?? ''); }
      if (b.isPublished !== undefined) { patch.isPublished = b.isPublished; if (b.isPublished && !p.publishDate) patch.publishDate = new Date(); }
      if (b.publishDate !== undefined) patch.publishDate = b.publishDate ? new Date(b.publishDate) : null;
      if (!Object.keys(patch).length) throw new HttpError(400, 'no editable blog fields');
      const [updated] = await tx.update(s.blogPost).set(patch).where(eq(s.blogPost.id, id)).returning();
      return { id, seoRevision: blogRevision(updated) };
    });
    return c.json(result, 200);
  }),
);

adminContent.openapi(
  createRoute({
    method: 'delete', path: '/v1/admin/blog/{id}', summary: 'Delete blog post',
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    await withStore(st.storeId, async (tx) => { await tx.delete(s.blogPost).where(eq(s.blogPost.id, id)); });
    return c.json({ id }, 200);
  }),
);
