import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { withAdvisoryLock, withStore } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import * as s from '../db/schema.js';
import { getProvider, isPaymentMethodEnabled } from '../payments/provider.js';
import { applyPaymentResult, amountDueForOrder } from '../payments/settle.js';
import { createPaymentIntent, resolveStripeUsable, stripeModeFromConfig } from '../payments/stripe.js';
import { clientIp, loginRetryAfter } from '../auth/rate-limit.js';
import { apiErrorSchema, errJson } from '../lib/api-error.js';
import { customerToken } from '../auth/session.js';
import { GatewayPaymentError, ownedOrder } from '../payments/gateway-payment.js';
import { trackStripeIntent, reconcileStripeOrder, claimReconcileSlot } from '../payments/stripe-reconcile.js';

/** D13: the same ownership rule gateway-payment uses — a matching receipt
 *  token (x-receipt-token, returned by POST /checkout) or the signed-in
 *  customer who owns the order. Anything else reads as not-found. */
async function ownsOrder(tx: Parameters<typeof ownedOrder>[0], code: string, receipt: string | undefined, session: string | null | undefined) {
  try { return await ownedOrder(tx, code, receipt, session); }
  catch (e) { if (e instanceof GatewayPaymentError) return null; throw e; }
}

export const pay = new OpenAPIHono();

