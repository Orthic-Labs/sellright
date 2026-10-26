import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { desc, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { autoExcerpt, computeReadingTime, sanitizeBlogHtml } from '../lib/sanitize-html.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireWrite, guard } from './admin-helpers.js';
import { BLOG_CONTRACT, CREATE_CONTRACT, blogRevision, blogSlug, createKey, ensureSlugUnique, existingCreate, lockedBlog, ownedFeaturedAsset, recordCreate, readCreate, rethrowSlugConflict } from './admin-blog-protocol.js';

export const adminContent = new OpenAPIHono();

const cleanTags = (tags: string[]) => tags.map((x) => x.trim()).filter(Boolean);

adminContent.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/blog', summary: 'List blog posts',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()), seoContract: z.string(), createContract: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    // Newest first by creation time (the previous platform's list sorted createdAt DESC); id breaks ties deterministically.
    const items = await withStore(st.storeId, async (tx) =>
      tx.select({ id: s.blogPost.id, title: s.blogPost.title, slug: s.blogPost.slug, isPublished: s.blogPost.isPublished, publishDate: s.blogPost.publishDate, authorName: s.blogPost.authorName, readingTime: s.blogPost.readingTime, tags: s.blogPost.tags, createdAt: s.blogPost.createdAt })
        .from(s.blogPost).orderBy(desc(s.blogPost.createdAt), desc(s.blogPost.id)),
    );
    return c.json({ items: items.map((p) => ({ ...p, publishDate: p.publishDate?.toISOString() ?? null, createdAt: p.createdAt?.toISOString() ?? null })), seoContract: BLOG_CONTRACT, createContract: CREATE_CONTRACT }, 200);
  }),
);

const postBody = z.object({ title: z.string().min(1), slug: z.string().optional(), excerpt: z.string().optional(), body: z.string().optional(), authorName: z.string().optional(), tags: z.array(z.string()).optional(), isPublished: z.boolean().optional(), publishDate: z.string().datetime().nullable().optional(), seoTitle: z.string().optional(), seoDescription: z.string().optional(), featuredAssetId: z.string().uuid().nullable().optional() });
const updateBody = postBody.partial().extend({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() });

adminContent.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/blog', summary: 'Create blog post',
    request: { body: { content: J(postBody) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), slug: z.string() })) }, 401: { description: 'Unauthorized', ...errBody }, 409: { description: 'Conflicting create request or slug already in use', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const b = c.req.valid('json');
    const key = createKey(c.req.header('idempotency-key'));
    const slug = blogSlug(b.slug?.trim() ? b.slug : b.title);
    let out: { id: string; slug: string };
    try {
      out = await withStore(st.storeId, async (tx) => {
        const prior = await existingCreate(tx, st.storeId, key, b);
        if (prior.result) return prior.result;
        await ownedFeaturedAsset(tx, st.storeId, b.featuredAssetId);
        // A taken slug is an error the author resolves, never a silent suffix.
        await ensureSlugUnique(tx, st.storeId, slug);
        const bodyHtml = sanitizeBlogHtml(b.body ?? '');
        const [p] = await tx.insert(s.blogPost).values({
          storeId: st.storeId, title: b.title, slug, excerpt: b.excerpt?.trim() || autoExcerpt(bodyHtml), body: b.body ?? null, bodyHtml,
          // Never default the byline to the staff member's login email: it is published on the storefront.
          authorName: b.authorName ?? '', readingTime: computeReadingTime(bodyHtml), tags: cleanTags(b.tags ?? []),
          isPublished: b.isPublished ?? false, publishDate: b.publishDate === undefined ? (b.isPublished ? new Date() : null) : (b.publishDate ? new Date(b.publishDate) : null), seoTitle: b.seoTitle ?? null, seoDescription: b.seoDescription ?? null,
          featuredAssetId: b.featuredAssetId ?? null,
        }).returning({ id: s.blogPost.id });
        const result = { id: p!.id, slug };
        await recordCreate(tx, st.storeId, admin.email, prior.receiptId, prior.requestHash, result);
        return result;
      });
    } catch (e) { rethrowSlugConflict(e, slug); }
    return c.json(out, 200);
  }),
);

