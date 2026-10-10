// Reservation release wiring (PAYMENT-TIMING §3.3 R3–R6, §5.2, §9 T-R*), against a real database.
// Route-level cases drive the real handlers (admin cancel, bulk cancel, operator override) under an admin session;
// the R5 and sweep cases drive the service and the job. DB-gated: *_test only.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { withLockedSet } from '../db/locks.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { admin as adminRoutes } from '../routes/admin.js';
import { adminOrderOps } from '../routes/admin-order-ops.js';
import { adminGatewayPayments } from '../routes/admin-gateway-payments.js';
import { reservationReleaseSweep } from '../jobs/reservation-release-sweep.js';
import { releaseStaleAllocations } from '../jobs/release-stale-allocations.js';
import { consume, releaseOnFullRefundInSet, releaseOnFullRefundOrDefer, reserve } from './reservation.js';
import { _resetPaymentPoliciesForTests, registerPaymentPolicy } from './policy/host.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`reservation release wiring test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const SLUG = 'resv-wiring-test-store';
const ADMIN = 'eeeeeeee-eeee-eeee-eeee-00000000000a';
const VARIANT = 'eeeeeeee-eeee-eeee-eeee-00000000000b';
const KIND = 'rightsuite.mobile_upgrade_credit';

const app = new OpenAPIHono();
app.route('/', adminRoutes);
app.route('/', adminOrderOps);
app.route('/', adminGatewayPayments);

let token = '';

async function wipe(): Promise<void> {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@resv.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`)).rows[0] as { id: string });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT}, ${STORE}, ${pid.id}, 'SKU-R', 'V', 1000) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 100, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 100, allocated = 0`);
  });
  token = await createAdminSession(ADMIN);
}

async function order(code: string, state: string, createdAgo = '0 minutes'): Promise<string> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, currency, grand_total, created_at)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, ${state}::order_state, 'USD', 1000, now() - ${createdAgo}::interval) RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
}

/** One held reservation for the order (ownerKey unique per call). */
async function hold(orderId: string, ownerKey: string, releaseOnFullRefund = false): Promise<void> {
  await withLockedSet(STORE, { kind: 'order', orderId }, async (t, held) => {
    await reserve(t, held, { storeId: STORE, orderId, kind: KIND, ownerKey, releaseOnFullRefund });
  });
}

/** Moves the order to Paid and consumes its held rows (R2), as the settlement chokepoint does. */
async function markPaidAndConsume(orderId: string, ownerKey: string): Promise<void> {
  await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET state = 'Paid' WHERE id = ${orderId}`));
  await withLockedSet(STORE, { kind: 'order', orderId }, async (t, held) => {
    await consume(t, held, { storeId: STORE, orderId, paymentId: null as unknown as string, operationId: `op-${ownerKey}` });
  });
}

/** Sets the order state directly (a terminal state reached by a path other than the one under test). */
async function setState(orderId: string, state: string): Promise<void> {
  await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET state = ${state}::order_state WHERE id = ${orderId}`));
}

async function reservationId(orderId: string): Promise<string> {
  return withStore(STORE, async (tx) => ((await tx.execute(sql`SELECT id FROM order_reservation WHERE order_id = ${orderId} LIMIT 1`)).rows[0] as { id: string }).id);
}

