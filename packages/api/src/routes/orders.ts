import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, gt } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import { customerOwnsOrder } from '../auth/order-access.js';
import { customerToken, resolveCustomer } from '../auth/session.js';
import * as s from '../db/schema.js';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { loadOrderFulfillments, loadOrderLines, loadOrderPayments, loadOrderPromotionCode, loadOrderStatusFacts } from './order-facts.js';
import { apiErrorSchema, errJson } from '../lib/api-error.js';
import { claimReconcileSlot, reconcileStripeOrder } from '../payments/stripe-reconcile.js';
import { log } from '../lib/logger.js';
import { orderLoyaltySnapshot } from '../loyalty/ledger.js';
import { amountDueForOrder } from '../payments/settle.js';
import { summarizeEdit } from '../orders/balance-summary.js';

/** Constant-time string compare (avoids leaking the receipt token via timing). */
function tokensMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return cryptoTimingSafeEqual(ba, bb);
}

export const orders = new OpenAPIHono();

// GET /v1/shop/orders/{code} — order summary by code (confirmation page).
// SCOPED (P1 security): an order code is ~enumerable, so the read is granted ONLY
// when a matching receipt token is supplied (?rt=, returned by /checkout and
// carried to the confirmation page + Stripe return_url) OR the authed customer
// owns the order. A bare code with no token and no ownership reads as not-found
// (404, not 403 — no enumeration/PII disclosure).
orders.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/orders/{code}',
    summary: 'Order summary by code (receipt-token or owner scoped)',
    request: { params: z.object({ code: z.string() }), query: z.object({ rt: z.string().optional() }) },
    responses: {
      200: {
        description: 'Order',
        content: {
          'application/json': {
            schema: z.object({
              code: z.string(), state: z.string(), currency: z.string(),
              // Wire-facing status split (BREAKING, pre-1.0 — see CHANGELOG.md):
              // `state` above is the legacy combined FSM value and stays for
              // compatibility; these three are the new, separately-tracked
              // lifecycle/payment/fulfillment statuses (orders/status.ts).
              status: z.enum(['open', 'completed', 'cancelled', 'archived']),
              paymentStatus: z.enum(['pending', 'authorized', 'paid', 'partially_refunded', 'refunded', 'voided', 'failed', 'balance_due']),
              fulfillmentStatus: z.enum(['unfulfilled', 'partially_fulfilled', 'fulfilled', 'partially_delivered', 'delivered']),
              shippingMethodName: z.string().nullable(), subtotal: z.number().int(), shippingTotal: z.number().int(), taxTotal: z.number().int(),
              discountTotal: z.number().int(), grandTotal: z.number().int(),
              placedAt: z.string().nullable(),
              shippingAddress: z.any(),
              customerEmail: z.string().nullable(),
              promotionCode: z.string().nullable(),
              // R18: real payment facts — distinguish pending/paid/failed/
              // cancelled from the actual gateway record, not an invented
              // method or a "confirmed after N polls" heuristic.
              payments: z.array(z.object({
                method: z.string(), state: z.string(), amount: z.number().int(),
                providerRef: z.string().nullable(), errorMessage: z.string().nullable(), createdAt: z.string(),
              })),
              fulfillments: z.array(z.object({
                state: z.string(), trackingCode: z.string().nullable(), carrier: z.string().nullable(), updatedAt: z.string().nullable(),
              })),
              lines: z.array(z.object({
                sku: z.string(), name: z.string(), quantity: z.number().int(), unitPrice: z.number().int(), lineTotal: z.number().int(),
                image: z.string().nullable(), isPreOrder: z.boolean(), shipDate: z.string().nullable(),
              })),
              /** Points snapshot taken at checkout (REWARDS-1); null when the program was off. Earned points post when the order is paid. */
              /** Order editing: amount still owed on a Paid / PartiallyRefunded order after an edit raised the total (0 otherwise), plus a customer-safe summary of the latest edit. Same receipt-token / owner scope as the rest of this read. */
              amountDue: z.number().int(),
              balanceChange: z.object({ previousGrandTotal: z.number().int().nullable(), changes: z.array(z.string()), editedAt: z.string().nullable() }).nullable(),
              loyalty: z.object({ earnPoints: z.number().int(), redeemPoints: z.number().int(), pointsDiscount: z.number().int() }).nullable(),
            }),
          },
        },
      },
      404: { description: 'Not found', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { code } = c.req.valid('param');
    const { rt } = c.req.valid('query');
    const token = customerToken(c);
    // D1 settlement fallback: before reading, reconcile an unpaid order's
    // tracked Stripe intents with Stripe (webhook stays primary). Owner-only,
    // throttled per order, run with no transaction open, never fatal to the
    // read. Payment state only — the read below is always live.
    const pre = await withStore(st.id, async (tx) => {
      const [o] = await tx.select({ id: s.order.id, state: s.order.state, receiptToken: s.order.receiptToken, customerId: s.order.customerId, metadata: s.order.metadata })
        .from(s.order).where(and(eq(s.order.code, code), eq(s.order.storeId, st.id))).limit(1);
      if (!o || (o.state !== 'PendingPayment' && o.state !== 'Cancelled')) return null;
      let ok = tokensMatch(rt, o.receiptToken);
      if (!ok && token && o.customerId) ok = customerOwnsOrder(await resolveCustomer(tx, token), o);
      return ok ? o.id : null;
    });
    if (pre && claimReconcileSlot(st.id, pre)) {
      await reconcileStripeOrder(st.id, { orderId: pre }, { actor: 'shopper:order-read' })
        .catch((e: unknown) => log.warn('stripe reconcile on order read failed', { err: e instanceof Error ? e.message : String(e), code }));
    }
    const out = await withStore(st.id, async (tx) => {
      const [o] = await tx.select().from(s.order).where(and(eq(s.order.code, code), eq(s.order.storeId, st.id))).limit(1);
      if (!o) return null;
      // Grant: receipt-token match OR authed ownership. Else treat as not-found.
      let granted = tokensMatch(rt, o.receiptToken);
      if (!granted && token && o.customerId) {
        const cust = await resolveCustomer(tx, token);
        granted = customerOwnsOrder(cust, o);
      }
      if (!granted) return null;
      // Guest checkouts still link an order to a synthetic/matched customer
      // row (see order.customerId) purely to carry the email the confirmation
      // page shows under "Contact" — not an account. Null when genuinely absent.
      let customerEmail: string | null = null;
      if (o.customerId) {
        const [cust] = await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, o.customerId)).limit(1);
        customerEmail = cust?.email ?? null;
      }
      // Lines snapshot sku/name/price at purchase time (survives the variant
      // later being edited or deleted); image/isPreOrder/shipDate resolve
      // from the current variant (order-facts.ts documents the tradeoff).
      // Sequential, not Promise.all: these share one transaction/connection —
      // concurrent queries on the same pg connection are not safe.
      const lines = await loadOrderLines(tx, o.id);
      const payments = await loadOrderPayments(tx, o.id);
      const fulfillments = await loadOrderFulfillments(tx, o.id);
      const promotionCode = await loadOrderPromotionCode(tx, o.promotionId);
      const { status, paymentStatus, fulfillmentStatus } = await loadOrderStatusFacts(tx, o);
      const balanceState = o.state === 'Paid' || o.state === 'PartiallyRefunded';
      const due = balanceState ? Math.max(0, await amountDueForOrder(tx, st.id, o.id, o.grandTotal)) : 0;
      let balanceChange: ReturnType<typeof summarizeEdit> | null = null;
      if (due > 0) {
        const [edit] = await tx.select({ before: s.orderEdit.before, after: s.orderEdit.after, createdAt: s.orderEdit.createdAt })
          .from(s.orderEdit).where(and(eq(s.orderEdit.orderId, o.id), gt(s.orderEdit.balance, 0)))
          .orderBy(desc(s.orderEdit.createdAt)).limit(1);
        if (edit) balanceChange = summarizeEdit(edit.before, edit.after, edit.createdAt);
      }
      return {
        code: o.code, state: o.state, status, paymentStatus, fulfillmentStatus, currency: o.currency,
        shippingMethodName: o.shippingMethodName, subtotal: o.subtotal, shippingTotal: o.shippingTotal, taxTotal: o.taxTotal, discountTotal: o.discountTotal, grandTotal: o.grandTotal,
        placedAt: o.placedAt ? o.placedAt.toISOString() : null,
        shippingAddress: o.shippingAddress ?? null, customerEmail, promotionCode,
        payments, fulfillments, lines, amountDue: due, balanceChange,
        loyalty: (() => { const l = orderLoyaltySnapshot(o.metadata); return l ? { earnPoints: l.earnPoints, redeemPoints: l.redeemPoints, pointsDiscount: l.pointsDiscount } : null; })(),
      };
    });
    if (!out) return errJson(c, 404, 'ORDER_NOT_FOUND', 'order not found');
    return c.json(out, 200);
  },
);
