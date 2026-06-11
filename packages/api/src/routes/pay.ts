import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStore, DEV_DEFAULT_STORE, type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { getProvider, isPaymentMethodEnabled } from '../payments/provider.js';
import { applyPaymentResult } from '../payments/settle.js';
import { createPaymentIntent, stripeConfigured } from '../payments/stripe.js';
import { clientIp, loginRetryAfter } from '../auth/rate-limit.js';

async function store(c: { req: { header: (k: string) => string | undefined } }): Promise<StoreCtx> {
  const slug = c.req.header('x-store-slug') ?? DEV_DEFAULT_STORE;
  return resolveStore(slug);
}

export const pay = new OpenAPIHono();

// POST /v1/shop/orders/{code}/pay — take payment for an order, idempotent.
pay.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/orders/{code}/pay',
    summary: 'Pay for an order (PendingPayment -> Paid)',
    request: {
      params: z.object({ code: z.string() }),
      headers: z.object({ 'idempotency-key': z.string().optional() }),
      body: { content: { 'application/json': { schema: z.object({ method: z.string().default('manual'), token: z.unknown().optional() }) } } },
    },
    responses: {
      200: { description: 'Paid', content: { 'application/json': { schema: z.object({ code: z.string(), state: z.string(), payment: z.string() }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      409: { description: 'Not payable', content: { 'application/json': { schema: z.object({ error: z.string(), state: z.string() }) } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { code } = c.req.valid('param');
    const { method, token } = c.req.valid('json');
    const idemKey = c.req.header('idempotency-key');
    // Rate-limit: payment attempts per IP. Keyed on ip+method so a flood of
    // card-testing on one gateway doesn't trip the throttle for a different
    // method on the same IP. Idempotency keys are per-attempt, so the same
    // client retrying the SAME intent is safe (the claim short-circuits).
    const payIp = clientIp(c);
    const payBucket = `pay:${payIp}:${method}`;
    const payRetry = loginRetryAfter(payIp, payBucket);
    if (payRetry > 0) return c.json({ error: `too many payment attempts — try again in ${payRetry}s` }, 429);

    const provider = getProvider(method);
    if (!provider) return c.json({ error: `unknown payment method: ${method}` }, 404);
    if (!isPaymentMethodEnabled(st.config, method)) return c.json({ error: `payment method disabled: ${method}`, state: 'Disabled' }, 409);

    type R =
      | { kind: 'notfound' }
      | { kind: 'badstate'; state: string }
      | { kind: 'noop'; state: string }
      | { kind: 'ok'; state: string; payment: string };

    const out: R = await withStore(st.id, async (tx): Promise<R> => {
      const [order] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      if (!order) return { kind: 'notfound' };
      if (order.state !== 'PendingPayment') return { kind: 'badstate', state: order.state };

      // WP1.2: idempotency is MANDATORY. If the client didn't send a key we
      // derive a deterministic one keyed on (orderCode, method) so the claim
      // ALWAYS runs and a concurrent double-submit can't double-charge. The
      // derived key is per-(order, method), so a deliberate retry of a Declined
      // payment must clear the claim first (handled below in the Declined branch).
      const claimKey = idemKey ?? `pay:${code}:${method}`;
      const claimed = await tx
        .insert(s.processedEvent)
        .values({ id: claimKey, storeId: st.id, type: 'payment' })
        .onConflictDoNothing()
        .returning({ id: s.processedEvent.id });
      if (claimed.length === 0) return { kind: 'noop', state: order.state };

      const result = await provider.createPayment({ orderCode: code, amount: order.grandTotal, currency: order.currency, token });
      // Shared with the Stripe webhook reconcile path (payments/settle.ts).
      const applied = await applyPaymentResult(tx, { storeId: st.id, order, method: provider.method, result });
      if (applied.orderState === 'Paid') return { kind: 'ok', state: 'Paid', payment: 'Settled' };
      // Declined / Failed: release the deterministic claim so the customer can
      // retry. The order STAYS in PendingPayment — auto-cancelling on a
      // transient decline would make recovery impossible (a real provider's
      // 3DS/network blip would leave the customer stuck). For client-supplied
      // keys, the caller can rotate by sending a new key.
      if ((result.state === 'Declined' || result.state === 'Failed') && !idemKey) {
        await tx.delete(s.processedEvent).where(and(eq(s.processedEvent.id, claimKey), eq(s.processedEvent.type, 'payment')));
      }
      return { kind: 'ok', state: applied.orderState, payment: result.state };
    });

    if (out.kind === 'notfound') return c.json({ error: 'order not found' }, 404);
    if (out.kind === 'badstate') return c.json({ error: 'order is not payable', state: out.state }, 409);
    return c.json({ code, state: out.state, payment: out.kind === 'noop' ? 'already-processed' : out.payment }, 200);
  },
);

// POST /v1/shop/orders/{code}/payment-intent — mint a Stripe PaymentIntent for
// this order (amount from the order row, never the client). Returns the
// client_secret for Stripe.js to confirm (3DS) on the storefront; the resulting
// intent id is then passed to /pay as `token`, where the provider verifies it.
pay.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/orders/{code}/payment-intent',
    summary: 'Create a Stripe PaymentIntent for an order',
    request: { params: z.object({ code: z.string() }) },
    responses: {
      200: { description: 'Intent', content: { 'application/json': { schema: z.object({ clientSecret: z.string(), intentId: z.string() }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      409: { description: 'Not payable', content: { 'application/json': { schema: z.object({ error: z.string(), state: z.string() }) } } },
      503: { description: 'Stripe not configured', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { code } = c.req.valid('param');
    if (!isPaymentMethodEnabled(st.config, 'stripe')) return c.json({ error: 'payment method disabled: stripe', state: 'Disabled' }, 409);
    if (!stripeConfigured()) return c.json({ error: 'stripe is not configured' }, 503);
    const order = await withStore(st.id, async (tx) => {
      const [o] = await tx.select({ id: s.order.id, state: s.order.state, grandTotal: s.order.grandTotal, currency: s.order.currency })
        .from(s.order).where(eq(s.order.code, code)).limit(1);
      return o ?? null;
    });
    if (!order) return c.json({ error: 'order not found' }, 404);
    if (order.state !== 'PendingPayment') return c.json({ error: 'order is not payable', state: order.state }, 409);
    const intent = await createPaymentIntent({ orderCode: code, storeId: st.id, amount: order.grandTotal, currency: order.currency });
    return c.json(intent, 200);
  },
);
