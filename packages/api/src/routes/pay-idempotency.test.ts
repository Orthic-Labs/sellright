/**
 * DB tests for MONEY-1 (payment ledger integrity — 2026-07-04):
 *
 *   1. Two settles racing on the SAME (store_id, provider_ref) — simulating the
 *      /pay call and the Stripe webhook reconcile both calling applyPaymentResult
 *      for the same capture — insert exactly ONE payment row. The partial unique
 *      index (migration 0037) + onConflictDoNothing in applyPaymentResult is
 *      what collapses the second insert.
 *   2. Two DIFFERENT stores whose order codes share the same suffix each pay
 *      independently — proving the /pay derived claim key
 *      (`pay:<storeId>:<code>:<method>`) doesn't let one store's claim block
 *      the other's (processed_event.id is a GLOBAL text PK with no store
 *      scoping, so an un-scoped key would collide).
 *   3. A manual/COD payment (null provider_ref) still inserts normally — the
 *      partial index (`WHERE provider_ref IS NOT NULL`) must never block it,
 *      including a second manual payment on a second order in the same store.
 *
 * Runs against sellright_test ONLY (these wipe data). Mirrors
 * checkout-migration.test.ts: _test-DB guard + TRUNCATE store CASCADE wipe +
 * seed helpers under withStore(). vitest runs files serially
 * (fileParallelism: false), so the shared DB is safe between files.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, and, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { applyPaymentResult } from '../payments/settle.js';
import { pay } from './pay.js';
import type { PaymentResult } from '../payments/provider.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`pay-idempotency test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE_A = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const SLUG_A = 'money1-store-a';
const STORE_B = 'ffffffff-ffff-ffff-ffff-fffffffffffe';
const SLUG_B = 'money1-store-b';

const app = new OpenAPIHono();
app.route('/', pay);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seedStore(storeId: string, slug: string, config: unknown = { payments: { manual: true, cod: true } }) {
  await withStore(storeId, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${storeId}, ${slug}, ${slug}, 'USD', ${JSON.stringify(config)}::jsonb) ON CONFLICT (id) DO NOTHING`);
  });
}

/** Insert a PendingPayment order in the given store; returns its {id, code}. */
async function makeOrder(storeId: string, opts: { code?: string; grandTotal?: number } = {}): Promise<{ id: string; code: string }> {
  const code = opts.code ?? 'SR' + Math.random().toString(16).slice(2, 12).toUpperCase();
  const id = await withStore(storeId, async (tx) => {
    const [o] = await tx.insert(s.order).values({
      storeId, code, state: 'PendingPayment', currency: 'USD', grandTotal: opts.grandTotal ?? 2100,
    }).returning({ id: s.order.id });
    return o!.id;
  });
  return { id, code };
}

beforeEach(async () => { await wipe(); });
afterAll(async () => { await wipe(); });

