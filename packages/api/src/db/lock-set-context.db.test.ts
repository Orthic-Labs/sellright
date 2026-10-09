/**
 * X-49 lock-set context DB tests (PostgreSQL, *_test database only — these wipe data).
 *
 *   pass-through — a helper run inside an open withLockedSet on the same tx opens no transaction
 *   deferred     — edit_reconcile on a plain transaction takes the order rows on that transaction
 *   contention   — settleDeferredEditEarns waits for a refund-style set on the same order (no deadlock)
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from './client.js';
import { env } from '../env.js';
import { currentLockSet, lockSetCovers, withLockedSet } from './locks.js';
import { editReconcile } from '../payments/settlement/handlers.js';
import { reconcileOrderLoyalty, settleDeferredEditEarns } from '../loyalty/ledger.js';
import type { EffectRow } from '../payments/settlement/effects.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`lock-set context test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'dddddddd-5555-5555-5555-555555555555';
const SLUG = 'lock-set-context-store';
const CUSTOMER = 'dddddddd-5555-5555-5555-5555555555c1';
const ORDER = 'dddddddd-5555-5555-5555-5555555555a1';

afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); });

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, tax_rate, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', 0, '{}'::jsonb)`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, email_verified) VALUES (${CUSTOMER}, ${STORE}, 'ctx@example.com', true)`);
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, currency, grand_total, customer_id, metadata)
      VALUES (${ORDER}, ${STORE}, 'CTX-1', 'Paid', 'USD', 1000, ${CUSTOMER},
        '{"loyalty":{"earnPoints":10,"redeemPoints":0,"pointsDiscount":0,"expiryDays":null,"deferredEarn":{"editId":"e-1","targetEarn":12}}}'::jsonb)`);
  });
});

const effect = (orderId: string) => ({
  id: 'eff-1', storeId: STORE, operationKind: 'test', operationId: 'op-1', kind: 'edit_reconcile',
  payload: { orderId, customerId: CUSTOMER, paidAt: new Date().toISOString() },
}) as unknown as EffectRow;

describe('X-49 pass-through', () => {
  it('a covered helper inside an open set on the same tx opens no transaction', async () => {
    const connect = vi.spyOn(pool, 'connect');
    try {
      await withLockedSet(STORE, { kind: 'order', orderId: ORDER }, async (tx) => {
        expect(currentLockSet(tx)).not.toBeNull();
        expect(await lockSetCovers(tx, STORE, { kind: 'order', orderId: ORDER })).toBe(true);
        const before = connect.mock.calls.length;
        const out = await editReconcile.run(tx, effect(ORDER));
        expect(out).toMatchObject({ done: expect.anything() });
        expect(connect.mock.calls.length).toBe(before); // no nested transaction
      });
    } finally {
      connect.mockRestore();
    }
  });

  it('the set is scoped to its own transaction: another tx sees no set', async () => {
    await withLockedSet(STORE, { kind: 'order', orderId: ORDER }, async () => undefined);
    await withStore(STORE, async (tx) => {
      expect(currentLockSet(tx)).toBeNull();
      expect(await lockSetCovers(tx, STORE, { kind: 'order', orderId: ORDER })).toBe(false);
    });
  });
});

describe('X-49 deferred edit_reconcile', () => {
  it('on a plain transaction it takes the order rows on that transaction (held until commit)', async () => {
    await withStore(STORE, async (tx) => {
      expect(currentLockSet(tx)).toBeNull();
      const out = await editReconcile.run(tx, effect(ORDER));
      expect(out).toMatchObject({ done: expect.anything() });
      // Another session cannot take the order row while this transaction is open.
      const other = await pool.connect();
      try {
        await other.query('BEGIN');
        await other.query("SELECT set_config('app.current_store', $1, true)", [STORE]); // RLS: rows are store-scoped
        await expect(other.query(`SELECT id FROM "order" WHERE id = $1 FOR UPDATE NOWAIT`, [ORDER]))
          .rejects.toMatchObject({ code: '55P03' });
      } finally {
        await other.query('ROLLBACK').catch(() => undefined);
        other.release();
      }
    });
  });

  it('a customer set on this tx does not cover another customer\'s order', async () => {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO customer (id, store_id, email, email_verified) VALUES ('dddddddd-5555-5555-5555-5555555555c2', ${STORE}, 'other@example.com', true)`);
      await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, currency, grand_total, customer_id)
        VALUES ('dddddddd-5555-5555-5555-5555555555a2', ${STORE}, 'CTX-2', 'Paid', 'USD', 1000, 'dddddddd-5555-5555-5555-5555555555c2')`);
    });
    await withLockedSet(STORE, { kind: 'customer', customerId: 'dddddddd-5555-5555-5555-5555555555c2' }, async (tx) => {
      // The customer set covers its own order (a2) but not order a1 (customer c1).
      expect(await lockSetCovers(tx, STORE, { kind: 'order', orderId: ORDER })).toBe(false);
    });
  });
});

describe('X-49 settleDeferredEditEarns vs a refund on the same order', () => {
  it('waits for the order set and completes, no deadlock', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });

    // Refund-style set: order row first, then the loyalty advisory (reconcileOrderLoyalty).
    const refund = withLockedSet(STORE, { kind: 'order', orderId: ORDER }, async (tx) => {
      locked();
      await reconcileOrderLoyalty(tx, { storeId: STORE, orderId: ORDER, num: 1, den: 2, sourceRef: 'refund:ctx-1', actor: 'test' });
      await held;
      return 'refunded';
    });
    await isLocked;

    const settle = withStore(STORE, (tx) => settleDeferredEditEarns(tx, STORE, CUSTOMER));
    // Let the settle transaction reach the order row, then release the refund.
    await new Promise((r) => setTimeout(r, 200));
    release();
    await expect(refund).resolves.toBe('refunded');
    await expect(settle).resolves.toBeUndefined();
  });
});
