/**
 * PAYMENT-TIMING §4.2 / §5 cancel-or-consume (de-fork plan 3.4 step 6). Stripe is mocked at the
 * retrieve / search / cancel seam; the settlement chokepoint, the reservation lifecycle, the sweeps and
 * the locks run for real against a *_test database.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stripeState = new Map<string, Record<string, unknown>>();
const cancelCalls: string[] = [];
const search = { results: new Map<string, Record<string, unknown>[]>(), fail: false };
const flags = { cancelFail: false, cancelOverride: null as null | ((id: string) => Record<string, unknown>) };
vi.mock('./stripe.js', async (orig) => {
  const actual = await orig<typeof import('./stripe.js')>();
  return {
    ...actual,
    retrieveStripeIntent: vi.fn(async (_s: string, _m: string, id: string) => {
      const pi = stripeState.get(id);
      if (!pi) throw new Error('No such payment_intent');
      return pi;
    }),
    resolveStripeConfigured: vi.fn(async () => true),
    searchStripeIntentsForOrder: vi.fn(async (_s: string, _m: string, code: string) => {
      if (search.fail) throw new Error('search unavailable');
      return search.results.get(code) ?? [];
    }),
    cancelStripeIntent: vi.fn(async (_s: string, _m: string, id: string) => {
      cancelCalls.push(id);
      if (flags.cancelFail) throw new Error('stripe cancel unavailable');
      const pi = stripeState.get(id)!;
      if (flags.cancelOverride) {
        const won = flags.cancelOverride(id);
        return won;
      }
      if (pi.status === 'succeeded') return pi;
      const next = { ...pi, status: 'canceled' };
      stripeState.set(id, next);
      return next;
    }),
  };
});
vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: () => undefined }));

import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { withLockedSet } from '../db/locks.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { applyStripeIntent, openStripePreMint, paymentIntentDeadlineMin, sweepOrphanPreMints, sweepStaleBalanceIntents, sweepStaleStripeIntents, trackStripeIntent, STRIPE_SWEEP_MAX_TRIES } from './stripe-reconcile.js';
import { release, reserve, providerQuiescent } from './reservation.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`cancel-or-consume test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd';
const SLUG = 'cancel-or-consume-test';
const VARIANT = 'cdcdcdcd-cdcd-cdcd-cdcd-00000000000c';
const MIN = 60_000;
const KIND = 'upgrade_credit';

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  stripeState.clear(); cancelCalls.length = 0; search.results.clear(); search.fail = false;
  flags.cancelFail = false; flags.cancelOverride = null;
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, '{}'::jsonb)`);
    const [p] = await tx.insert(s.product).values({ storeId: STORE, slug: 'p', name: 'P', status: 'active' }).returning({ id: s.product.id });
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT}, ${STORE}, ${p!.id}, 'SKU1', 'V1', 1000)`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 100, 0)`);
  });
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); });

async function makeOrder(opts: { state?: 'PendingPayment' | 'Paid' | 'Cancelled'; ageMin?: number; total?: number } = {}) {
  const code = 'SR' + Math.random().toString(16).slice(2, 12).toUpperCase();
  const total = opts.total ?? 2000;
  return withStore(STORE, async (tx) => {
    const [c] = await tx.insert(s.customer).values({ storeId: STORE, email: `${code.toLowerCase()}@example.com` }).returning({ id: s.customer.id });
    const createdAt = new Date(Date.now() - (opts.ageMin ?? 0) * MIN);
    const [o] = await tx.insert(s.order).values({ storeId: STORE, code, state: opts.state ?? 'PendingPayment', currency: 'USD', grandTotal: total, customerId: c!.id, createdAt }).returning();
    return o!;
  });
}

/** Holds a reservation for the order under the order lock set (the production entry point). */
async function holdFor(orderId: string, ownerKey: string) {
  return withLockedSet(STORE, { kind: 'order', orderId }, (tx, held) =>
    reserve(tx, held, { storeId: STORE, orderId, kind: KIND, ownerKey, holder: { source: 'test' } }));
}