const hdr = (slug: string, extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-store-slug': slug, ...extra });

describe('MONEY-1: (store_id, provider_ref) unique settle', () => {
  it('two applyPaymentResult calls with the SAME (storeId, providerRef) insert exactly ONE payment row', async () => {
    await seedStore(STORE_A, SLUG_A);
    const { id: orderId } = await makeOrder(STORE_A);
    const result: PaymentResult = { state: 'Settled', providerRef: 'pi_shared_capture_123', metadata: null };
    const orderRef = { id: orderId, state: 'PendingPayment', grandTotal: 2100, currency: 'USD', customerId: null };

    // Simulate the /pay call and the webhook reconcile racing: two independent
    // transactions both calling applyPaymentResult for the same capture. Run
    // them concurrently (Promise.all) to actually exercise the DB-level
    // conflict resolution, not just sequential no-op detection.
    const [r1, r2] = await Promise.all([
      withStore(STORE_A, (tx) => applyPaymentResult(tx, { storeId: STORE_A, order: orderRef, method: 'stripe', result })),
      withStore(STORE_A, (tx) => applyPaymentResult(tx, { storeId: STORE_A, order: orderRef, method: 'stripe', result })),
    ]);

    // Exactly one of the two calls should have won the insert and driven the
    // order to Paid; the loser reports the pre-transition order state it read.
    const paidCount = [r1, r2].filter((r) => r.orderState === 'Paid').length;
    expect(paidCount).toBe(1);

    const rows = await withStore(STORE_A, (tx) =>
      tx.select().from(s.payment).where(and(eq(s.payment.storeId, STORE_A), eq(s.payment.providerRef, 'pi_shared_capture_123'))));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('Settled');

    const [order] = await withStore(STORE_A, (tx) => tx.select().from(s.order).where(eq(s.order.id, orderId)));
    expect(order!.state).toBe('Paid');
  });

  it('a manual payment (null provider_ref) still inserts, and a second manual payment on another order is unaffected by the partial index', async () => {
    await seedStore(STORE_A, SLUG_A);
    const orderA = await makeOrder(STORE_A);
    const orderB = await makeOrder(STORE_A);
    const manualResult: PaymentResult = { state: 'Settled', providerRef: null, metadata: { manual: true } };

    const refA = { id: orderA.id, state: 'PendingPayment', grandTotal: 2100, currency: 'USD', customerId: null };
    const refB = { id: orderB.id, state: 'PendingPayment', grandTotal: 2100, currency: 'USD', customerId: null };

    const applied1 = await withStore(STORE_A, (tx) => applyPaymentResult(tx, { storeId: STORE_A, order: refA, method: 'manual', result: manualResult }));
    const applied2 = await withStore(STORE_A, (tx) => applyPaymentResult(tx, { storeId: STORE_A, order: refB, method: 'manual', result: manualResult }));

    expect(applied1.orderState).toBe('Paid');
    expect(applied2.orderState).toBe('Paid');

    const rows = await withStore(STORE_A, (tx) => tx.select().from(s.payment).where(eq(s.payment.storeId, STORE_A)));
    expect(rows.filter((r) => r.providerRef === null)).toHaveLength(2);
  });
});

describe('MONEY-2: store-scoped /pay claim key', () => {
  it('two different stores with the SAME order-code suffix each pay independently', async () => {
    await seedStore(STORE_A, SLUG_A);
    await seedStore(STORE_B, SLUG_B);
    const sharedCode = 'SRSHAREDCODE';
    await makeOrder(STORE_A, { code: sharedCode });
    await makeOrder(STORE_B, { code: sharedCode });

    const resA = await app.request(`/v1/shop/orders/${sharedCode}/pay`, { method: 'POST', headers: hdr(SLUG_A), body: JSON.stringify({ method: 'manual' }) });
    expect(resA.status).toBe(200);
    const bodyA = await resA.json() as { state: string; payment: string };
    expect(bodyA.state).toBe('Paid');
    expect(bodyA.payment).toBe('Settled');

    const resB = await app.request(`/v1/shop/orders/${sharedCode}/pay`, { method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ method: 'manual' }) });
    expect(resB.status).toBe(200);
    const bodyB = await resB.json() as { state: string; payment: string };
    // MONEY-2 regression check: before the store-scoped claim key, store B's
    // claim insert would conflict with store A's already-claimed global
    // processed_event row (`pay:${code}:${method}`) and store B would get
    // stuck reporting 'already-processed' with state still PendingPayment.
    expect(bodyB.state).toBe('Paid');
    expect(bodyB.payment).toBe('Settled');

    const claims = await pool.query('SELECT id, store_id FROM processed_event WHERE id LIKE $1', [`%${sharedCode}%`]);
    expect(claims.rows).toHaveLength(2);
    const storeIds = claims.rows.map((r: { store_id: string }) => r.store_id).sort();
    expect(storeIds).toEqual([STORE_A, STORE_B].sort());
  });

  it('derives the claim key as pay:<storeId>:<code>:<method>', async () => {
    await seedStore(STORE_A, SLUG_A);
    const { code } = await makeOrder(STORE_A);
    const res = await app.request(`/v1/shop/orders/${code}/pay`, { method: 'POST', headers: hdr(SLUG_A), body: JSON.stringify({ method: 'manual' }) });
    expect(res.status).toBe(200);
    const claim = await pool.query('SELECT id FROM processed_event WHERE store_id = $1', [STORE_A]);
    expect(claim.rows.map((r: { id: string }) => r.id)).toContain(`pay:${STORE_A}:${code}:manual`);
  });
});