// POST /v1/shop/orders/{code}/pay — take payment for an order, idempotent.
// At launch Stripe is the only shopper-capable gateway. Offline/internal
// tenders (manual, COD, gift_card) have separate lifecycle/accounting semantics
// and are deliberately excluded at the public API boundary.
pay.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/orders/{code}/pay',
    summary: 'Pay for an order (PendingPayment -> Paid)',
    request: {
      params: z.object({ code: z.string() }),
      headers: z.object({ 'idempotency-key': z.string().optional(), 'x-receipt-token': z.string().optional() }),
      body: { content: { 'application/json': { schema: z.object({ method: z.literal('stripe'), token: z.unknown().optional() }) } } },
    },
    responses: {
      200: { description: 'Paid', content: { 'application/json': { schema: z.object({ code: z.string(), state: z.string(), payment: z.string() }) } } },
      400: { description: 'Already covered / invalid request', content: { 'application/json': { schema: apiErrorSchema().extend({ state: z.string().optional() }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: apiErrorSchema() } } },
      409: { description: 'Not payable', content: { 'application/json': { schema: apiErrorSchema().extend({ state: z.string() }) } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { code } = c.req.valid('param');
    const { method, token } = c.req.valid('json');
    const idemKey = c.req.header('idempotency-key');
    const receipt = c.req.header('x-receipt-token');
    const session = customerToken(c);
    // Rate-limit: payment attempts per IP. Keyed on ip+method so a flood of
    // card-testing on one gateway doesn't trip the throttle for a different
    // method on the same IP. Idempotency keys are per-attempt, so the same
    // client retrying the SAME intent is safe (the claim short-circuits).
    const payIp = clientIp(c);
    const payBucket = `pay:${payIp}:${method}`;
    const payRetry = await loginRetryAfter(payIp, payBucket);
    if (payRetry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many payment attempts — try again in ${payRetry}s`);

    const provider = getProvider(method);
    // z.literal above makes this unreachable for a well-formed request, but keep
    // the provider guard fail-closed in case the route contract changes later.
    if (!provider) return errJson(c, 404, 'PAYMENT_METHOD_UNKNOWN', `unknown payment method: ${method}`);
    if (!isPaymentMethodEnabled(st.config, method)) return errJson(c, 409, 'PAYMENT_METHOD_DISABLED', `payment method disabled: ${method}`, { extra: { state: 'Disabled' } });

    type R =
      | { kind: 'notfound' }
      | { kind: 'badstate'; state: string }
      | { kind: 'nodue'; state: string }
      | { kind: 'noop'; state: string }
      | { kind: 'ok'; state: string; payment: string };

    const claimKey = idemKey ? `pay:${st.id}:${code}:${method}:${idemKey}` : `pay:${st.id}:${code}:${method}`;
    const out: R = await withAdvisoryLock(`pay:${st.id}:${code}`, async () => {
      const prepared = await withStore(st.id, async (tx) => {
        const order = await ownsOrder(tx, code, receipt, session);
        if (!order) return { kind: 'notfound' as const };
        if (order.state !== 'PendingPayment') return { kind: 'badstate' as const, state: order.state };
        // MONEY-3: charge only what's still owed. Any settled tender already
        // recorded against this order is deducted before gateway capture.
        const amountDue = await amountDueForOrder(tx, st.id, order.id, order.grandTotal);
        if (amountDue <= 0) return { kind: 'nodue' as const, state: order.state };
        const [existing] = await tx
          .select({ id: s.processedEvent.id })
          .from(s.processedEvent)
          .where(and(eq(s.processedEvent.id, claimKey), eq(s.processedEvent.type, 'payment')))
          .limit(1);
        if (existing) return { kind: 'noop' as const, state: order.state };
        return { kind: 'ready' as const, order, amountDue };
      });
      if (prepared.kind !== 'ready') return prepared;

      // No transaction is open while the provider verifies or settles payment.
      // The session-level advisory lock serializes concurrent /pay calls for this
      // order; Stripe/webhook reconciliation remains DB-idempotent.
      const result = await provider.createPayment({
        orderCode: code,
        storeId: st.id,
        amount: prepared.amountDue,
        currency: prepared.order.currency,
        token,
        stripeMode: stripeModeFromConfig(st.config),
      });

      return withStore(st.id, async (tx): Promise<R> => {
        const [order] = await tx.select().from(s.order).where(eq(s.order.id, prepared.order.id)).limit(1).for('update');
        if (!order) return { kind: 'notfound' };
        // MONEY-4: the order may have been auto-cancelled (stale-allocation TTL
        // job) between the pre-charge check above and the gateway call actually
        // completing. If real money just settled, do NOT silently drop it —
        // fall through so applyPaymentResult records the ledger row + audit
        // flag. Any other non-payable state, or a non-Settled result, still
        // short-circuits as before (nothing was actually charged).
        const cancelledButSettled = order.state === 'Cancelled' && result.state === 'Settled';
        if (order.state !== 'PendingPayment' && !cancelledButSettled) return { kind: 'badstate', state: order.state };
        const claimed = await tx
          .insert(s.processedEvent)
          .values({ id: claimKey, storeId: st.id, type: 'payment' })
          .onConflictDoNothing()
          .returning({ id: s.processedEvent.id });
        if (claimed.length === 0) return { kind: 'noop', state: order.state };

        const applied = await applyPaymentResult(tx, {
          storeId: st.id,
          order: { ...order, code },
          method: provider.method,
          result,
          amount: prepared.amountDue,
        });
        if (applied.orderState === 'Paid') return { kind: 'ok', state: 'Paid', payment: 'Settled' };
        if ((result.state === 'Declined' || result.state === 'Failed') && !idemKey) {
          await tx.delete(s.processedEvent).where(and(eq(s.processedEvent.id, claimKey), eq(s.processedEvent.type, 'payment')));
        }
        if (cancelledButSettled) return { kind: 'badstate', state: 'Cancelled' };
        return { kind: 'ok', state: applied.orderState, payment: result.state };
      });
    });

    if (out.kind === 'notfound') return errJson(c, 404, 'ORDER_NOT_FOUND', 'order not found');
    if (out.kind === 'nodue') return errJson(c, 400, 'ORDER_ALREADY_PAID', 'order already fully paid', { extra: { state: out.state } });
    if (out.kind === 'badstate') return errJson(c, 409, 'ORDER_NOT_PAYABLE', 'order is not payable', { extra: { state: out.state } });
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
    request: { params: z.object({ code: z.string() }), headers: z.object({ 'x-receipt-token': z.string().optional() }) },
    responses: {
      200: { description: 'Intent', content: { 'application/json': { schema: z.object({ clientSecret: z.string(), intentId: z.string() }) } } },
      400: { description: 'Already covered', content: { 'application/json': { schema: apiErrorSchema().extend({ state: z.string() }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: apiErrorSchema() } } },
      409: { description: 'Not payable', content: { 'application/json': { schema: apiErrorSchema().extend({ state: z.string() }) } } },
      503: { description: 'Stripe not configured', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { code } = c.req.valid('param');
    if (!isPaymentMethodEnabled(st.config, 'stripe')) return errJson(c, 409, 'PAYMENT_METHOD_DISABLED', 'payment method disabled: stripe', { extra: { state: 'Disabled' } });
    const mode = stripeModeFromConfig(st.config);
    // stripeUsable (not just secret-key present) — the same gate /shop/config
    // advertises, so the storefront never shows Stripe then gets a 503 here (and
    // vice-versa). Needs a mode-matched sk_ AND a mode-matched pk_.
    if (!(await resolveStripeUsable(st.id, mode))) return errJson(c, 503, 'STRIPE_NOT_CONFIGURED', `stripe is not configured (${mode} mode)`);
    const receipt = c.req.header('x-receipt-token');
    const session = customerToken(c);
    const prepared = await withStore(st.id, async (tx) => {
      // D13: only the order's owner (receipt token / signed-in customer) can
      // mint an intent or learn the amount due.
      const o = await ownsOrder(tx, code, receipt, session);
      if (!o) return null;
      // MONEY-3: mint the intent for what's actually still owed, never the raw
      // order total, so an existing settled tender cannot be charged twice.
      const amountDue = await amountDueForOrder(tx, st.id, o.id, o.grandTotal);
      return { order: o, amountDue };
    });
    if (!prepared) return errJson(c, 404, 'ORDER_NOT_FOUND', 'order not found');
    const { order, amountDue } = prepared;
    if (order.state !== 'PendingPayment') return errJson(c, 409, 'ORDER_NOT_PAYABLE', 'order is not payable', { extra: { state: order.state } });
    if (amountDue <= 0) return errJson(c, 400, 'ORDER_ALREADY_PAID', 'order already fully paid', { extra: { state: order.state } });
    // Idempotent: key the Stripe create on the order id AND the amount so a
    // double-submit/retry reuses the order's open PaymentIntent (same
    // client_secret) instead of minting a second one — but a later call after
    // the amount due changes mints a fresh intent rather than reusing a stale one.
    const intent = await createPaymentIntent({ orderCode: code, storeId: st.id, amount: amountDue, currency: order.currency, mode, idempotencyKey: `pi:${order.id}:${amountDue}` });
    // D5: track the PI durably (idempotent on the PI id) so the sweeper,
    // the refresh route and admin reconciliation can find in-flight money.
    await withStore(st.id, (tx) => trackStripeIntent(tx, st.id, { orderId: order.id, intentId: intent.intentId, amount: amountDue, currency: order.currency, mode }));
    return c.json(intent, 200);
  },
);

// POST /v1/shop/orders/{code}/payment/refresh — D1 settlement fallback the
// confirmation page can call: re-reads each tracked Stripe PaymentIntent for
// this order from Stripe and settles through the webhook's idempotent path
// (paid effects / confirmation email fire exactly once). Owner-only (receipt
// token or signed-in customer). Payment state only — no stock or data cache.
pay.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/orders/{code}/payment/refresh',
    summary: 'Re-check the order\'s Stripe payment with Stripe (settlement fallback)',
    request: { params: z.object({ code: z.string() }), headers: z.object({ 'x-receipt-token': z.string().optional() }) },
    responses: {
      200: { description: 'Refreshed', content: { 'application/json': { schema: z.object({
        code: z.string(), state: z.string(),
        intents: z.array(z.object({ intentId: z.string(), outcome: z.string() })),
      }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { code } = c.req.valid('param');
    const receipt = c.req.header('x-receipt-token');
    const session = customerToken(c);
    const owned = await withStore(st.id, (tx) => ownsOrder(tx, code, receipt, session));
    if (!owned) return errJson(c, 404, 'ORDER_NOT_FOUND', 'order not found');
    // Throttled per order (at most one Stripe round-trip per window): a
    // polling confirmation page cannot fan out into a Stripe request storm.
    if (!claimReconcileSlot(st.id, owned.id)) return c.json({ code, state: owned.state, intents: [] }, 200);
    const r = await reconcileStripeOrder(st.id, { orderId: owned.id }, { actor: 'shopper:refresh' });
    return c.json({ code, state: r.state ?? owned.state, intents: r.intents.map((i) => ({ intentId: i.intentId, outcome: i.outcome })) }, 200);
  },
);