function pi(id: string, code: string, over: Record<string, unknown> = {}) {
  const v = { id, amount: 2000, currency: 'usd', status: 'requires_payment_method', metadata: { orderCode: code, storeId: STORE }, latest_charge: null, ...over };
  stripeState.set(id, v);
  return v as unknown as Parameters<typeof applyStripeIntent>[2];
}
async function track(orderId: string, intentId: string) {
  await withStore(STORE, (tx) => trackStripeIntent(tx, STORE, { orderId, intentId, amount: 2000, currency: 'USD', mode: 'test' }));
}
async function apply(intent: Parameters<typeof applyStripeIntent>[2]) {
  return withStore(STORE, (tx) => applyStripeIntent(tx, STORE, intent, 'test'));
}
const q = <T>(fn: (tx: Parameters<Parameters<typeof withStore>[1]>[0]) => Promise<T>) => withStore(STORE, fn);
const orderOf = (id: string) => q(async (tx) => (await tx.select().from(s.order).where(eq(s.order.id, id)))[0]!);
const attemptOf = (ref: string) => q(async (tx) => (await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.providerRef, ref)))[0]!);
const reservationsOf = (orderId: string) => q((tx) => tx.select().from(s.orderReservation).where(eq(s.orderReservation.orderId, orderId)));
const paymentsOf = (orderId: string) => q((tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, orderId)));
const ageAttempts = (sql_where: ReturnType<typeof sql>, minutes: number) =>
  q((tx) => tx.execute(sql`UPDATE payment_attempt SET created_at = now() - (${minutes} * interval '1 minute') WHERE ${sql_where}`));

describe('T-S1 decline-then-success keeps the reservation', () => {
  it('a retryable decline keeps the hold; the later success on the same intent consumes it once', async () => {
    const order = await makeOrder();
    await holdFor(order.id, 'credit-1');
    await track(order.id, 'pi_s1');
    const r1 = await apply(pi('pi_s1', order.code, { status: 'requires_payment_method', last_payment_error: { message: 'card declined' } }));
    expect(r1.outcome).toBe('failed');
    expect((await attemptOf('pi_s1')).status).toBe('failed');
    expect((await reservationsOf(order.id))[0]).toMatchObject({ state: 'held', consumedAt: null });
    expect((await orderOf(order.id)).state).toBe('PendingPayment');

    const r2 = await apply(pi('pi_s1', order.code, { status: 'succeeded', latest_charge: 'ch_s1' }));
    expect(r2.outcome).toBe('settled');
    expect((await orderOf(order.id)).state).toBe('Paid');
    const [res] = await reservationsOf(order.id);
    expect(res).toMatchObject({ state: 'consumed', consumedPaymentId: (await paymentsOf(order.id))[0]!.id });
    expect(res!.consumedOperationId).toBeTruthy();
    expect(await paymentsOf(order.id)).toHaveLength(1);
  });
});

describe('T-S2 cancellation race', () => {
  it('cancel wins: the intent is cancelled at Stripe, the order stays alive and the hold stays held', async () => {
    const order = await makeOrder({ ageMin: 120 });
    await holdFor(order.id, 'credit-2');
    await track(order.id, 'pi_race1');
    pi('pi_race1', order.code, { status: 'requires_payment_method' });
    const st = await sweepStaleStripeIntents(STORE, new Date(Date.now() - 60 * MIN), 10);
    expect(st).toMatchObject({ checked: 1, cancelled: 1 });
    expect((await attemptOf('pi_race1')).status).toBe('cancelled');
    expect((await orderOf(order.id)).state).toBe('PendingPayment');
    expect((await reservationsOf(order.id))[0]).toMatchObject({ state: 'held' });
  });

  it('cancel loses: Stripe already succeeded, the sweep settles instead, and the hold is consumed', async () => {
    const order = await makeOrder({ ageMin: 120 });
    await holdFor(order.id, 'credit-3');
    await track(order.id, 'pi_race2');
    pi('pi_race2', order.code, { status: 'requires_payment_method' });
    flags.cancelOverride = (id) => {
      const won = { ...stripeState.get(id)!, status: 'succeeded', latest_charge: 'ch_race2' };
      stripeState.set(id, won);
      return won;
    };
    const st = await sweepStaleStripeIntents(STORE, new Date(Date.now() - 60 * MIN), 10);
    expect(st).toMatchObject({ checked: 1, settled: 1, cancelled: 0 });
    expect((await orderOf(order.id)).state).toBe('Paid');
    expect((await reservationsOf(order.id))[0]).toMatchObject({ state: 'consumed' });
  });

  it('confirmed cancellation on a Cancelled order releases a requested hold; a retryable decline does not', async () => {
    const order = await makeOrder({ ageMin: 5 });
    await holdFor(order.id, 'credit-4');
    await track(order.id, 'pi_rel1');
    await withLockedSet(STORE, { kind: 'order', orderId: order.id }, async (tx, held) => {
      await tx.update(s.order).set({ state: 'Cancelled' }).where(eq(s.order.id, order.id));
      return release(tx, held, { storeId: STORE, orderId: order.id, reason: 'admin_cancel', stripeDiscoverable: false });
    });
    expect((await reservationsOf(order.id))[0]).toMatchObject({ state: 'held', releaseRequestedAt: expect.any(Date) });

    // a retryable decline on the cancelled order: the hold must stay
    await apply(pi('pi_rel1', order.code, { status: 'requires_payment_method', last_payment_error: { message: 'declined' } }));
    expect((await reservationsOf(order.id))[0]).toMatchObject({ state: 'held' });

    // the Stripe side is confirmed cancelled by the sweep: the request is now effective
    await sweepStaleStripeIntents(STORE, new Date(), 10);
    expect((await attemptOf('pi_rel1')).status).toBe('cancelled');
    expect((await reservationsOf(order.id))[0]).toMatchObject({ state: 'released' });
  });
});

