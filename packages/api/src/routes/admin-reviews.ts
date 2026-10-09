/**
 * Admin product-review moderation (REWARDS-1): queue, approve / reject /
 * delete, optional public reply, and review settings (store.config.reviews).
 * Approval triggers the review bonus (loyalty/bonus.ts) — exactly once per
 * review. Every mutation writes audit_log in the same transaction, and a
 * status change refreshes the catalog manifest (rating aggregate) after commit.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { mutateStoreConfig } from './admin-settings.js';
import { HttpError, J, errBody, guard, requireAdmin, requireManage, requireStore, requireWrite } from './admin-helpers.js';
import { approveReview, deleteReview, rejectReview, ReviewSettingsSchema, reviewSettingsFromConfig, setReply, type ModerationOutcome } from '../reviews/reviews.js';
import { refreshManifestForProducts } from '../reviews/manifest.js';

export const adminReviews = new OpenAPIHono();

const Id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

const ReviewRow = z.object({
  id: z.string(), productId: z.string(), productName: z.string().nullable(), productSlug: z.string().nullable(),
  customerId: z.string().nullable(), authorName: z.string(), authorEmail: z.string(),
  rating: z.number().int(), title: z.string().nullable(), body: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']), verifiedBuyer: z.boolean(),
  reply: z.string().nullable(), repliedAt: z.string().nullable(), bonusPoints: z.number().int(),
  moderatedBy: z.string().nullable(), moderatedAt: z.string().nullable(), createdAt: z.string(),
});
const ListOut = z.object({
  items: z.array(ReviewRow), total: z.number().int(), page: z.number().int(), pageSize: z.number().int(),
  counts: z.object({ pending: z.number().int(), approved: z.number().int(), rejected: z.number().int() }),
});

adminReviews.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/reviews', summary: 'Review moderation queue',
    request: { query: z.object({
      status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
      q: z.string().trim().max(200).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }) },
    responses: { 200: { description: 'OK', content: J(ListOut) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const q = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const search = q.q ? or(ilike(s.productReview.body, `%${q.q}%`), ilike(s.productReview.title, `%${q.q}%`), ilike(s.productReview.authorName, `%${q.q}%`), ilike(s.productReview.authorEmail, `%${q.q}%`), ilike(s.product.name, `%${q.q}%`)) : undefined;
      const where = and(eq(s.productReview.storeId, st.storeId), q.status === 'all' ? undefined : eq(s.productReview.status, q.status), search);
      const [totalRow] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.productReview).leftJoin(s.product, eq(s.product.id, s.productReview.productId)).where(where);
      const rows = await tx.select({ r: s.productReview, productName: s.product.name, productSlug: s.product.slug })
        .from(s.productReview).leftJoin(s.product, eq(s.product.id, s.productReview.productId)).where(where)
        .orderBy(desc(s.productReview.createdAt), desc(s.productReview.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
      const cnt = await tx.select({ status: s.productReview.status, n: sql<number>`count(*)::int` }).from(s.productReview).where(eq(s.productReview.storeId, st.storeId)).groupBy(s.productReview.status);
      const counts = { pending: 0, approved: 0, rejected: 0 };
      for (const r of cnt) counts[r.status] = r.n;
      return { rows, total: totalRow?.n ?? 0, counts };
    });
    return c.json({
      items: out.rows.map(({ r, productName, productSlug }) => ({
        id: r.id, productId: r.productId, productName: productName ?? null, productSlug: productSlug ?? null, customerId: r.customerId,
        authorName: r.authorName, authorEmail: r.authorEmail, rating: r.rating, title: r.title, body: r.body, status: r.status,
        verifiedBuyer: r.verifiedBuyer, reply: r.reply, repliedAt: r.repliedAt?.toISOString() ?? null, bonusPoints: r.bonusPoints,
        moderatedBy: r.moderatedBy, moderatedAt: r.moderatedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
      })),
      total: out.total, page: q.page, pageSize: q.pageSize, counts: out.counts,
    }, 200);
  }),
);

type Action = 'approve' | 'reject' | 'delete';
const ActionOut = z.object({ ok: z.literal(true), bonusPoints: z.number().int() });

function moderationRoute(action: Action) {
  const method = action === 'delete' ? 'delete' as const : 'post' as const;
  const path = action === 'delete' ? '/v1/admin/reviews/{id}' : `/v1/admin/reviews/{id}/${action}`;
  return createRoute({
    method, path, summary: `${action[0]!.toUpperCase()}${action.slice(1)} a review`,
    request: { params: z.object({ id: Id }) },
    responses: { 200: { description: 'OK', content: J(ActionOut) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody } },
  });
}

for (const action of ['approve', 'reject', 'delete'] as const) {
  adminReviews.openapi(moderationRoute(action), async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const outcome: ModerationOutcome | null = await withStore(st.storeId, async (tx) => {
      const [store] = await tx.select({ name: s.store.name, currency: s.store.currency, config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1);
      const res = action === 'approve' ? await approveReview(tx, { storeId: st.storeId, reviewId: id, actor: admin.email, store: store! })
        : action === 'reject' ? await rejectReview(tx, { storeId: st.storeId, reviewId: id, actor: admin.email })
        : await deleteReview(tx, { storeId: st.storeId, reviewId: id });
      if (res) await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'review', entityId: id, action: `review_${action}`, data: { productId: res.productId, bonusPoints: res.bonusPoints } });
      return res;
    });
    if (!outcome) throw new HttpError(404, 'review not found');
    void refreshManifestForProducts(st.storeId, st.slug, [outcome.productId]);
    return c.json({ ok: true as const, bonusPoints: outcome.bonusPoints }, 200);
  }));
}

adminReviews.openapi(
  createRoute({
    method: 'put', path: '/v1/admin/reviews/{id}/reply', summary: 'Set or clear the public reply on a review',
    request: { params: z.object({ id: Id }), body: { content: J(z.object({ reply: z.string().trim().max(2000).nullable() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.literal(true) })) }, 404: { description: 'Not found', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const { reply } = c.req.valid('json');
    const ok = await withStore(st.storeId, async (tx) => {
      const done = await setReply(tx, { storeId: st.storeId, reviewId: id, reply });
      if (done) await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'review', entityId: id, action: 'review_reply', data: { cleared: !reply?.trim() } });
      return done;
    });
    if (!ok) throw new HttpError(404, 'review not found');
    return c.json({ ok: true as const }, 200);
  }),
);

adminReviews.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/reviews-settings', summary: 'Review settings',
    responses: { 200: { description: 'OK', content: J(ReviewSettingsSchema) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const [row] = await withStore(st.storeId, (tx) => tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1));
    return c.json(reviewSettingsFromConfig(row?.config), 200);
  }),
);

adminReviews.openapi(
  createRoute({
    method: 'put', path: '/v1/admin/reviews-settings', summary: 'Update review settings',
    request: { body: { content: J(ReviewSettingsSchema) } },
    responses: { 200: { description: 'OK', content: J(ReviewSettingsSchema) }, 403: { description: 'Forbidden', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requireManage(st);
    const b = c.req.valid('json');
    const next = await mutateStoreConfig(st.storeId, (config) => ({ ...config, reviews: b }), {
      actor: admin.email, action: 'settings_update',
      detail: (prev) => ({ section: 'reviews', before: reviewSettingsFromConfig(prev), after: b }),
    });
    return c.json(reviewSettingsFromConfig(next), 200);
  }),
);
