/**
 * Shop-side product reviews (REWARDS-1).
 *   GET  /v1/shop/catalog/products/{slug}/reviews  public: approved reviews + aggregate
 *   POST /v1/shop/catalog/products/{slug}/reviews  submit (signed-in; guests only when the
 *                                                  store allows it and they prove a purchase)
 * Moderation lives in admin-reviews.ts. The bonus is granted on approval, never on submit.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { resolveStoreFromCtx } from './store-context.js';
import { customerToken, resolveCustomer } from '../auth/session.js';
import { clientIp } from '../auth/rate-limit.js';
import { verifyTurnstileToken } from '../security/turnstile.js';
import { apiErrorSchema, errJson } from '../lib/api-error.js';
import { turnstileSecret } from './contact.js';
import { reviewRetryAfter, recordReviewAttempt } from '../reviews/limit.js';
import { refreshManifestForProducts } from '../reviews/manifest.js';
import { aggregateForProduct, listApproved, reviewSettingsFromConfig, submitReview, ReviewInputSchema } from '../reviews/reviews.js';
import { loyaltySettingsFromConfig } from '../money/loyalty.js';

export const reviews = new OpenAPIHono();
const J = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });
const Slug = z.string().min(1).max(200).regex(/^[a-z0-9][a-z0-9\-_]*$/i);

const PublicReview = z.object({
  id: z.string(), authorName: z.string(), rating: z.number().int(), title: z.string().nullable(), body: z.string(),
  verifiedBuyer: z.boolean(), createdAt: z.string(), reply: z.string().nullable(), repliedAt: z.string().nullable(),
});
const ReviewsOut = z.object({
  enabled: z.boolean(),
  allowGuests: z.boolean(),
  requirePurchase: z.boolean(),
  /** Points a verified review earns (0 when the program/rule is off). */
  bonusPoints: z.number().int(),
  average: z.number(), count: z.number().int(),
  distribution: z.object({ '1': z.number().int(), '2': z.number().int(), '3': z.number().int(), '4': z.number().int(), '5': z.number().int() }),
  reviews: z.array(PublicReview),
});

reviews.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/catalog/products/{slug}/reviews', summary: 'Approved reviews + rating aggregate for a product',
    request: {
      params: z.object({ slug: Slug }),
      query: z.object({
        limit: z.coerce.number().int().min(1).max(50).default(10),
        offset: z.coerce.number().int().min(0).max(10_000).default(0),
        sort: z.enum(['newest', 'highest', 'lowest']).default('newest'),
      }),
    },
    responses: { 200: { description: 'OK', content: J(ReviewsOut) }, 404: { description: 'Not found', content: J(apiErrorSchema()) } },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { slug } = c.req.valid('param');
    const q = c.req.valid('query');
    const settings = reviewSettingsFromConfig(st.config);
    const program = loyaltySettingsFromConfig(st.config);
    const out = await withStore(st.id, async (tx) => {
      const [p] = await tx.select({ id: s.product.id }).from(s.product)
        .where(and(eq(s.product.storeId, st.id), eq(s.product.slug, slug), eq(s.product.status, 'active'), sql`${s.product.deletedAt} IS NULL`)).limit(1);
      if (!p) return null;
      const agg = await aggregateForProduct(tx, st.id, p.id);
      const list = settings.enabled ? await listApproved(tx, st.id, p.id, q) : [];
      return { agg, list };
    });
    if (!out) return errJson(c, 404, 'PRODUCT_NOT_FOUND', 'product not found');
    return c.json({
      enabled: settings.enabled, allowGuests: settings.allowGuests, requirePurchase: settings.requirePurchase,
      bonusPoints: program.enabled ? program.reviewBonusPoints : 0,
      average: out.agg.average, count: out.agg.count, distribution: out.agg.distribution, reviews: out.list,
    }, 200);
  },
);

const SubmitIn = ReviewInputSchema.extend({
  turnstileToken: z.string().max(4096).optional(),
  honeypot: z.string().max(200).optional(),
});

reviews.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/catalog/products/{slug}/reviews', summary: 'Submit a product review',
    request: { params: z.object({ slug: Slug }), body: { content: J(SubmitIn) } },
    responses: {
      201: { description: 'Accepted', content: J(z.object({ id: z.string(), status: z.enum(['pending', 'approved']), verifiedBuyer: z.boolean() })) },
      400: { description: 'Security check failed', content: J(apiErrorSchema()) },
      401: { description: 'Sign in required', content: J(apiErrorSchema()) },
      403: { description: 'Not allowed', content: J(apiErrorSchema()) },
      404: { description: 'Not found', content: J(apiErrorSchema()) },
      409: { description: 'Already reviewed', content: J(apiErrorSchema()) },
      429: { description: 'Rate limited', content: J(apiErrorSchema()) },
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    const { slug } = c.req.valid('param');
    if (body.honeypot) return c.json({ id: '00000000-0000-0000-0000-000000000000', status: 'pending' as const, verifiedBuyer: false }, 201);
    const ip = clientIp(c);
    const retry = await reviewRetryAfter(ip);
    if (retry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many submissions — try again in ${retry}s`);
    await recordReviewAttempt(ip);
    const st = await resolveStoreFromCtx(c);
    const token = customerToken(c);

    const out = { customer: token ? await withStore(st.id, (tx) => resolveCustomer(tx, token)) : null };
    if (!out.customer) {
      const ok = await verifyTurnstileToken({ secret: turnstileSecret(st.config), token: body.turnstileToken, remoteIp: ip });
      if (!ok) return errJson(c, 400, 'SECURITY_CHECK_FAILED', 'security verification failed — please try again');
    }
    const r = await withStore(st.id, (tx) => submitReview(tx, {
      storeId: st.id, store: { name: st.name, currency: st.currency, config: st.config }, productSlug: slug, review: body, customer: out.customer,
    }));
    if (!r.ok) {
      switch (r.reason) {
        case 'disabled': return errJson(c, 403, 'REVIEWS_DISABLED', 'reviews are not enabled');
        case 'product_not_found': return errJson(c, 404, 'PRODUCT_NOT_FOUND', 'product not found');
        case 'sign_in_required': return errJson(c, 401, 'SIGN_IN_REQUIRED', 'sign in to write a review');
        case 'email_unverified': return errJson(c, 403, 'EMAIL_NOT_VERIFIED', 'verify your email before writing a review');
        case 'purchase_required': return errJson(c, 403, 'PURCHASE_REQUIRED', 'only customers who bought this product can review it');
        case 'duplicate': return errJson(c, 409, 'ALREADY_REVIEWED', 'you have already reviewed this product');
      }
    }
    if (r.status === 'approved') void refreshManifestForProducts(st.id, st.slug, [r.productId]);
    return c.json({ id: r.id, status: r.status, verifiedBuyer: r.verifiedBuyer }, 201);
  },
);