describe('balance intents (G1, PAYMENT-TIMING §5.4)', () => {
  it('PAYMENT_INTENT_DEADLINE_MIN defaults to 60', () => {
    expect(paymentIntentDeadlineMin()).toBe(60);
  });

  it('a balance intent older than the deadline is cancelled at Stripe; a fresh one and a processing one are not', async () => {
    const paid = await makeOrder({ state: 'Paid' });
    await track(paid.id, 'pi_bal_old');
    pi('pi_bal_old', paid.code, { status: 'requires_payment_method' });
    await track(paid.id, 'pi_bal_new');
    pi('pi_bal_new', paid.code, { status: 'requires_payment_method' });
    await track(paid.id, 'pi_bal_hold');
    pi('pi_bal_hold', paid.code, { status: 'processing' });
    await ageAttempts(sql`provider_ref = 'pi_bal_old' OR provider_ref = 'pi_bal_hold'`, 120);

    const st = await sweepStaleBalanceIntents(STORE, 10, () => {}, new Date(), 60);
    expect(st).toMatchObject({ checked: 2, cancelled: 1, held: 1 });
    expect(cancelCalls).toEqual(['pi_bal_old']);
    expect((await attemptOf('pi_bal_old')).status).toBe('cancelled');
    expect((await attemptOf('pi_bal_new')).status).toBe('open');
    expect((await attemptOf('pi_bal_hold')).status).toBe('processing');
  });

  it('a failing cancel backs off and goes manual with an alert after the maximum tries', async () => {
    const paid = await makeOrder({ state: 'Paid' });
    await track(paid.id, 'pi_bal_fail');
    pi('pi_bal_fail', paid.code, { status: 'requires_payment_method' });
    await ageAttempts(sql`provider_ref = 'pi_bal_fail'`, 120);
    flags.cancelFail = true;
    const base = Date.now();
    for (let k = 1; k <= STRIPE_SWEEP_MAX_TRIES; k++) {
      await sweepStaleBalanceIntents(STORE, 10, () => {}, new Date(base + k * 24 * 60 * MIN), 60);
    }
    const a = await attemptOf('pi_bal_fail');
    expect((a.context as { recovery?: { tries?: number; manual?: boolean } }).recovery).toMatchObject({ tries: STRIPE_SWEEP_MAX_TRIES, manual: true });
    expect(a.status).toBe('open');
    const alerts = await q((tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.action, 'stripe_intent_unresolvable')));
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('orphaned pre-mint rows (X-9)', () => {
  const KEY = 'pi:orphan:2000';

  async function preMint(orderId: string, ageMin: number) {
    await q((tx) => openStripePreMint(tx, STORE, { orderId, iterationKey: KEY, amount: 2000, currency: 'USD', mode: 'test' }));
    await ageAttempts(sql`idempotency_key = ${'stripe-pi-pending:' + KEY}`, ageMin);
  }

  it('the order is non-quiescent while the pre-mint row is open', async () => {
    const order = await makeOrder({ ageMin: 120 });
    await preMint(order.id, 120);
    const quiescent = await q((tx) => providerQuiescent(tx, STORE, order.id, { stripeDiscoverable: false }));
    expect(quiescent).toBe(false);
  });

  it('a PaymentIntent carrying the mint key is bound to the pre-mint row', async () => {
    const order = await makeOrder({ ageMin: 120 });
    await preMint(order.id, 120);
    search.results.set(order.code, [{ id: 'pi_orph_bound', amount: 2000, currency: 'usd', status: 'requires_payment_method', metadata: { orderCode: order.code, storeId: STORE, mintKey: KEY } }]);
    const st = await sweepOrphanPreMints(STORE, 10, () => {}, new Date(), 60);
    expect(st).toMatchObject({ checked: 1, bound: 1, cancelled: 0 });
    const a = await attemptOf('pi_orph_bound');
    expect(a).toMatchObject({ status: 'open', idempotencyKey: 'stripe-pi-pending:' + KEY });
  });

  it('a clean search past the deadline cancels the pre-mint row and makes the order quiescent', async () => {
    const order = await makeOrder({ ageMin: 120 });
    await preMint(order.id, 120);
    const st = await sweepOrphanPreMints(STORE, 10, () => {}, new Date(), 60);
    expect(st).toMatchObject({ checked: 1, bound: 0, cancelled: 1 });
    const [row] = await q((tx) => tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.orderId, order.id)));
    expect(row).toMatchObject({ status: 'cancelled', providerRef: null });
    expect(await q((tx) => providerQuiescent(tx, STORE, order.id, { stripeDiscoverable: false }))).toBe(true);
  });

  it('an untracked PI without a mint key and the same amount is ambiguous: fail closed, nothing cancelled', async () => {
    const order = await makeOrder({ ageMin: 120 });
    await preMint(order.id, 120);
    search.results.set(order.code, [{ id: 'pi_legacy', amount: 2000, currency: 'usd', status: 'requires_payment_method', metadata: { orderCode: order.code, storeId: STORE } }]);
    const st = await sweepOrphanPreMints(STORE, 10, () => {}, new Date(), 60);
    expect(st).toMatchObject({ checked: 1, bound: 0, cancelled: 0, errors: 1 });
    const [row] = await q((tx) => tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.orderId, order.id)));
    expect(row!.status).toBe('open');
  });

  it('a search error backs off and leaves the row open', async () => {
    const order = await makeOrder({ ageMin: 120 });
    await preMint(order.id, 120);
    search.fail = true;
    const st = await sweepOrphanPreMints(STORE, 10, () => {}, new Date(), 60);
    expect(st).toMatchObject({ errors: 1, cancelled: 0 });
    const [row] = await q((tx) => tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.orderId, order.id)));
    expect((row!.context as { recovery?: { tries?: number } }).recovery?.tries).toBe(1);
  });
});

