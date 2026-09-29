/**
 * Stripe settlement fallback + PI tracking (payments audit D1/D3/D4/D5/D6/D10/
 * D14/D18). Stripe itself is mocked at the retrieve/cancel seam; everything
 * else (settle path, paid effects, sweeper, refund engine) runs for real
 * against a *_test database.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stripeState = new Map<string, Record<string, unknown>>();
const cancelCalls: string[] = [];
vi.mock('./stripe.js', async (orig) => {
  const actual = await orig<typeof import('./stripe.js')>();
  return {
    ...actual,
    retrieveStripeIntent: vi.fn(async (_s: string, _m: string, id: string) => {
      const pi = stripeState.get(id);
      if (!pi) throw new Error('No such payment_intent');
      return pi;
    }),
    cancelStripeIntent: vi.fn(async (_s: string, _m: string, id: string) => {
      cancelCalls.push(id);
      const pi = stripeState.get(id)!;
      if (pi.status === 'succeeded') return pi;
      const next = { ...pi, status: 'canceled' };
      stripeState.set(id, next);
      return next;
    }),
  };
});
vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: () => undefined }));

import { and, eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { applyStripeIntent, reconcileStripeOrder, trackStripeIntent, claimReconcileSlot } from './stripe-reconcile.js';
import { hasUnresolvedPayment } from './hold.js';
import { releaseStaleAllocations } from '../jobs/release-stale-allocations.js';
import { requestRefund } from './refunds.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`stripe-reconcile test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'abababab-abab-abab-abab-abababababab';
const SLUG = 'stripe-reconcile-test';
const VARIANT = 'abababab-abab-abab-abab-00000000000b';

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  stripeState.clear();
  cancelCalls.length = 0;
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, ${JSON.stringify({ notifications: { operatorEmail: 'ops@example.com' } })}::jsonb)`);
    const [p] = await tx.insert(s.product).values({ storeId: STORE, slug: 'p', name: 'P', status: 'active' }).returning({ id: s.product.id });
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT}, ${STORE}, ${p!.id}, 'SKU1', 'V1', 1000)`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 100, 0)`);
  });
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); });

/** A PendingPayment order holding `qty` allocated units, with a customer. */
async function makeOrder(opts: { qty?: number; ageMin?: number; total?: number } = {}) {
  const qty = opts.qty ?? 2;
  const total = opts.total ?? 2000;
  const code = 'SR' + Math.random().toString(16).slice(2, 12).toUpperCase();
  return withStore(STORE, async (tx) => {
    const [c] = await tx.insert(s.customer).values({ storeId: STORE, email: `${code.toLowerCase()}@example.com` }).returning({ id: s.customer.id });
    const createdAt = new Date(Date.now() - (opts.ageMin ?? 0) * 60_000);
    const [o] = await tx.insert(s.order).values({ storeId: STORE, code, state: 'PendingPayment', currency: 'USD', grandTotal: total, customerId: c!.id, createdAt }).returning();
    const [line] = await tx.insert(s.orderLine).values({ storeId: STORE, orderId: o!.id, variantId: VARIANT, variantSku: 'SKU1', variantName: 'V1', quantity: qty, unitPrice: Math.round(total / qty), lineSubtotal: total, lineTotal: total }).returning();
    await tx.execute(sql`UPDATE stock SET allocated = allocated + ${qty} WHERE variant_id = ${VARIANT}`);
    return { order: o!, line: line! };
  });
}

function pi(id: string, code: string, over: Record<string, unknown> = {}) {
  const v = { id, amount: 2000, currency: 'usd', status: 'requires_payment_method', metadata: { orderCode: code }, latest_charge: null, ...over };
  stripeState.set(id, v);
  return v as unknown as Parameters<typeof applyStripeIntent>[2];
}
async function track(orderId: string, intentId: string, amount = 2000) {
  await withStore(STORE, (tx) => trackStripeIntent(tx, STORE, { orderId, intentId, amount, currency: 'USD', mode: 'test' }));
}
const q = <T>(fn: (tx: Parameters<Parameters<typeof withStore>[1]>[0]) => Promise<T>) => withStore(STORE, fn);
const orderOf = (id: string) => q(async (tx) => (await tx.select().from(s.order).where(eq(s.order.id, id)))[0]!);
const attemptOf = (ref: string) => q(async (tx) => (await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.providerRef, ref)))[0]!);
const paymentsOf = (orderId: string) => q((tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, orderId)));
const audits = (action: string) => q((tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.action, action)));
const outbox = (kind: string) => q((tx) => tx.select().from(s.emailOutbox).where(eq(s.emailOutbox.kind, kind)));
const allocated = () => q(async (tx) => (await tx.select({ a: s.stock.allocated }).from(s.stock).where(eq(s.stock.variantId, VARIANT)))[0]!.a);

