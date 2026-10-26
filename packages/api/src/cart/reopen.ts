/**
 * #370: reopen a converted cart whose order was never paid, so the shopper can change the cart again.
 *
 * Checkout converts the cart into a `PendingPayment` order and the cart becomes terminal. A shopper who then goes back
 * to add or change an item asks for the cart back: the unpaid order is cancelled (stock, loyalty and the payment
 * reservation released, exactly as the stale-order job does) and the same cart, lines intact, is active again. The next
 * checkout creates a new order.
 *
 * Money is never stranded: open Stripe intents are cancelled at Stripe first (a succeeded intent settles the order
 * instead, and the cart stays converted), and an order with a payment in flight, an unresolved provider attempt or an
 * unknown Stripe side is refused. Re-checked under the order's lock set immediately before the cancel.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { LockSetUnstable, withLockedSet } from '../db/locks.js';
import * as s from '../db/schema.js';
import { onStockChanged } from '../manifest/stock-hook.js';
import { cancelUnpaidOrderInSet, unpaidCancellablePredicate } from '../orders/cancel-unpaid.js';
import { cancelOrderStripeIntents, discoverUntrackedForOrder, stripeDiscoverable } from '../payments/stripe-reconcile.js';
import type { StoreCtx } from '../store-context.js';

export const REOPEN_ACTOR = 'shopper:cart-reopen';

/** `paid`: the order is paid (or past payment). `payment_in_progress`: a payment is in flight or could not be resolved
 *  yet — the shopper continues at checkout. `not_found`: no such cart, or a merged/orderless one. */
export type ReopenOutcome = { ok: true } | { ok: false; reason: 'not_found' | 'paid' | 'payment_in_progress' };

/** A provider attempt or payment that means money may be moving: never cancel the order under it. */
async function paymentInFlight(storeId: string, orderId: string): Promise<boolean> {
  return withStore(storeId, async (tx) => {
    const [attempt] = await tx.select({ id: s.paymentAttempt.id }).from(s.paymentAttempt).where(and(
      eq(s.paymentAttempt.orderId, orderId), inArray(s.paymentAttempt.status, ['processing', 'unknown', 'pending']),
    )).limit(1);
    if (attempt) return true;
    const [payment] = await tx.select({ id: s.payment.id }).from(s.payment).where(and(
      eq(s.payment.orderId, orderId), inArray(s.payment.state, ['Pending', 'Authorized']),
    )).limit(1);
    return !!payment;
  });
}

export async function reopenConvertedCart(st: StoreCtx, token: string, cartTtl: (now: Date) => Date): Promise<ReopenOutcome> {
  const found = await withStore(st.id, async (tx) => {
    const [cart] = await tx.select({ id: s.cart.id, status: s.cart.status, orderId: s.cart.convertedOrderId })
      .from(s.cart).where(and(eq(s.cart.token, token), eq(s.cart.storeId, st.id))).limit(1);
    if (!cart) return null;
    if (cart.status !== 'converted' || !cart.orderId) return { cart, order: null, hasIntent: false };
    const [order] = await tx.select({
      id: s.order.id, code: s.order.code, state: s.order.state, metadata: s.order.metadata, grandTotal: s.order.grandTotal, currency: s.order.currency,
    }).from(s.order).where(and(eq(s.order.id, cart.orderId), eq(s.order.storeId, st.id))).limit(1);
    const [intent] = order
      ? await tx.select({ id: s.paymentAttempt.id }).from(s.paymentAttempt)
        .where(and(eq(s.paymentAttempt.orderId, order.id), eq(s.paymentAttempt.operation, 'intent'))).limit(1)
      : [];
    return { cart, order: order ?? null, hasIntent: !!intent };
  });
  if (!found) return { ok: false, reason: 'not_found' };
  // Already open (a second tab got here first): nothing to do.
  if (found.cart.status === 'active' || found.cart.status === 'abandoned') return { ok: true };
  const order = found.order;
  if (!order) return { ok: false, reason: 'not_found' };
  if (order.state !== 'PendingPayment' && order.state !== 'Cancelled') return { ok: false, reason: 'paid' };

  const requireDiscovery = await stripeDiscoverable(st.id, st.config);
  if (order.state === 'PendingPayment') {
    // Cheap checks before any provider call: a card being charged, a redirect payment awaiting its return.
    if (await paymentInFlight(st.id, order.id)) return { ok: false, reason: 'payment_in_progress' };
    if (requireDiscovery && !found.hasIntent) {
      const d = await discoverUntrackedForOrder(st.id, order);
      if (d.held) return { ok: false, reason: 'payment_in_progress' };
    }
    // Stripe calls run with no transaction open: open intents are cancelled, a succeeded one settles the order.
    await cancelOrderStripeIntents(st.id, order.id, REOPEN_ACTOR);
  }

  let released = 0;
  try {
    const res = await withLockedSet(st.id, { kind: 'order', orderId: order.id }, async (tx, held): Promise<ReopenOutcome> => {
      const [cur] = await tx.select({ state: s.order.state }).from(s.order).where(eq(s.order.id, order.id)).limit(1);
      if (!cur) return { ok: false, reason: 'not_found' };
      if (cur.state === 'PendingPayment') {
        // Any age qualifies: the shopper is abandoning this order now. Every other stale-cancel condition still holds.
        const claimed = await tx.execute(sql`SELECT id FROM "order" WHERE id = ${order.id}
          AND ${unpaidCancellablePredicate(st.id, new Date(Date.now() + 60_000), requireDiscovery)}`);
        if (!(claimed as unknown as { rows: unknown[] }).rows.length) return { ok: false, reason: 'payment_in_progress' };
        released = await cancelUnpaidOrderInSet(tx, held, {
          storeId: st.id, orderId: order.id, actor: REOPEN_ACTOR, reason: { reason: 'cart_reopened' },
          stripeDiscoverable: requireDiscovery, apply: true,
        });
      } else if (cur.state !== 'Cancelled') {
        return { ok: false, reason: 'paid' };
      }
      const now = new Date();
      const [reopened] = await tx.update(s.cart)
        .set({ status: 'active', convertedOrderId: null, revision: sql`${s.cart.revision} + 1`, updatedAt: now, expiresAt: cartTtl(now) })
        .where(and(eq(s.cart.id, found.cart.id), eq(s.cart.status, 'converted'), eq(s.cart.convertedOrderId, order.id)))
        .returning({ id: s.cart.id });
      // The cart moved on under us (another tab reopened it): the order cancel above rolls back with this throw.
      if (!reopened) throw new CartReopenRaced();
      return { ok: true };
    });
    // Zero-cache stock rule: regenerate only after the release committed.
    if (res.ok && released > 0) onStockChanged(st.slug);
    return res;
  } catch (e) {
    if (e instanceof CartReopenRaced) return { ok: true };
    if (e instanceof LockSetUnstable) return { ok: false, reason: 'payment_in_progress' };
    throw e;
  }
}

class CartReopenRaced extends Error {
  constructor() { super('cart reopen raced'); }
}