describe('MONEY-3: partial-tender charge amount (no overcharge on top of a gift card)', () => {
  it('a gateway settle after a partial gift-card tender records only the REMAINING amount, not grandTotal', async () => {
    await seedStore(STORE_A, SLUG_A);
    const { id: orderId } = await makeOrder(STORE_A, { grandTotal: 10000 });
    // Simulate checkout.ts's gift-card draw-down: a Settled 'gift_card' tender
    // for PART of the order, order stays PendingPayment (grandTotal unchanged).
    await withStore(STORE_A, (tx) =>
      tx.insert(s.payment).values({ storeId: STORE_A, orderId, amount: 3000, method: 'gift_card', state: 'Settled' }));

    const orderRef = { id: orderId, state: 'PendingPayment', grandTotal: 10000, currency: 'USD', customerId: null };
    const gatewayResult: PaymentResult = { state: 'Settled', providerRef: 'pi_partial_remainder', metadata: null };
    // The caller (pay.ts / payment-webhooks.ts) computes this via
    // amountDueForOrder BEFORE calling the gateway — 10000 - 3000 = 7000.
    const applied = await withStore(STORE_A, (tx) =>
      applyPaymentResult(tx, { storeId: STORE_A, order: orderRef, method: 'stripe', result: gatewayResult, amount: 7000 }));

    expect(applied.orderState).toBe('Paid');

    const rows = await withStore(STORE_A, (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, orderId)));
    expect(rows).toHaveLength(2);
    const gatewayRow = rows.find((r) => r.method === 'stripe');
    // The bug this guards against: charging/recording the FULL grandTotal
    // (10000) on top of the 3000 already covered by the gift card.
    expect(gatewayRow!.amount).toBe(7000);
    const total = rows.filter((r) => r.state === 'Settled').reduce((a, r) => a + r.amount, 0);
    expect(total).toBe(10000);
  });

  it('a partial settle that does NOT yet cover grandTotal leaves the order PendingPayment', async () => {
    await seedStore(STORE_A, SLUG_A);
    const { id: orderId } = await makeOrder(STORE_A, { grandTotal: 10000 });
    const orderRef = { id: orderId, state: 'PendingPayment', grandTotal: 10000, currency: 'USD', customerId: null };
    const result: PaymentResult = { state: 'Settled', providerRef: 'pi_only_part', metadata: null };

    const applied = await withStore(STORE_A, (tx) =>
      applyPaymentResult(tx, { storeId: STORE_A, order: orderRef, method: 'stripe', result, amount: 4000 }));

    expect(applied.orderState).toBe('PendingPayment');
    const [order] = await withStore(STORE_A, (tx) => tx.select().from(s.order).where(eq(s.order.id, orderId)));
    expect(order!.state).toBe('PendingPayment');
  });

  it('/pay charges only the remaining amount when a prior Settled tender already covers part of the order', async () => {
    await seedStore(STORE_A, SLUG_A);
    const { code, id: orderId } = await makeOrder(STORE_A, { grandTotal: 10000 });
    await withStore(STORE_A, (tx) =>
      tx.insert(s.payment).values({ storeId: STORE_A, orderId, amount: 3000, method: 'gift_card', state: 'Settled' }));

    const res = await app.request(`/v1/shop/orders/${code}/pay`, { method: 'POST', headers: hdr(SLUG_A), body: JSON.stringify({ method: 'manual' }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { state: string; payment: string };
    expect(body.state).toBe('Paid');

    const rows = await withStore(STORE_A, (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, orderId)));
    const manualRow = rows.find((r) => r.method === 'manual');
    // manualProvider always reports Settled for whatever `amount` /pay passes it
    // — this proves /pay computed amountDue (7000), not order.grandTotal (10000).
    expect(manualRow!.amount).toBe(7000);
  });

  it('/pay rejects with 400 when the order is already fully covered by prior tenders', async () => {
    await seedStore(STORE_A, SLUG_A);
    const { code, id: orderId } = await makeOrder(STORE_A, { grandTotal: 5000 });
    await withStore(STORE_A, (tx) =>
      tx.insert(s.payment).values({ storeId: STORE_A, orderId, amount: 5000, method: 'gift_card', state: 'Settled' }));

    const res = await app.request(`/v1/shop/orders/${code}/pay`, { method: 'POST', headers: hdr(SLUG_A), body: JSON.stringify({ method: 'manual' }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/fully paid/);
  });
});

describe('MONEY-4: a settled payment on a non-payable order is recorded + audited, never dropped', () => {
  it('applyPaymentResult on a Cancelled order still inserts the payment row and writes a payment_after_cancel audit_log entry', async () => {
    await seedStore(STORE_A, SLUG_A);
    const { id: orderId } = await makeOrder(STORE_A, { grandTotal: 5000 });
    await withStore(STORE_A, (tx) => tx.update(s.order).set({ state: 'Cancelled' }).where(eq(s.order.id, orderId)));

    const cancelledOrderRef = { id: orderId, state: 'Cancelled', grandTotal: 5000, currency: 'USD', customerId: null };
    const result: PaymentResult = { state: 'Settled', providerRef: 'pi_settled_after_cancel', metadata: null };

    const applied = await withStore(STORE_A, (tx) =>
      applyPaymentResult(tx, { storeId: STORE_A, order: cancelledOrderRef, method: 'stripe', result, amount: 5000 }));

    // Never silently auto-un-cancel — that is a product decision, not this fix's job.
    expect(applied.orderState).toBe('Cancelled');

    const rows = await withStore(STORE_A, (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, orderId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(5000);
    expect(rows[0]!.state).toBe('Settled');

    const [order] = await withStore(STORE_A, (tx) => tx.select().from(s.order).where(eq(s.order.id, orderId)));
    expect(order!.state).toBe('Cancelled'); // untouched — money is recorded, order is not auto-revived

    const audits = await withStore(STORE_A, (tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.entityId, orderId)));
    const flag = audits.find((a) => a.action === 'payment_after_cancel');
    expect(flag).toBeDefined();
    expect((flag!.data as { needsReconciliation?: boolean })?.needsReconciliation).toBe(true);
  });
});