describe('D1: server-side settlement fallback', () => {
  it('settles a missed-webhook PI exactly once (paid effects + confirmation email once), idempotent on repeat', async () => {
    const { order } = await makeOrder();
    await track(order.id, 'pi_d1');
    pi('pi_d1', order.code, { status: 'succeeded', latest_charge: 'ch_1' });
    const r1 = await reconcileStripeOrder(STORE, { code: order.code });
    expect(r1.intents).toEqual([{ intentId: 'pi_d1', outcome: 'settled' }]);
    expect((await orderOf(order.id)).state).toBe('Paid');
    // A second pull and a late webhook snapshot are both no-ops.
    const r2 = await reconcileStripeOrder(STORE, { orderId: order.id });
    expect(r2.intents).toEqual([]);
    await q((tx) => applyStripeIntent(tx, STORE, pi('pi_d1', order.code, { status: 'succeeded' }), 'test'));
    const pays = await paymentsOf(order.id);
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ state: 'Settled', providerRef: 'pi_d1', amount: 2000, gatewayMode: 'test' });
    expect((await attemptOf('pi_d1')).status).toBe('settled');
    expect(await outbox('order_confirmation')).toHaveLength(1);
  });

  it('a Stripe retrieve error is reported per intent, never thrown, and leaves the order untouched', async () => {
    const { order } = await makeOrder();
    await track(order.id, 'pi_missing');
    const r = await reconcileStripeOrder(STORE, { code: order.code });
    expect(r.intents[0]).toMatchObject({ intentId: 'pi_missing', outcome: 'error' });
    expect((await orderOf(order.id)).state).toBe('PendingPayment');
  });

  it('per-order throttle allows one Stripe round-trip per window', () => {
    expect(claimReconcileSlot(STORE, 'o-throttle', 1_000_000)).toBe(true);
    expect(claimReconcileSlot(STORE, 'o-throttle', 1_002_000)).toBe(false);
    expect(claimReconcileSlot(STORE, 'o-throttle', 1_006_000)).toBe(true);
  });
});

describe('D3/D4/D10/D18: intent outcomes', () => {
  it('D3: a succeeded PI that fails verification is held + audited + alerted once, never dropped', async () => {
    const { order } = await makeOrder();
    const snap = pi('pi_d3', order.code, { status: 'succeeded', amount: 1500 });
    expect((await q((tx) => applyStripeIntent(tx, STORE, snap, 'test'))).outcome).toBe('verify_failed');
    expect((await q((tx) => applyStripeIntent(tx, STORE, snap, 'test'))).outcome).toBe('verify_failed');
    expect((await attemptOf('pi_d3')).status).toBe('unknown');
    expect(await audits('stripe_verify_failed')).toHaveLength(1);
    expect(await outbox('payment_alert')).toHaveLength(1);
    expect(await q((tx) => hasUnresolvedPayment(tx, order.id))).toBe(true);
    expect((await orderOf(order.id)).state).toBe('PendingPayment');
  });

  it('D4: a second succeeded PI on a Paid order is recorded as a duplicate + audited + alerted (no auto-refund)', async () => {
    const { order } = await makeOrder();
    await q((tx) => applyStripeIntent(tx, STORE, pi('pi_first', order.code, { status: 'succeeded' }), 'test'));
    expect((await orderOf(order.id)).state).toBe('Paid');
    const out = await q((tx) => applyStripeIntent(tx, STORE, pi('pi_second', order.code, { status: 'succeeded' }), 'test'));
    expect(out.outcome).toBe('duplicate');
    // Redelivery does not duplicate the record or the alert.
    await q((tx) => applyStripeIntent(tx, STORE, pi('pi_second', order.code, { status: 'succeeded' }), 'test'));
    const pays = await paymentsOf(order.id);
    expect(pays).toHaveLength(2);
    expect(pays.find((p) => p.providerRef === 'pi_second')).toMatchObject({ state: 'Settled', metadata: expect.objectContaining({ duplicate: true }) });
    expect(await audits('duplicate_payment')).toHaveLength(1);
    expect(await outbox('payment_alert')).toHaveLength(1);
    expect(await outbox('order_confirmation')).toHaveLength(1);
    expect((await orderOf(order.id)).state).toBe('Paid');
  });

  it('D10/D18: payment_failed releases the attempt (retryable) and records a Declined row; the same PI can still settle', async () => {
    const { order } = await makeOrder();
    await track(order.id, 'pi_retry');
    const failed = pi('pi_retry', order.code, { last_payment_error: { message: 'Your card was declined.' } });
    expect((await q((tx) => applyStripeIntent(tx, STORE, failed, 'test'))).outcome).toBe('failed');
    expect((await attemptOf('pi_retry')).status).toBe('failed');
    expect(await q((tx) => hasUnresolvedPayment(tx, order.id))).toBe(false);
    expect((await paymentsOf(order.id))[0]).toMatchObject({ state: 'Declined', errorMessage: 'Your card was declined.' });
    await q((tx) => applyStripeIntent(tx, STORE, pi('pi_retry', order.code, { status: 'succeeded' }), 'test'));
    expect((await orderOf(order.id)).state).toBe('Paid');
    const pays = await paymentsOf(order.id);
    expect(pays).toHaveLength(1);
    expect(pays[0]!.state).toBe('Settled');
  });

  it('D10: processing / requires_action hold the order; canceled releases', async () => {
    const { order } = await makeOrder();
    await q((tx) => applyStripeIntent(tx, STORE, pi('pi_hold', order.code, { status: 'processing' }), 'test'));
    expect((await attemptOf('pi_hold')).status).toBe('processing');
    expect(await q((tx) => hasUnresolvedPayment(tx, order.id))).toBe(true);
    await q((tx) => applyStripeIntent(tx, STORE, pi('pi_hold', order.code, { status: 'canceled' }), 'test'));
    expect((await attemptOf('pi_hold')).status).toBe('cancelled');
    expect(await q((tx) => hasUnresolvedPayment(tx, order.id))).toBe(false);
  });
});

