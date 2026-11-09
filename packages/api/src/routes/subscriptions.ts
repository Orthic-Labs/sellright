/**
 * Subscriptions — shop + admin REST.
 *  - POST /v1/shop/subscribe          create a backing order + Stripe Checkout
 *                                     Session (mode:subscription). AUTH REQUIRED.
 *  - POST /v1/shop/account/billing-portal  open the Stripe Customer Portal.
 *  - GET  /v1/admin/subscriptions     admin list (mirrors the orders list).
 *
 * A subscription is a recurring SellRight order: subscribing creates a
 * PendingPayment order (one line for the recurring variant) and a Checkout
 * Session whose metadata carries {storeId, orderCode, customerId}. The first
 * invoice.paid settles the order through the existing license-issuance path.
 */
import { randomUUID } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import { hasPgCode } from '../db/locks.js';
import { rateLimitBackend } from '../auth/rate-limit-backend.js';
import { clientIp } from '../auth/rate-limit.js';
import { withOrderNumber } from '../orders/order-number.js';
import { resolveStoreFromCtx } from './store-context.js';
import * as s from '../db/schema.js';
import { customerToken, resolveCustomer, type SessionCustomer } from '../auth/session.js';
import { createSubscriptionCheckout, createBillingPortal, stripeModeFromConfig, resolveStripeUsable } from '../payments/stripe.js';
import { isPaymentMethodEnabled } from '../payments/provider.js';
import { env } from '../env.js';
import { J, Page, errBody, requireAdmin, requireStore, guard } from './admin-helpers.js';
import { apiErrorSchema, errJson } from '../lib/api-error.js';

async function me(tx: Tx, token: string | null): Promise<SessionCustomer | null> {
  return token ? resolveCustomer(tx, token, false, { renew: false }) : null; // 0108: never row-lock the session inside a business transaction (design §5)
}

export const subscriptions = new OpenAPIHono();

const SUBSCRIBE_WINDOW_MS = 10 * 60 * 1000;
const SUBSCRIBE_MAX = 10;
/** Per (store, client IP) budget for POST /v1/shop/subscribe; returns 0 when allowed, else retry-after seconds. */
export const subscribeRetryAfter = (storeId: string, ip: string): Promise<number> =>
  rateLimitBackend().consume('subscribe', JSON.stringify([storeId, ip]), SUBSCRIBE_WINDOW_MS, SUBSCRIBE_MAX);