adminContent.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/blog/requests/{key}', summary: 'Read a durable blog create receipt',
    request: { params: z.object({ key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/) }) },
    responses: { 200: { description: 'OK', content: J(z.object({ storeId: z.string(), id: z.string(), slug: z.string(), requestHash: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { key } = c.req.valid('param');
    const result = await withStore(st.storeId, tx => readCreate(tx, st.storeId, key));
    return c.json(result, 200);
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
    const found = await withStore(st.storeId, async (tx) => {
      const post = (await tx.select().from(s.blogPost).where(eq(s.blogPost.id, id)).limit(1))[0];
      const img = post?.featuredAssetId ? (await tx.select({ path: s.asset.path }).from(s.asset).where(eq(s.asset.id, post.featuredAssetId)).limit(1))[0] : undefined;
      return post ? { out: post, featuredAssetPath: img?.path ?? null } : undefined;
    });
    if (!found) throw new HttpError(404, 'post not found');
    const { out, featuredAssetPath } = found;
    // featuredAssetPath is display-only (editor preview): the revision covers the stored row alone.
    return c.json({ ...out, publishDate: out.publishDate?.toISOString() ?? null, featuredAssetPath, seoRevision: blogRevision(out), seoContract: BLOG_CONTRACT }, 200);
  }),
);

adminContent.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/blog/{id}', summary: 'Update blog post',
    request: { params: z.object({ id: z.string().uuid() }), body: { content: J(updateBody) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), seoRevision: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody }, 409: { description: 'Revision conflict or slug already in use', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const slug = b.slug === undefined ? undefined : blogSlug(b.slug);
    let result: { id: string; seoRevision: string };
    try {
      result = await withStore(st.storeId, async (tx) => {
        const p = await lockedBlog(tx, st.storeId, id, b.expectedRevision);
        await ownedFeaturedAsset(tx, st.storeId, b.featuredAssetId);
        const patch: Record<string, unknown> = {};
        for (const k of ['title', 'authorName', 'seoTitle', 'seoDescription', 'featuredAssetId'] as const) if (b[k] !== undefined) patch[k] = b[k];
        if (b.tags !== undefined) patch.tags = cleanTags(b.tags);
        // An unchanged slug is left byte-for-byte alone (posts imported earlier may predate the normaliser).
        if (slug !== undefined && b.slug !== p.slug && slug !== p.slug) { await ensureSlugUnique(tx, st.storeId, slug, id); patch.slug = slug; }
        if (b.excerpt !== undefined) patch.excerpt = b.excerpt;
        if (b.body !== undefined) {
          const bodyHtml = sanitizeBlogHtml(b.body);
          Object.assign(patch, { body: b.body, bodyHtml, readingTime: computeReadingTime(bodyHtml) });
          // Blank excerpt supplied, or none stored and none supplied: regenerate from the new body.
          if ((b.excerpt !== undefined && !b.excerpt.trim()) || (b.excerpt === undefined && !p.excerpt)) patch.excerpt = autoExcerpt(bodyHtml);
        }
        if (b.isPublished !== undefined) { patch.isPublished = b.isPublished; if (b.isPublished && !p.publishDate) patch.publishDate = new Date(); }
        if (b.publishDate !== undefined) patch.publishDate = b.publishDate ? new Date(b.publishDate) : null;
        if (!Object.keys(patch).length) throw new HttpError(400, 'no editable blog fields');
        const [updated] = await tx.update(s.blogPost).set(patch).where(eq(s.blogPost.id, id)).returning();
        return { id, seoRevision: blogRevision(updated) };
      });
    } catch (e) { rethrowSlugConflict(e, slug); }
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