async function attempt(orderId: string, status: string, method = 'stripe', operation = 'intent'): Promise<void> {
  await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO payment_attempt
    (store_id, order_id, operation, method, account_id, mode, amount, currency, idempotency_key, fingerprint, status)
    VALUES (${STORE}, ${orderId}, ${operation}, ${method}, 'acct', 'test', 1000, 'USD', ${`k-${orderId}-${status}`}, 'fp', ${status})`));
}

async function reservations(orderId: string): Promise<Array<{ state: string; release_requested_at: Date | null; released_at: Date | null; release_on_full_refund: boolean; released_unverified: boolean }>> {
  return withStore(STORE, async (tx) => (await tx.execute(sql`SELECT state, release_requested_at, released_at, release_on_full_refund, released_unverified
    FROM order_reservation WHERE order_id = ${orderId} ORDER BY owner_key`)).rows as never);
}

async function orderState(orderId: string): Promise<string> {
  return withStore(STORE, async (tx) => ((await tx.execute(sql`SELECT state FROM "order" WHERE id = ${orderId}`)).rows[0] as { state: string }).state);
}

async function post(path: string, body: unknown, host: OpenAPIHono = app): Promise<Response> {
  return host.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  _resetPaymentPoliciesForTests();
  await wipe();
  await seed();
});
afterAll(async () => {
  _resetPaymentPoliciesForTests();
  await wipe();
  await pool.end();
});

describe('R3/R4 — cancel paths request and settle the release (PAYMENT-TIMING §5.2)', () => {
  it('admin single cancel releases a held reservation in the same transaction when provider work is quiescent', async () => {
    const id = await order('RW-1', 'PendingPayment');
    await hold(id, 'credit-1');
    const res = await post('/v1/admin/orders/RW-1/cancel', { reason: 'test' });
    expect(res.status).toBe(200);
    expect(await orderState(id)).toBe('Cancelled');
    const [r] = await reservations(id);
    expect(r!.state).toBe('released');
    expect(r!.released_at).not.toBeNull();
  });

  it('admin cancel with a non-quiescent Stripe intent records the request and leaves the hold held for the sweep', async () => {
    const id = await order('RW-2', 'PendingPayment');
    await hold(id, 'credit-2');
    await attempt(id, 'open');
    const res = await post('/v1/admin/orders/RW-2/cancel', { reason: 'test' });
    expect(res.status).toBe(200);
    const [r] = await reservations(id);
    expect(r!.state).toBe('held');
    expect(r!.release_requested_at).not.toBeNull();
  });

  it('the sweep settles that request once the intent is terminal (crash-gap recovery, T-R6)', async () => {
    const id = await order('RW-3', 'PendingPayment');
    await hold(id, 'credit-3');
    // A cancel that committed its state but whose release never ran (the gap the sweep closes).
    await setState(id, 'Cancelled');
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE order_reservation SET release_requested_at = now(), release_reason = 'order_cancelled' WHERE order_id = ${id}`));
    await attempt(id, 'open');
    const blocked = await reservationReleaseSweep({});
    expect(blocked.released).toBe(0);
    expect((await reservations(id))[0]!.state).toBe('held');
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE payment_attempt SET status = 'cancelled' WHERE order_id = ${id}`));
    const swept = await reservationReleaseSweep({});
    expect(swept.released).toBe(1);
    expect((await reservations(id))[0]!.state).toBe('released');
  });

  it('bulk cancel releases each order it cancels', async () => {
    const a = await order('RW-B1', 'PendingPayment');
    const b = await order('RW-B2', 'PendingPayment');
    await hold(a, 'credit-b1');
    await hold(b, 'credit-b2');
    const res = await post('/v1/admin/orders/bulk-cancel', { codes: ['RW-B1', 'RW-B2'] });
    expect(res.status).toBe(200);
    expect((await reservations(a))[0]!.state).toBe('released');
    expect((await reservations(b))[0]!.state).toBe('released');
  });

  it('the stale-unpaid job releases the hold of the order it cancels (apply mode)', async () => {
    const id = await order('RW-S1', 'PendingPayment', '5 hours');
    await hold(id, 'credit-s1');
    await releaseStaleAllocations({ apply: true, ttlMin: 60 });
    expect(await orderState(id)).toBe('Cancelled');
    expect((await reservations(id))[0]!.state).toBe('released');
  });
});

describe('R5 — a full refund releases consumed holds that asked for it; a failing projection defers, never aborts (X-45)', () => {
  it('a full refund releases the consumed hold with release_on_full_refund', async () => {
    const id = await order('RW-R1', 'Paid');
    await hold(id, 'credit-r1', true);
    await markPaidAndConsume(id, 'credit-r1');
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET state = 'Refunded' WHERE id = ${id}`));
    const released = await withLockedSet(STORE, { kind: 'order', orderId: id }, (t, held) =>
      releaseOnFullRefundOrDefer(t, held, { storeId: STORE, orderId: id }));
    expect(released.deferred).toBe(false);
    expect((await reservations(id))[0]!.state).toBe('released');
  });

  it('through the refund-path helper (releaseOnFullRefundInSet) inside the caller set', async () => {
    const id = await order('RW-R2', 'Paid');
    await hold(id, 'credit-r2', true);
    await markPaidAndConsume(id, 'credit-r2');
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET state = 'Refunded' WHERE id = ${id}`));
    await withStore(STORE, (tx) => releaseOnFullRefundInSet(tx, { storeId: STORE, orderId: id }));
    expect((await reservations(id))[0]!.state).toBe('released');
  });

  it('a partial-refund order (not Refunded) releases nothing', async () => {
    const id = await order('RW-R3', 'PartiallyRefunded');
    await hold(id, 'credit-r3', true);
    await markPaidAndConsume(id, 'credit-r3');
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET state = 'PartiallyRefunded' WHERE id = ${id}`));
    await withStore(STORE, (tx) => releaseOnFullRefundInSet(tx, { storeId: STORE, orderId: id }));
    expect((await reservations(id))[0]!.state).toBe('consumed');
  });

  it('a failing projection keeps the refund, leaves the hold consumed with a request, audits and raises an admin task; the sweep retries', async () => {
    const id = await order('RW-R4', 'Paid');
    await hold(id, 'credit-r4', true);
    await markPaidAndConsume(id, 'credit-r4');
    registerPaymentPolicy({
      id: 'rw-r5-broken',
      async beforePaymentAttempt() { return { allow: true }; },
      async onReservationTransition() { throw new Error('projection down'); },
    });
    // The refund commits: the order moves to Refunded in the same transaction as the deferred release.
    const out = await withLockedSet(STORE, { kind: 'order', orderId: id }, async (t, held) => {
      await t.execute(sql`UPDATE "order" SET state = 'Refunded' WHERE id = ${id}`);
      return releaseOnFullRefundOrDefer(t, held, { storeId: STORE, orderId: id, refundId: null });
    });
    expect(out.deferred).toBe(true);
    expect(await orderState(id)).toBe('Refunded');
    const [r] = await reservations(id);
    expect(r!.state).toBe('consumed');
    expect(r!.release_requested_at).not.toBeNull();
    const audits = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT action, data FROM audit_log
      WHERE entity_id = ${id} AND action IN ('reservation_projection_failed', 'policy_admin_task')`)).rows as Array<{ action: string; data: { cause?: string } }>);
    expect(audits.map((a) => a.action).sort()).toEqual(['policy_admin_task', 'reservation_projection_failed']);
    expect(audits.find((a) => a.action === 'reservation_projection_failed')!.data.cause).toBe('order_refunded');

    // Policy recovers: the sweep retries the R5 projection and releases.
    _resetPaymentPoliciesForTests();
    const swept = await reservationReleaseSweep({});
    expect(swept.released).toBe(1);
    expect((await reservations(id))[0]!.state).toBe('released');
  });
});

describe('R6 — operator override (PAYMENT-TIMING §5.3.3)', () => {
  it('releases the held hold of a Cancelled order with released_unverified and an audit row', async () => {
    const id = await order('RW-O1', 'PendingPayment');
    await hold(id, 'credit-o1');
    await setState(id, 'Cancelled');
    const res = await post(`/v1/admin/payment-reconciliation/reservations/${await reservationId(id)}/override-release`,
      { reason: 'carrier confirmed the cancel' }, adminGatewayPayments);
    expect(res.status).toBe(200);
    const [r] = await reservations(id);
    expect(r!.state).toBe('released');
    expect(r!.released_unverified).toBe(true);
  });

  it('refuses a reason shorter than 10 characters', async () => {
    const id = await order('RW-O2', 'PendingPayment');
    await hold(id, 'credit-o2');
    await setState(id, 'Cancelled');
    const res = await post(`/v1/admin/payment-reconciliation/reservations/${await reservationId(id)}/override-release`, { reason: 'short' }, adminGatewayPayments);
    expect(res.status).toBe(400);
    expect((await reservations(id))[0]!.state).toBe('held');
  });

  it('refuses an override on an order that is not Cancelled', async () => {
    const id = await order('RW-O3', 'PendingPayment');
    await hold(id, 'credit-o3');
    const res = await post(`/v1/admin/payment-reconciliation/reservations/${await reservationId(id)}/override-release`, { reason: 'a long enough reason' }, adminGatewayPayments);
    expect(res.status).toBe(409);
    expect((await reservations(id))[0]!.state).toBe('held');
  });
});