describe('consume is atomic with the settlement (PAYMENT-TIMING §3.7)', () => {
  it('a rolled-back settlement leaves the hold held and the order unpaid; the replay consumes it once', async () => {
    const order = await makeOrder();
    await holdFor(order.id, 'credit-5');
    await track(order.id, 'pi_atomic');
    const intent = pi('pi_atomic', order.code, { status: 'succeeded', latest_charge: 'ch_atomic' });

    await expect(withStore(STORE, async (tx) => {
      await applyStripeIntent(tx, STORE, intent, 'test');
      throw new Error('simulated crash after settlement');
    })).rejects.toThrow('simulated crash');
    expect((await orderOf(order.id)).state).toBe('PendingPayment');
    expect(await paymentsOf(order.id)).toHaveLength(0);
    expect((await reservationsOf(order.id))[0]).toMatchObject({ state: 'held' });

    expect((await apply(intent)).outcome).toBe('settled');
    expect((await reservationsOf(order.id))[0]).toMatchObject({ state: 'consumed' });
    expect((await apply(intent)).outcome).toBe('already_settled');
    expect((await reservationsOf(order.id))).toHaveLength(1);
  });

  it('an order without reservations settles exactly as before (no reservation rows created)', async () => {
    const order = await makeOrder();
    await track(order.id, 'pi_plain');
    expect((await apply(pi('pi_plain', order.code, { status: 'succeeded', latest_charge: 'ch_p' }))).outcome).toBe('settled');
    expect((await orderOf(order.id)).state).toBe('Paid');
    expect(await reservationsOf(order.id)).toHaveLength(0);
  });
});

