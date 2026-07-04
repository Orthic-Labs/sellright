import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { desc, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { sanitizeBlogHtml } from '../lib/sanitize-html.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireWrite, guard, slugify } from './admin-helpers.js';

export const adminContent = new OpenAPIHono();

function readingTime(body: string): number {
  const words = body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

adminContent.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/blog', summary: 'List blog posts',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const items = await withStore(st.storeId, async (tx) =>
      tx.select({ id: s.blogPost.id, title: s.blogPost.title, slug: s.blogPost.slug, isPublished: s.blogPost.isPublished, publishDate: s.blogPost.publishDate, authorName: s.blogPost.authorName })
        .from(s.blogPost).orderBy(desc(s.blogPost.publishDate)),
    );
    return c.json({ items: items.map((p) => ({ ...p, publishDate: p.publishDate?.toISOString() ?? null })) }, 200);
  }),
);

const postBody = z.object({ title: z.string().min(1), slug: z.string().optional(), excerpt: z.string().optional(), body: z.string().optional(), authorName: z.string().optional(), tags: z.array(z.string()).optional(), isPublished: z.boolean().optional(), seoTitle: z.string().optional(), seoDescription: z.string().optional() });

adminContent.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/blog', summary: 'Create blog post',
    request: { body: { content: J(postBody) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), slug: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const b = c.req.valid('json');
    const out = await withStore(st.storeId, async (tx) => {
      let slug = b.slug ? slugify(b.slug) : slugify(b.title);
      const [dupe] = await tx.select({ id: s.blogPost.id }).from(s.blogPost).where(eq(s.blogPost.slug, slug)).limit(1);
      if (dupe) slug = `${slug}-${Date.now().toString(36)}`;
      const [p] = await tx.insert(s.blogPost).values({
        storeId: st.storeId, title: b.title, slug, excerpt: b.excerpt ?? null, body: b.body ?? null, bodyHtml: sanitizeBlogHtml(b.body ?? ''),
        authorName: b.authorName ?? admin.email, readingTime: readingTime(b.body ?? ''), tags: b.tags ?? null,
        isPublished: b.isPublished ?? false, publishDate: b.isPublished ? new Date() : null, seoTitle: b.seoTitle ?? null, seoDescription: b.seoDescription ?? null,
      }).returning({ id: s.blogPost.id });
      return { id: p!.id, slug };
    });
    return c.json(out, 200);
  }),
);

adminContent.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/blog/{id}', summary: 'Blog post detail',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { id } = c.req.valid('param');
    const out = await withStore(st.storeId, async (tx) => (await tx.select().from(s.blogPost).where(eq(s.blogPost.id, id)).limit(1))[0]);
    if (!out) throw new HttpError(404, 'post not found');
    return c.json({ ...out, publishDate: out.publishDate?.toISOString() ?? null }, 200);
  }),
);

adminContent.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/blog/{id}', summary: 'Update blog post',
    request: { params: z.object({ id: z.string() }), body: { content: J(postBody.partial()) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const ok = await withStore(st.storeId, async (tx) => {
      const [p] = await tx.select().from(s.blogPost).where(eq(s.blogPost.id, id)).limit(1);
      if (!p) return false;
      const patch: Record<string, unknown> = {};
      for (const k of ['title', 'excerpt', 'authorName', 'tags', 'seoTitle', 'seoDescription'] as const) if (b[k] !== undefined) patch[k] = b[k];
      if (b.body !== undefined) { patch.body = b.body; patch.bodyHtml = sanitizeBlogHtml(b.body ?? ''); patch.readingTime = readingTime(b.body ?? ''); }
      if (b.isPublished !== undefined) { patch.isPublished = b.isPublished; if (b.isPublished && !p.publishDate) patch.publishDate = new Date(); }
      await tx.update(s.blogPost).set(patch).where(eq(s.blogPost.id, id));
      return true;
    });
    if (!ok) throw new HttpError(404, 'post not found');
    return c.json({ id }, 200);
  }),
);

adminContent.openapi(
  createRoute({
    method: 'delete', path: '/v1/admin/blog/{id}', summary: 'Delete blog post',
    request: { params: z.object({ id: z.string() }) },
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
