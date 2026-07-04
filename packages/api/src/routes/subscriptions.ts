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
import { resolveStoreFromCtx } from './store-context.js';
import * as s from '../db/schema.js';
import { customerToken, resolveCustomer, type SessionCustomer } from '../auth/session.js';
import { createSubscriptionCheckout, createBillingPortal, stripeModeFromConfig, stripeUsable } from '../payments/stripe.js';
import { isPaymentMethodEnabled } from '../payments/provider.js';
import { env } from '../env.js';
import { J, Page, errBody, requireAdmin, requireStore, guard } from './admin-helpers.js';

const orderCode = () => ('SR' + randomUUID().replace(/-/g, '').slice(0, 10)).toUpperCase();

async function me(tx: Tx, token: string | null): Promise<SessionCustomer | null> {
  return token ? resolveCustomer(tx, token) : null;
}

export const subscriptions = new OpenAPIHono();

// POST /v1/shop/subscribe — start a recurring plan. Auth required (a plan needs a
// customerId for license ownership + a stripeCustomerId for the portal). The
// variant MUST have a stripePriceId (else 400). Creates a PendingPayment order
// (one line) then a Stripe Checkout Session (mode:subscription).
subscriptions.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/subscribe', summary: 'Subscribe to a recurring plan',
    request: { body: { content: { 'application/json': { schema: z.object({ variantId: z.guid() }) } } } },
    responses: {
      200: { description: 'Checkout URL', content: { 'application/json': { schema: z.object({ url: z.string() }) } } },
      400: { description: 'Not a recurring variant', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      409: { description: 'Stripe disabled', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      503: { description: 'Stripe not configured', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { variantId } = c.req.valid('json');
    if (!isPaymentMethodEnabled(st.config, 'stripe')) return c.json({ error: 'payment method disabled: stripe' }, 409);
    const mode = stripeModeFromConfig(st.config);
    if (!stripeUsable(mode)) return c.json({ error: `stripe is not configured (${mode} mode)` }, 503);

    type R =
      | { kind: 'unauth' }
      | { kind: 'badVariant' }
      | { kind: 'ok'; orderCode: string; priceId: string; customerId: string; email: string };
    const out = await withStore(st.id, async (tx): Promise<R> => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return { kind: 'unauth' };
      const [v] = await tx
        .select({ id: s.productVariant.id, sku: s.productVariant.sku, name: s.productVariant.name, price: s.productVariant.price, stripePriceId: s.productVariant.stripePriceId, salePrice: s.productVariant.salePrice })
        .from(s.productVariant)
        .where(and(eq(s.productVariant.id, variantId), isNull(s.productVariant.deletedAt)))
        .limit(1);
      if (!v || !v.stripePriceId) return { kind: 'badVariant' };
      const unitPrice = v.salePrice != null ? v.salePrice : v.price;
      const orderId = randomUUID();
      const code = orderCode();
      await tx.insert(s.order).values({
        id: orderId, storeId: st.id, code, customerId: cust.id, state: 'PendingPayment',
        currency: st.currency, subtotal: unitPrice, grandTotal: unitPrice,
        metadata: { subscription: true },
      });
      await tx.insert(s.orderLine).values({
        storeId: st.id, orderId, variantId: v.id, variantSku: v.sku, variantName: v.name,
        quantity: 1, unitPrice, lineSubtotal: unitPrice, lineDiscount: 0, lineTax: 0, lineTotal: unitPrice,
      });
      return { kind: 'ok', orderCode: code, priceId: v.stripePriceId, customerId: cust.id, email: cust.email };
    });

    if (out.kind === 'unauth') return c.json({ error: 'not authenticated' }, 401);
    if (out.kind === 'badVariant') return c.json({ error: 'variant is not a recurring plan' }, 400);

    const base = env.STOREFRONT_URL.replace(/\/$/, '');
    const session = await createSubscriptionCheckout(mode, {
      priceId: out.priceId,
      successUrl: `${base}/account/subscriptions?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/account/subscriptions?canceled=1`,
      customerEmail: out.email,
      metadata: { storeId: st.id, orderCode: out.orderCode, customerId: out.customerId },
    });
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
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      404: { description: 'No subscription', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      503: { description: 'Stripe not configured', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const mode = stripeModeFromConfig(st.config);
    if (!stripeUsable(mode)) return c.json({ error: `stripe is not configured (${mode} mode)` }, 503);
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
    if (out.kind === 'unauth') return c.json({ error: 'not authenticated' }, 401);
    if (out.kind === 'none') return c.json({ error: 'no subscription found' }, 404);
    const base = env.STOREFRONT_URL.replace(/\/$/, '');
    const url = await createBillingPortal(mode, { customerId: out.stripeCustomerId, returnUrl: `${base}/account/subscriptions` });
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
