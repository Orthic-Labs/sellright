// Order reservation lifecycle (PAYMENT-TIMING §3.2–§3.4) against a real database.
// DB-gated: *_test only. Every mutator runs inside withLockedSet so the HeldLocks brand
// is the only way in (the same way the payment paths will call it).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { pool, withStore } from '../db/client.js';
import { withLockedSet } from '../db/locks.js';
import { env } from '../env.js';
import { RLS_STORE_A, RLS_STORE_B, createStoreAppRunner, expectRlsRejection, rlsErrorText } from '../db/rls-test-utils.js';
import * as s from '../db/schema.js';
import {
  ReservationConflict,
  ReservationRuleError,
  consume,
  findOpen,
  providerQuiescent,
  release,
  releaseOnFullRefund,
  reserve,
  settleRelease,
} from './reservation.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
const isTestDb = /_test(\b|$|\?)/.test(DB);
const KIND = 'rightsuite.mobile_upgrade_credit';
const OWNER = 'licence-src-1';
const STORE = RLS_STORE_A;
const OTHER_STORE = RLS_STORE_B;
const ORDER_1 = '51111111-1111-1111-1111-111111111111';
const ORDER_2 = '52222222-2222-2222-2222-222222222222';
const ORDER_3 = '53333333-3333-3333-3333-333333333333';
const ORDER_4 = '54444444-4444-4444-4444-444444444444';
const ORDER_OTHER = '55555555-5555-5555-5555-555555555555';
const PAY_1 = '61111111-1111-1111-1111-111111111111';
const PAY_OTHER = '62222222-2222-2222-2222-222222222222';

const appPool = new Pool({ connectionString: env.DATABASE_URL_NONOWNER ?? env.DATABASE_URL });
const withStoreApp = createStoreAppRunner(appPool, { schema: { order: s.order }, casing: 'snake_case' } as const);

async function wipe(): Promise<void> {
  await pool.query('TRUNCATE store CASCADE');
}

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES
       ($1, 'resv-a', 'Reservation A', 'USD', '{}'::jsonb),
       ($2, 'resv-b', 'Reservation B', 'USD', '{}'::jsonb)`,
    [STORE, OTHER_STORE],
  );
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state) VALUES
      (${ORDER_1}, ${STORE}, 'RSV-1', 'PendingPayment'),
      (${ORDER_2}, ${STORE}, 'RSV-2', 'PendingPayment'),
      (${ORDER_3}, ${STORE}, 'RSV-3', 'PendingPayment'),
      (${ORDER_4}, ${STORE}, 'RSV-4', 'PendingPayment')`);
  });
  await withStore(OTHER_STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state) VALUES (${ORDER_OTHER}, ${OTHER_STORE}, 'OTH-1', 'PendingPayment')`);
  });
}

async function setOrderState(orderId: string, state: string): Promise<void> {
  await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET state = ${state}::order_state WHERE id = ${orderId}`));
}

async function addPayment(id: string, orderId: string, state = 'Settled'): Promise<void> {
  await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO payment (id, store_id, order_id, amount, method, state)
    VALUES (${id}, ${STORE}, ${orderId}, 1000, 'stripe', ${state}::payment_state)`));
}

async function addAttempt(orderId: string, method: string, status: string, operation = 'intent', context: unknown = null): Promise<void> {
  await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO payment_attempt
    (store_id, order_id, operation, method, account_id, mode, amount, currency, idempotency_key, fingerprint, status, context)
    VALUES (${STORE}, ${orderId}, ${operation}, ${method}, 'acct', 'test', 1000, 'USD',
            ${`k-${orderId}-${method}-${status}-${operation}`}, 'fp', ${status}, ${context === null ? null : JSON.stringify(context)}::jsonb)`));
}

async function setAttemptStatus(orderId: string, status: string): Promise<void> {
  await withStore(STORE, (tx) => tx.execute(sql`UPDATE payment_attempt SET status = ${status} WHERE order_id = ${orderId}`));
}