// POST /v1/shop/subscribe — start a recurring plan. Auth required (a plan needs a
// customerId for license ownership + a stripeCustomerId for the portal). The
// variant MUST have a stripePriceId (else 400). Creates a PendingPayment order
// (one line) then a Stripe Checkout Session (mode:subscription).
subscriptions.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/subscribe', summary: 'Subscribe to a recurring plan',
    request: {
      headers: z.object({ 'idempotency-key': z.string().min(1).max(200).optional() }),
      body: { content: { 'application/json': { schema: z.object({ variantId: z.guid() }) } } },
    },
    responses: {
      200: { description: 'Checkout URL', content: { 'application/json': { schema: z.object({ url: z.string() }) } } },
      400: { description: 'Not a recurring variant', content: { 'application/json': { schema: apiErrorSchema() } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: apiErrorSchema() } } },
      409: { description: 'Stripe disabled, or the Idempotency-Key was used for a different request', content: { 'application/json': { schema: apiErrorSchema() } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: apiErrorSchema() } } },
      503: { description: 'Stripe not configured', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { variantId } = c.req.valid('json');
    const idemKey = c.req.valid('header')['idempotency-key'] ?? null;
    const retry = await subscribeRetryAfter(st.id, clientIp(c));
    if (retry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${retry}s`, { retryAfter: retry });
    if (!isPaymentMethodEnabled(st.config, 'stripe')) return errJson(c, 409, 'PAYMENT_METHOD_DISABLED', 'payment method disabled: stripe');
    const mode = stripeModeFromConfig(st.config);
    if (!(await resolveStripeUsable(st.id, mode))) return errJson(c, 503, 'STRIPE_NOT_CONFIGURED', `stripe is not configured (${mode} mode)`);

    type R =
      | { kind: 'unauth' }
      | { kind: 'badVariant' }
      | { kind: 'keyConflict' }
      | { kind: 'replayUrl'; url: string }
      | { kind: 'ok'; orderId: string; orderCode: string; priceId: string; customerId: string; email: string };
    const run = () => withStore(st.id, async (tx): Promise<R> => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return { kind: 'unauth' };
      // Replay: the same Idempotency-Key returns the same order (and its stored Checkout Session) instead of a duplicate.
      if (idemKey) {
        const [prior] = await tx
          .select({ id: s.order.id, code: s.order.code, customerId: s.order.customerId, metadata: s.order.metadata })
          .from(s.order).where(and(eq(s.order.storeId, st.id), eq(s.order.idempotencyKey, idemKey))).limit(1);
        if (prior) {
          const [pl] = await tx
            .select({ variantId: s.orderLine.variantId, stripePriceId: s.productVariant.stripePriceId })
            .from(s.orderLine).innerJoin(s.productVariant, eq(s.productVariant.id, s.orderLine.variantId))
            .where(eq(s.orderLine.orderId, prior.id)).limit(1);
          const meta = (prior.metadata ?? {}) as { subscription?: boolean; subscriptionCheckoutUrl?: string };
          if (prior.customerId !== cust.id || !meta.subscription || !pl || pl.variantId !== variantId) return { kind: 'keyConflict' };
          if (meta.subscriptionCheckoutUrl) return { kind: 'replayUrl', url: meta.subscriptionCheckoutUrl };
          if (!pl.stripePriceId) return { kind: 'badVariant' };
          // The order committed but no session URL was stored (crash between the two steps): create the session again.
          return { kind: 'ok', orderId: prior.id, orderCode: prior.code, priceId: pl.stripePriceId, customerId: cust.id, email: cust.email };
        }
      }
      // Purchasable: same predicate as the catalog routes (variant enabled and not deleted, product active and not deleted).
      const [v] = await tx
        .select({ id: s.productVariant.id, sku: s.productVariant.sku, name: s.productVariant.name, price: s.productVariant.price, stripePriceId: s.productVariant.stripePriceId, salePrice: s.productVariant.salePrice })
        .from(s.productVariant)
        .innerJoin(s.product, eq(s.product.id, s.productVariant.productId))
        .where(and(
          eq(s.productVariant.id, variantId), isNull(s.productVariant.deletedAt), eq(s.productVariant.enabled, true),
          eq(s.product.status, 'active'), isNull(s.product.deletedAt),
        ))
        .limit(1);
      if (!v || !v.stripePriceId) return { kind: 'badVariant' };
      const unitPrice = v.salePrice != null ? v.salePrice : v.price;
      const orderId = randomUUID();
      const { code } = await withOrderNumber(tx, st.id, (code) => tx.insert(s.order).values({
        id: orderId, storeId: st.id, code, customerId: cust.id, state: 'PendingPayment',
        currency: st.currency, subtotal: unitPrice, grandTotal: unitPrice,
        idempotencyKey: idemKey,
        metadata: { subscription: true },
      }));
      await tx.insert(s.orderLine).values({
        storeId: st.id, orderId, variantId: v.id, variantSku: v.sku, variantName: v.name,
        quantity: 1, unitPrice, lineSubtotal: unitPrice, lineDiscount: 0, lineTax: 0, lineTotal: unitPrice,
      });
      return { kind: 'ok', orderId, orderCode: code, priceId: v.stripePriceId, customerId: cust.id, email: cust.email };
    });
    let out: R;
    try { out = await run(); } catch (e) {
      // A concurrent request with the same key committed first (unique (store, key)): the second pass replays it.
      if (idemKey && hasPgCode(e, ['23505'])) out = await run(); else throw e;
    }

    if (out.kind === 'unauth') return errJson(c, 401, 'NOT_AUTHENTICATED', 'not authenticated');
    if (out.kind === 'badVariant') return errJson(c, 400, 'VARIANT_NOT_RECURRING', 'variant is not a recurring plan');
    if (out.kind === 'keyConflict') return errJson(c, 409, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency-Key was already used for a different request');
    if (out.kind === 'replayUrl') return c.json({ url: out.url }, 200);

    const base = env.STOREFRONT_URL.replace(/\/$/, '');
    const session = await createSubscriptionCheckout(st.id, mode, {
      priceId: out.priceId,
      successUrl: `${base}/account/subscriptions?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/account/subscriptions?canceled=1`,
      customerEmail: out.email,
      metadata: { storeId: st.id, orderCode: out.orderCode, customerId: out.customerId },
      idempotencyKey: `subscribe:${out.orderCode}`,
    });
    if (idemKey) {
      // Keep the session URL on the order so a retry with the same key returns it. Best effort: a miss only means a
      // retry creates a fresh session for the same order.
      await withStore(st.id, (tx) => tx.update(s.order)
        .set({ metadata: sql`coalesce(${s.order.metadata}, '{}'::jsonb) || ${JSON.stringify({ subscriptionCheckoutUrl: session.url, subscriptionCheckoutSessionId: session.sessionId })}::jsonb` })
        .where(and(eq(s.order.id, out.orderId), eq(s.order.storeId, st.id)))).catch(() => undefined);
    }
    return c.json({ url: session.url }, 200);
  },
);

// POST /v1/shop/account/billing-portal — open the Stripe Customer Portal for the
// authenticated customer (cancel / update card). Resolves the stripeCustomerId
// from the customer's most recent subscription.
subscriptions.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/account/billing-portal', summary: 'Open the billing portal',
    responses: {
      200: { description: 'Portal URL', content: { 'application/json': { schema: z.object({ url: z.string() }) } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: apiErrorSchema() } } },
      404: { description: 'No subscription', content: { 'application/json': { schema: apiErrorSchema() } } },
      503: { description: 'Stripe not configured', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const mode = stripeModeFromConfig(st.config);
    if (!(await resolveStripeUsable(st.id, mode))) return errJson(c, 503, 'STRIPE_NOT_CONFIGURED', `stripe is not configured (${mode} mode)`);
    const out = await withStore(st.id, async (tx): Promise<{ kind: 'unauth' } | { kind: 'none' } | { kind: 'ok'; stripeCustomerId: string }> => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return { kind: 'unauth' };
      const [row] = await tx
        .select({ stripeCustomerId: s.subscription.stripeCustomerId })
        .from(s.subscription)
        .where(and(eq(s.subscription.customerId, cust.id), sql`${s.subscription.stripeCustomerId} is not null`))
        .orderBy(desc(s.subscription.createdAt))
        .limit(1);
      if (!row?.stripeCustomerId) return { kind: 'none' };
      return { kind: 'ok', stripeCustomerId: row.stripeCustomerId };
    });
    if (out.kind === 'unauth') return errJson(c, 401, 'NOT_AUTHENTICATED', 'not authenticated');
    if (out.kind === 'none') return errJson(c, 404, 'SUBSCRIPTION_NOT_FOUND', 'no subscription found');
    const base = env.STOREFRONT_URL.replace(/\/$/, '');
    const url = await createBillingPortal(st.id, mode, { customerId: out.stripeCustomerId, returnUrl: `${base}/account/subscriptions` });
    return c.json({ url }, 200);
  },
);

// GET /v1/admin/subscriptions — admin list (mirrors the orders list).
subscriptions.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/subscriptions', summary: 'List subscriptions',
    request: { query: z.object({ status: z.string().optional(), customerId: z.guid().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }) },
    responses: { 200: { description: 'OK', content: J(Page) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { status, customerId, page, pageSize } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const conds = [] as ReturnType<typeof eq>[];
      if (status) conds.push(sql`${s.subscription.status} = ${status}` as never);
      if (customerId) conds.push(eq(s.subscription.customerId, customerId) as never);
      const where = conds.length ? and(...conds) : undefined;
      const base = tx
        .select({
          id: s.subscription.id, status: s.subscription.status, priceId: s.subscription.priceId,
          stripeSubscriptionId: s.subscription.stripeSubscriptionId,
          currentPeriodEnd: s.subscription.currentPeriodEnd, cancelAtPeriodEnd: s.subscription.cancelAtPeriodEnd,
          createdAt: s.subscription.createdAt, email: s.customer.email,
        })
        .from(s.subscription)
        .leftJoin(s.customer, eq(s.customer.id, s.subscription.customerId))
        .$dynamic();
      const rows = await (where ? base.where(where) : base)
        .orderBy(desc(s.subscription.createdAt))
        .limit(pageSize).offset((page - 1) * pageSize);
      const cntBase = tx.select({ n: sql<number>`count(*)::int` }).from(s.subscription).$dynamic();
      const [cnt] = await (where ? cntBase.where(where) : cntBase);
      return {
        items: rows.map((r) => ({
          ...r,
          currentPeriodEnd: r.currentPeriodEnd ? r.currentPeriodEnd.toISOString() : null,
          createdAt: r.createdAt.toISOString(),
        })),
        total: cnt?.n ?? 0, page, pageSize,
      };
    });
    return c.json(out, 200);
  }),
);
