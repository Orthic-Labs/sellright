/**
 * DB tests — HARDENING FIX 1: the single-order cancel endpoint
 * (POST /v1/admin/orders/{code}/cancel, admin.ts) must reject a Paid order
 * exactly like the bulk-cancel route already does (admin-order-ops.ts) —
 * cancelling releases stock but never touches money, so a Paid order has to
 * go through Refund instead. Before the fix this route only checked
 * canTransition(state, 'Cancelled'), and the FSM allows Paid->Cancelled (for
 * the state transition that happens AFTER a refund), so a Paid order could be
 * cancelled directly: stock released, order Cancelled, payment left Settled,
 * any issued license left active — the customer keeps the product and a paid
 * refund never happens.
 *
 * Mirrors admin-orders.refund.test.ts / admin-orders.bulk.test.ts conventions:
 * _test-DB guard + TRUNCATE store CASCADE wipe + seed helpers under
 * withStore(). vitest runs files serially (fileParallelism: false).
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { withLockedSet } from '../db/locks.js';
import * as s from '../db/schema.js';
import { issue, reserve } from '../account-credit/service.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { admin as adminRoutes } from './admin.js';
import { adminOrderOps } from './admin-order-ops.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'admin-orders.cancel.test.ts');

const STORE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SLUG = 'admin-cancel-test-store';
const ADMIN = 'dddddddd-dddd-dddd-dddd-00000000000a';
const VARIANT = 'dddddddd-dddd-dddd-dddd-00000000000b';

const app = new OpenAPIHono();
app.route('/', adminRoutes);
const bulkApp = new OpenAPIHono();
bulkApp.route('/', adminRoutes);
bulkApp.route('/', adminOrderOps);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seedStoreAndAdmin(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@cancel.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT}, ${STORE}, ${pid}, 'SKU1', 'V1', 1000) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 100, 5) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 100, allocated = 5`);
  });
  return createAdminSession(ADMIN);
}

/** Seed an order in `state` with one unfulfilled line reserving 5 units. */
async function seedOrder(code: string, state: 'PendingPayment' | 'Paid'): Promise<string> {
  const orderId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, ${state}::order_state, 'USD', 1000)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${VARIANT}, 'SKU1', 'V1', 5, 1000, 1000, 1000, 0)`);
  });
  if (state === 'Paid') {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`
        INSERT INTO payment (id, store_id, order_id, amount, method, state, provider_ref)
        VALUES (gen_random_uuid(), ${STORE}, ${orderId}, 1000, 'stripe', 'Settled', ${'pi_' + code})`);
    });
  }
  return orderId;
}

async function orderState(orderId: string): Promise<string> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT state FROM "order" WHERE id = ${orderId}`);
    return (r.rows[0] as { state: string }).state;
  });
}

async function paymentState(orderId: string): Promise<string | null> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT state FROM payment WHERE order_id = ${orderId} LIMIT 1`);
    return (r.rows[0] as { state: string } | undefined)?.state ?? null;
  });
}

async function stockAllocated(): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT allocated FROM stock WHERE variant_id = ${VARIANT}`);
    return (r.rows[0] as { allocated: number }).allocated;
  });
}