/** Runs fn under withLockedSet({order}) — the only way a reservation mutator is reached. */
const underOrder = <T>(orderId: string, fn: Parameters<typeof withLockedSet<T>>[2]) =>
  withLockedSet(STORE, { kind: 'order', orderId }, fn);

const reserveFor = (orderId: string, ownerKey = OWNER, extra: Partial<Parameters<typeof reserve>[2]> = {}) =>
  underOrder(orderId, (tx, held) => reserve(tx, held, { storeId: STORE, orderId, kind: KIND, ownerKey, ...extra }));

const releaseFor = (orderId: string, stripeDiscoverable = false) =>
  underOrder(orderId, (tx, held) => release(tx, held, { storeId: STORE, orderId, reason: 'admin_cancel', stripeDiscoverable }));

const stateOf = async (orderId: string, ownerKey = OWNER) => {
  const rows = await withStore(STORE, (tx) => tx.select().from(s.orderReservation).where(sql`order_id = ${orderId} and owner_key = ${ownerKey}`));
  return rows[0];
};

describe.skipIf(!isTestDb)('order reservations (PAYMENT-TIMING §3.2–§3.4)', () => {
  beforeEach(async () => {
    await wipe();
    await seed();
  });
  afterAll(async () => {
    await wipe();
    await appPool.end();
  });

  describe('reserve (R1)', () => {
    it('creates a held row and is idempotent for the same order/kind/owner', async () => {
      const a = await reserveFor(ORDER_1);
      const b = await reserveFor(ORDER_1);
      expect(a.state).toBe('held');
      expect(b.id).toBe(a.id);
      expect(await withStore(STORE, (tx) => tx.select().from(s.orderReservation))).toHaveLength(1);
    });

    it('refuses an owner that another live order holds (I2)', async () => {
      await reserveFor(ORDER_1);
      await expect(reserveFor(ORDER_2)).rejects.toBeInstanceOf(ReservationConflict);
      await expect(reserveFor(ORDER_2)).rejects.toMatchObject({ reason: 'live_owner' });
    });

    it('refuses to re-reserve after release: the order is terminal, so the hold cannot come back', async () => {
      await reserveFor(ORDER_1);
      await setOrderState(ORDER_1, 'Cancelled');
      await releaseFor(ORDER_1);
      await expect(reserveFor(ORDER_1)).rejects.toMatchObject({ reason: 'order_terminal' });
      expect((await stateOf(ORDER_1))!.state).toBe('released');
    });

    it('refuses a Cancelled or Refunded order', async () => {
      await setOrderState(ORDER_3, 'Cancelled');
      await expect(reserveFor(ORDER_3)).rejects.toMatchObject({ reason: 'order_terminal' });
    });

    it('rejects a fixed expiry once the order has provider exposure', async () => {
      await addAttempt(ORDER_4, 'stripe', 'open');
      await expect(reserveFor(ORDER_4, OWNER, { expiresAt: new Date(Date.now() + 3600_000) })).rejects.toBeInstanceOf(ReservationRuleError);
    });

    it('allows a fixed expiry on an order with no provider exposure', async () => {
      const row = await reserveFor(ORDER_1, OWNER, { expiresAt: new Date(Date.now() + 3600_000) });
      expect(row.expiresAt).not.toBeNull();
    });
  });

  describe('consume (R2)', () => {
    it('moves held rows to consumed when the order is Paid, with the payment and operation', async () => {
      await reserveFor(ORDER_1);
      await addPayment(PAY_1, ORDER_1);
      await setOrderState(ORDER_1, 'Paid');
      const consumed = await underOrder(ORDER_1, (tx, held) =>
        consume(tx, held, { storeId: STORE, orderId: ORDER_1, paymentId: PAY_1, operationId: 'op-1' }));
      expect(consumed).toHaveLength(1);
      const row = await stateOf(ORDER_1);
      expect(row).toMatchObject({ state: 'consumed', consumedPaymentId: PAY_1, consumedOperationId: 'op-1' });
      expect(row!.consumedAt).not.toBeNull();
      expect(row!.providerTerminalAt).not.toBeNull();
    });

    it('a replay consumes nothing more', async () => {
      await reserveFor(ORDER_1);
      await addPayment(PAY_1, ORDER_1);
      await setOrderState(ORDER_1, 'Paid');
      const input = { storeId: STORE, orderId: ORDER_1, paymentId: PAY_1, operationId: 'op-1' };
      await underOrder(ORDER_1, (tx, held) => consume(tx, held, input));
      expect(await underOrder(ORDER_1, (tx, held) => consume(tx, held, input))).toEqual([]);
    });

    it('refuses to consume while the order is not Paid (I3)', async () => {
      await reserveFor(ORDER_1);
      await addPayment(PAY_1, ORDER_1);
      await expect(
        underOrder(ORDER_1, (tx, held) => consume(tx, held, { storeId: STORE, orderId: ORDER_1, paymentId: PAY_1, operationId: 'op-1' })),
      ).rejects.toBeInstanceOf(ReservationRuleError);
      expect((await stateOf(ORDER_1))!.state).toBe('held');
    });
  });

  describe('release (R3 + R4) and the retryable-failure rule', () => {
    it('releases at once when the order is Cancelled and no provider work can move money', async () => {
      await reserveFor(ORDER_1);
      await setOrderState(ORDER_1, 'Cancelled');
      const out = await releaseFor(ORDER_1);
      expect(out.released).toHaveLength(1);
      expect(out.pending).toHaveLength(0);
      const row = await stateOf(ORDER_1);
      expect(row).toMatchObject({ state: 'released' });
      expect(row!.releasedAt).not.toBeNull();
      expect(row!.releaseReason).toBe('admin_cancel');
    });

    it('does not release while the order is still open, but records the request', async () => {
      await reserveFor(ORDER_1);
      const out = await releaseFor(ORDER_1);
      expect(out.released).toHaveLength(0);
      expect(out.pending).toHaveLength(1);
      const row = await stateOf(ORDER_1);
      expect(row).toMatchObject({ state: 'held' });
      expect(row!.releaseRequestedAt).not.toBeNull();
    });

    it('a local Stripe failed attempt is retryable and keeps the hold; it releases once the attempt is cancelled', async () => {
      await reserveFor(ORDER_1);
      await addAttempt(ORDER_1, 'stripe', 'failed');
      await setOrderState(ORDER_1, 'Cancelled');
      const first = await releaseFor(ORDER_1);
      expect(first.released).toHaveLength(0);
      expect((await stateOf(ORDER_1))!.state).toBe('held');

      await setAttemptStatus(ORDER_1, 'cancelled');
      const again = await underOrder(ORDER_1, (tx, held) =>
        settleRelease(tx, held, { storeId: STORE, orderId: ORDER_1, stripeDiscoverable: false }));
      expect(again).toHaveLength(1);
      expect((await stateOf(ORDER_1))!.state).toBe('released');
    });

    it('a definitive NMI decline is quiescent and releases at once', async () => {
      await reserveFor(ORDER_1);
      await addAttempt(ORDER_1, 'nmi', 'failed');
      await setOrderState(ORDER_1, 'Cancelled');
      expect((await releaseFor(ORDER_1)).released).toHaveLength(1);
    });

    it('an open Stripe intent with no provider ref blocks the release (pre-mint row, X-9)', async () => {
      await reserveFor(ORDER_1);
      await addAttempt(ORDER_1, 'stripe', 'open');
      await setOrderState(ORDER_1, 'Cancelled');
      expect((await releaseFor(ORDER_1)).released).toHaveLength(0);
    });

    it('a Sezzle failed attempt blocks until its authorization is released in the recovery context', async () => {
      await reserveFor(ORDER_1);
      await addAttempt(ORDER_1, 'sezzle', 'failed', 'session', { recovery: { authorization_released: false } });
      await setOrderState(ORDER_1, 'Cancelled');
      expect((await releaseFor(ORDER_1)).released).toHaveLength(0);
      await withStore(STORE, (tx) => tx.execute(sql`UPDATE payment_attempt SET context = jsonb_set(context, '{recovery,authorization_released}', 'true')`));
      expect((await releaseFor(ORDER_1)).released).toHaveLength(1);
    });

    it('a pending Pending/Authorized payment blocks the release', async () => {
      await reserveFor(ORDER_1);
      await addPayment(PAY_1, ORDER_1, 'Pending');
      await setOrderState(ORDER_1, 'Cancelled');
      expect((await releaseFor(ORDER_1)).released).toHaveLength(0);
    });

    it('an untracked Stripe intent (stripeDiscovery hold) blocks the release when discoverable', async () => {
      await reserveFor(ORDER_1);
      await setOrderState(ORDER_1, 'Cancelled');
      await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET metadata = '{"stripeDiscovery":{"hold":true}}'::jsonb WHERE id = ${ORDER_1}`));
      const q = (stripeDiscoverable: boolean) =>
        withStore(STORE, (tx) => providerQuiescent(tx, STORE, ORDER_1, { stripeDiscoverable }));
      expect(await q(false)).toBe(true);
      expect(await q(true)).toBe(false);
    });
  });

  describe('releaseOnFullRefund (R5)', () => {
    it('releases a consumed hold that asked for it once the order is Refunded', async () => {
      await reserveFor(ORDER_1, OWNER, { releaseOnFullRefund: true });
      await addPayment(PAY_1, ORDER_1);
      await setOrderState(ORDER_1, 'Paid');
      await underOrder(ORDER_1, (tx, held) => consume(tx, held, { storeId: STORE, orderId: ORDER_1, paymentId: PAY_1, operationId: 'op-1' }));

      expect(await underOrder(ORDER_1, (tx, held) => releaseOnFullRefund(tx, held, { storeId: STORE, orderId: ORDER_1 }))).toEqual([]);
      await setOrderState(ORDER_1, 'Refunded');
      const out = await underOrder(ORDER_1, (tx, held) => releaseOnFullRefund(tx, held, { storeId: STORE, orderId: ORDER_1 }));
      expect(out).toHaveLength(1);
      expect((await stateOf(ORDER_1))!.state).toBe('released');
    });

    it('keeps a consumed hold that did not ask for release', async () => {
      await reserveFor(ORDER_1);
      await addPayment(PAY_1, ORDER_1);
      await setOrderState(ORDER_1, 'Paid');
      await underOrder(ORDER_1, (tx, held) => consume(tx, held, { storeId: STORE, orderId: ORDER_1, paymentId: PAY_1, operationId: 'op-1' }));
      await setOrderState(ORDER_1, 'Refunded');
      expect(await underOrder(ORDER_1, (tx, held) => releaseOnFullRefund(tx, held, { storeId: STORE, orderId: ORDER_1 }))).toEqual([]);
      expect((await stateOf(ORDER_1))!.state).toBe('consumed');
    });
  });

  describe('findOpen', () => {
    it('returns held and consumed rows only, narrowed by order/kind/owner', async () => {
      await reserveFor(ORDER_1);
      await reserveFor(ORDER_2, 'licence-src-2');
      await setOrderState(ORDER_2, 'Cancelled');
      await releaseFor(ORDER_2);
      const open = await withStore(STORE, (tx) => findOpen(tx, { storeId: STORE, kind: KIND }));
      expect(open.map((r) => r.orderId)).toEqual([ORDER_1]);
      expect(await withStore(STORE, (tx) => findOpen(tx, { storeId: STORE, orderId: ORDER_2 }))).toEqual([]);
    });
  });

  describe('schema rules (migration 0091)', () => {
    it('rejects a released row without a provider terminal proof (shape check)', async () => {
      await reserveFor(ORDER_1);
      await expect(
        withStore(STORE, (tx) => tx.execute(sql`UPDATE order_reservation SET state = 'released', released_at = now() WHERE order_id = ${ORDER_1}`)),
      ).rejects.toSatisfy((e: unknown) => /order_reservation_shape_check/.test(rlsErrorText(e)));
    });

    it('rejects a second live holder of the same owner at the database (I2 defence in depth)', async () => {
      await reserveFor(ORDER_1);
      await expect(
        withStore(STORE, (tx) => tx.execute(sql`INSERT INTO order_reservation (store_id, order_id, kind, owner_key) VALUES (${STORE}, ${ORDER_2}, ${KIND}, ${OWNER})`)),
      ).rejects.toSatisfy((e: unknown) => /order_reservation_live_owner/.test(rlsErrorText(e)));
    });

    it('lists the order reservations in the L4 plan', async () => {
      await reserveFor(ORDER_1);
      const plan = await underOrder(ORDER_1, async (_tx, _held, p) => p);
      expect(plan.reservationIds).toHaveLength(1);
      expect(plan.orderIds).toEqual([ORDER_1]);
    });

    it('cascades: deleting an order deletes its reservations, the other order is untouched', async () => {
      await reserveFor(ORDER_1);
      await reserveFor(ORDER_2, 'licence-src-2');
      await withStore(STORE, (tx) => tx.execute(sql`DELETE FROM "order" WHERE id = ${ORDER_1}`));
      const left = await withStore(STORE, (tx) => tx.select().from(s.orderReservation));
      expect(left.map((r) => r.orderId)).toEqual([ORDER_2]);
    });

    it('FK actions: store and order cascade, consumed payment is set null (no existing delete is blocked)', async () => {
      const { rows } = await pool.query(`
        SELECT replace(c.confrelid::regclass::text, '"', '') AS target, c.confdeltype::text AS action
          FROM pg_constraint c
         WHERE c.conrelid = 'order_reservation'::regclass AND c.contype = 'f'
         ORDER BY 1`);
      expect(rows).toEqual([
        { target: 'order', action: 'c' },
        { target: 'payment', action: 'n' },
        { target: 'store', action: 'c' },
      ]);
    });

    it('a payment delete does not block: consumed_payment_id is set to NULL', async () => {
      await reserveFor(ORDER_1);
      await addPayment(PAY_1, ORDER_1);
      await setOrderState(ORDER_1, 'Paid');
      await underOrder(ORDER_1, (tx, held) => consume(tx, held, { storeId: STORE, orderId: ORDER_1, paymentId: PAY_1, operationId: 'op-1' }));
      await withStore(STORE, (tx) => tx.execute(sql`DELETE FROM payment WHERE id = ${PAY_1}`));
      expect(await stateOf(ORDER_1)).toMatchObject({ state: 'consumed', consumedPaymentId: null });
    });
  });

  describe('tenant isolation (RLS)', () => {
    // Checked through the non-owner role only: CI runs as a superuser, which bypasses RLS.
    it('the non-owner app role sees and writes only its own store', async () => {
      await reserveFor(ORDER_1);
      const rows = await withStoreApp(OTHER_STORE, (tx) => tx.execute(sql`SELECT id FROM order_reservation`));
      expect(rows.rows).toEqual([]);
      await expectRlsRejection(
        withStoreApp(STORE, (tx) => tx.execute(sql`INSERT INTO order_reservation (store_id, order_id, kind, owner_key) VALUES (${OTHER_STORE}, ${ORDER_OTHER}, ${KIND}, 'x')`)),
      );
    });
  });
});