describe('D5/D6/D14: stale sweeper with tracked Stripe intents', () => {
  it('succeeded PI → settles instead of cancelling', async () => {
    const { order } = await makeOrder({ ageMin: 120 });
    await track(order.id, 'pi_paid_late');
    pi('pi_paid_late', order.code, { status: 'succeeded' });
    await releaseStaleAllocations({ apply: true, ttlMin: 60 });
    expect((await orderOf(order.id)).state).toBe('Paid');
    expect(cancelCalls).toEqual([]);
    expect(await allocated()).toBe(2);
  });

  it('processing PI → hold (order not cancelled, stock not released)', async () => {
    const { order } = await makeOrder({ ageMin: 120 });
    await track(order.id, 'pi_proc');
    pi('pi_proc', order.code, { status: 'processing' });
    await releaseStaleAllocations({ apply: true, ttlMin: 60 });
    expect((await orderOf(order.id)).state).toBe('PendingPayment');
    expect(await allocated()).toBe(2);
    expect(cancelCalls).toEqual([]);
  });

  it('abandoned PI → cancelled at Stripe, then the order is cancelled and cancelled_qty recorded', async () => {
    const { order, line } = await makeOrder({ ageMin: 120 });
    await track(order.id, 'pi_abandoned');
    pi('pi_abandoned', order.code);
    await releaseStaleAllocations({ apply: true, ttlMin: 60 });
    expect(cancelCalls).toEqual(['pi_abandoned']);
    expect((await attemptOf('pi_abandoned')).status).toBe('cancelled');
    expect((await orderOf(order.id)).state).toBe('Cancelled');
    expect(await allocated()).toBe(0);
    const [l] = await q((tx) => tx.select().from(s.orderLine).where(eq(s.orderLine.id, line.id)));
    expect(l!.cancelledQty).toBe(2);
  });

  it('unresolvable PI (Stripe error) → order skipped, not cancelled', async () => {
    const { order } = await makeOrder({ ageMin: 120 });
    await track(order.id, 'pi_unknown_at_stripe');
    await releaseStaleAllocations({ apply: true, ttlMin: 60 });
    expect((await orderOf(order.id)).state).toBe('PendingPayment');
    expect(await allocated()).toBe(2);
  });

  it('D6 regression: payment after sweeper-cancel, then refund, releases the allocation only once (D14 alert fires)', async () => {
    const { order, line } = await makeOrder({ ageMin: 120 });
    // Another order's reservation that a double release would steal.
    await makeOrder({ qty: 3 });
    await releaseStaleAllocations({ apply: true, ttlMin: 60 });
    expect((await orderOf(order.id)).state).toBe('Cancelled');
    expect(await allocated()).toBe(3);
    // MONEY-4: the money lands after the cancel.
    const out = await q((tx) => applyStripeIntent(tx, STORE, pi('pi_after_cancel', order.code, { status: 'succeeded' }), 'test'));
    expect(out.outcome).toBe('after_cancel');
    expect(await audits('payment_after_cancel')).toHaveLength(1);
    expect(await outbox('payment_alert')).toHaveLength(0); // no duplicate operator email
    expect(await outbox('payment_after_cancel_alert')).toHaveLength(1);
    // Refund the full order through the real refund engine (manual tender so
    // no provider call is needed; the stock math is method-independent).
    await q((tx) => tx.update(s.payment).set({ method: 'manual' }).where(and(eq(s.payment.orderId, order.id), eq(s.payment.providerRef, 'pi_after_cancel'))));
    await requestRefund({ storeId: STORE, orderId: order.id, actor: 'test', idempotencyKey: 'd6-regression', lines: [{ orderLineId: line.id, quantity: 2, restock: false }] });
    expect(await allocated()).toBe(3);
  });
});