async function cancelOrder(code: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(`/v1/admin/orders/${code}/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  return { status: res.status, body: await res.json() };
}

/** Credit is reserved, while this edit's proposed economics remain inactive. */
async function seedStagedCreditOrder(code: string, phase: string): Promise<string> {
  const orderId = await seedOrder(code, 'PendingPayment');
  const issued = await withStore(STORE, tx => issue(tx, {
    storeId: STORE, email: 'credit@cancel.test', amount: 2000, issuanceKey: code,
  }));
  await withLockedSet(STORE, { kind: 'order', orderId }, async tx => {
    await tx.update(s.order).set({ promotionId: issued.account.promotionId, couponCodes: [issued.code] })
      .where(eq(s.order.id, orderId));
    await reserve(tx, { storeId: STORE, orderId, accountId: issued.account.id, appliedAmount: 500, phase: 'ArrangingPayment' });
    await tx.insert(s.orderReservation).values({ storeId: STORE, orderId, kind: 'test-edit-resource', ownerKey: code, holder: { source: 'cancel-regression' } });
    await tx.insert(s.orderEdit).values({ id: randomUUID(), storeId: STORE, orderId,
      before: { grandTotal: 1000, couponCodes: [issued.code] }, after: { grandTotal: 1200, couponCodes: [issued.code] },
      balance: 200, actor: 'owner@cancel.test', settlement: { phase, type: 'leave_due', status: 'due' } });
  });
  return orderId;
}

async function cancellationResources(orderId: string) {
  return withStore(STORE, async tx => ({
    order: await tx.select().from(s.order).where(eq(s.order.id, orderId)),
    lines: await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, orderId)),
    payments: await tx.select().from(s.payment).where(eq(s.payment.orderId, orderId)),
    edits: await tx.select().from(s.orderEdit).where(eq(s.orderEdit.orderId, orderId)),
    reservations: await tx.select().from(s.orderReservation).where(eq(s.orderReservation.orderId, orderId)),
    creditAccounts: await tx.select().from(s.accountCredit).orderBy(s.accountCredit.id),
    creditLedger: await tx.select().from(s.accountCreditTransaction).orderBy(s.accountCreditTransaction.id),
    loyalty: await tx.select().from(s.loyaltyLedger).where(eq(s.loyaltyLedger.orderId, orderId)),
    audit: await tx.select().from(s.auditLog).where(eq(s.auditLog.entityId, orderId)),
  }));
}

let token = '';
beforeEach(async () => {
  await wipe();
  token = await seedStoreAndAdmin();
});
afterAll(async () => {
  await wipe();
  await pool.end();
});

describe('POST /v1/admin/orders/{code}/cancel — HARDENING FIX 1', () => {
  it('rejects cancelling a Paid order (409) — money and licenses must go through Refund instead', async () => {
    const orderId = await seedOrder('SR-CANCEL-PAID-1', 'Paid');

    const res = await cancelOrder('SR-CANCEL-PAID-1');

    expect(res.status).toBe(409);
    expect((res.body as { error: { message: string } }).error.message).toMatch(/paid order.*use Refund/i);
    // Nothing changed: order still Paid, payment still Settled, stock untouched.
    expect(await orderState(orderId)).toBe('Paid');
    expect(await paymentState(orderId)).toBe('Settled');
    expect(await stockAllocated()).toBe(5);
  });

  it('still allows cancelling a PendingPayment order and releases its stock', async () => {
    const orderId = await seedOrder('SR-CANCEL-UNPAID-1', 'PendingPayment');

    const res = await cancelOrder('SR-CANCEL-UNPAID-1');

    expect(res.status).toBe(200);
    expect(await orderState(orderId)).toBe('Cancelled');
    expect(await stockAllocated()).toBe(0); // released
  });
});

describe('prepared order edit cancellation fence', () => {
  it.each(['prepared', 'awaiting_refund', 'awaiting_tender', 'ready', 'failed'])(
    'single cancel refuses %s edit without releasing credit or stock', async phase => {
      const code = `SR-CANCEL-EDIT-${phase}`;
      const orderId = await seedStagedCreditOrder(code, phase);
      const before = await cancellationResources(orderId);

      const response = await cancelOrder(code);

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ error: { code: 'ORDER_EDIT_PENDING' } });
      expect(await cancellationResources(orderId)).toEqual(before);
      expect(await stockAllocated()).toBe(5);
      expect(before.creditLedger).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'RESERVE', status: 'PENDING', amount: 500 }),
      ]));
    },
  );

  it('bulk cancel skips staged credited order & still cancels another eligible order', async () => {
    const code = 'SR-BULK-EDIT-PENDING';
    const orderId = await seedStagedCreditOrder(code, 'prepared');
    const otherId = await seedOrder('SR-BULK-EDIT-OTHER', 'PendingPayment');
    await withStore(STORE, tx => tx.execute(sql`UPDATE stock SET allocated = 10 WHERE variant_id = ${VARIANT}`));
    const before = await cancellationResources(orderId);

    const response = await bulkApp.request('/v1/admin/orders/bulk-cancel', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ codes: [code, 'SR-BULK-EDIT-OTHER'] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ succeeded: 1, skipped: 1, results: [
      { code, ok: false, error: expect.stringMatching(/prepared order edit/i) },
      { code: 'SR-BULK-EDIT-OTHER', ok: true },
    ] });
    expect(await cancellationResources(orderId)).toEqual(before);
    expect(await orderState(otherId)).toBe('Cancelled');
    expect(await stockAllocated()).toBe(5);
  });

  it('observes edit preparation committed by preceding order-lock holder', async () => {
    const code = 'SR-CANCEL-EDIT-LOCK';
    const orderId = await seedStagedCreditOrder(code, 'prepared');
    const before = await cancellationResources(orderId);
    const preparedEdit = before.edits[0]!;
    await withStore(STORE, tx => tx.delete(s.orderEdit).where(eq(s.orderEdit.id, preparedEdit.id)));
    let entered!: () => void;
    let unlock!: () => void;
    const lockEntered = new Promise<void>(resolve => { entered = resolve; });
    const keepLocked = new Promise<void>(resolve => { unlock = resolve; });
    const preparation = withLockedSet(STORE, { kind: 'order', orderId }, async tx => {
      await tx.insert(s.orderEdit).values(preparedEdit);
      entered();
      await keepLocked;
    });
    await lockEntered;
    let completed = false;
    const cancellation = cancelOrder(code).then(response => { completed = true; return response; });
    try {
      await pause(150);
      expect(completed).toBe(false);
      expect(await orderState(orderId)).toBe('PendingPayment');
    } finally {
      unlock();
      await preparation;
      await cancellation;
    }
    expect((await cancellation).status).toBe(409);
    expect(await cancellationResources(orderId)).toEqual(before);
    expect(await stockAllocated()).toBe(5);
  }, 20000);
});

// X-46: admin cancel (single and bulk) takes the L0 pay advisory for the order before its lock set,
// so it waits for an in-flight pay / capture holder of the same key.
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function holdPayAdvisory(code: string) {
  const client = await pool.connect();
  const key = `pay:${STORE}:${code}`;
  await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
  return { release: async () => { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]); client.release(); } };
}

describe('X-46 admin cancel waits for the pay advisory holder', () => {
  it('single cancel waits while another session holds pay:{store}:{code}', async () => {
    const orderId = await seedOrder('SR-CANCEL-PAYLOCK-1', 'PendingPayment');
    const holder = await holdPayAdvisory('SR-CANCEL-PAYLOCK-1');
    try {
      const started = Date.now();
      const pending = cancelOrder('SR-CANCEL-PAYLOCK-1');
      await pause(1200);
      expect(await orderState(orderId)).toBe('PendingPayment'); // still waiting on the advisory
      await holder.release();
      const res = await pending;
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1100);
      expect(await orderState(orderId)).toBe('Cancelled');
    } finally {
      await holder.release().catch(() => undefined);
    }
  }, 20000);

  it('bulk cancel waits while another session holds pay:{store}:{code}', async () => {
    const orderId = await seedOrder('SR-CANCEL-PAYLOCK-2', 'PendingPayment');
    const holder = await holdPayAdvisory('SR-CANCEL-PAYLOCK-2');
    try {
      const started = Date.now();
      const pending = bulkApp.request('/v1/admin/orders/bulk-cancel', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
        body: JSON.stringify({ codes: ['SR-CANCEL-PAYLOCK-2'] }),
      });
      await pause(1200);
      expect(await orderState(orderId)).toBe('PendingPayment');
      await holder.release();
      const res = await pending;
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1100);
      expect(await orderState(orderId)).toBe('Cancelled');
    } finally {
      await holder.release().catch(() => undefined);
    }
  }, 20000);
});
