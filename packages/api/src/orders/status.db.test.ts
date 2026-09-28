/**
 * Order/payment/fulfillment status — DB integration coverage (SR order-status
 * split). Three things a pure unit test (status.test.ts) can't prove:
 *
 *  1. The Postgres STORED GENERATED `order.status` column (migration 0080)
 *     actually computes the right value for a row inserted the way EXISTING
 *     (pre-migration-shaped) application code inserts orders — i.e. without
 *     ever mentioning `status` — which is exactly what "existing data" means
 *     for a column that's backfilled by definition, not by a data migration
 *     script.
 *  2. `orders/status-sql.ts`'s SQL fragments (used only for the admin list's
 *     `?paymentStatus=`/`?fulfillmentStatus=` filters) agree with the TS
 *     `derivePaymentStatus`/`deriveFulfillmentStatus` functions row-for-row —
 *     the one place this codebase intentionally has the same logic twice.
 *  3. The admin order list's new filters return exactly the matching orders,
 *     with pagination/count intact.
 *
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { deriveFulfillmentStatus, derivePaymentStatus, type OrderFulfillmentStatus, type OrderPaymentStatus } from './status.js';
import { fulfillmentStatusSql, paymentStatusSql } from './status-sql.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`order status test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'f0000000-0000-0000-0000-00000000f001';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seedStore(): Promise<void> {
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, 'status-test', 'Status Test', 'USD') ON CONFLICT (id) DO NOTHING`, [STORE]);
}

interface SeedOrder {
  code: string;
  state: 'PendingPayment' | 'Paid' | 'PartiallyRefunded' | 'Refunded' | 'Cancelled';
  deletedAt?: boolean;
  /** newest last — inserted with ascending created_at so the LAST one here is "most recent". */
  payments?: Array<'Pending' | 'Authorized' | 'Settled' | 'Declined' | 'Failed'>;
  lines?: Array<{ quantity: number; fulfilledQty?: number; cancelledQty?: number }>;
  fulfillments?: Array<'Pending' | 'Shipped' | 'Delivered' | 'Cancelled'>;
}

/** Inserts an order exactly the way existing application code does — never
 *  mentioning `status` (a GENERATED column can't be targeted by INSERT
 *  anyway), which is the faithful way to prove "existing data" backfills. */
async function seedOrder(o: SeedOrder): Promise<string> {
  return withStore(STORE, async (tx) => {
    const orderRes = await tx.execute(sql`
      INSERT INTO "order" (store_id, code, state, currency, deleted_at)
      VALUES (${STORE}, ${o.code}, ${o.state}, 'USD', ${o.deletedAt ? sql`now()` : null})
      RETURNING id
    `);
    const orderId = (orderRes.rows[0] as { id: string }).id;
    for (const [i, p] of (o.payments ?? []).entries()) {
      await tx.execute(sql`
        INSERT INTO payment (store_id, order_id, amount, method, state, created_at)
        VALUES (${STORE}, ${orderId}, 1000, 'stripe', ${p}, now() + (${i} || ' seconds')::interval)
      `);
    }
    for (const [i, l] of (o.lines ?? []).entries()) {
      await tx.execute(sql`
        INSERT INTO order_line (store_id, order_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty, cancelled_qty)
        VALUES (${STORE}, ${orderId}, ${'SKU-' + i}, ${'Line ' + i}, ${l.quantity}, 1000, 1000, 1000, ${l.fulfilledQty ?? 0}, ${l.cancelledQty ?? 0})
      `);
    }
    for (const f of o.fulfillments ?? []) {
      await tx.execute(sql`INSERT INTO fulfillment (store_id, order_id, state) VALUES (${STORE}, ${orderId}, ${f})`);
    }
    return orderId;
  });
}

async function orderStatus(orderId: string): Promise<string> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT status FROM "order" WHERE id = ${orderId}`);
    return (r.rows[0] as { status: string }).status;
  });
}

/** Both the SQL-fragment value (admin list filters) and the TS-derived value
 *  (every other surface), fetched the same way each surface actually does. */
async function bothPaymentAndFulfillmentStatus(orderId: string): Promise<{ sqlPaymentStatus: string; sqlFulfillmentStatus: string; tsPaymentStatus: OrderPaymentStatus; tsFulfillmentStatus: OrderFulfillmentStatus }> {
  return withStore(STORE, async (tx) => {
    const [o] = await tx.select({ state: s.order.state }).from(s.order).where(sql`${s.order.id} = ${orderId}`);
    const [sqlRow] = await tx.select({ paymentStatus: paymentStatusSql(s.order), fulfillmentStatus: fulfillmentStatusSql(s.order) }).from(s.order).where(sql`${s.order.id} = ${orderId}`);
    const payments = await tx.select({ state: s.payment.state }).from(s.payment).where(sql`${s.payment.orderId} = ${orderId}`).orderBy(sql`created_at desc`);
    const lines = await tx.select({ quantity: s.orderLine.quantity, fulfilledQty: s.orderLine.fulfilledQty, cancelledQty: s.orderLine.cancelledQty }).from(s.orderLine).where(sql`${s.orderLine.orderId} = ${orderId}`);
    const fulfillments = await tx.select({ state: s.fulfillment.state }).from(s.fulfillment).where(sql`${s.fulfillment.orderId} = ${orderId}`);
    return {
      sqlPaymentStatus: sqlRow!.paymentStatus, sqlFulfillmentStatus: sqlRow!.fulfillmentStatus,
      tsPaymentStatus: derivePaymentStatus(o!.state, payments), tsFulfillmentStatus: deriveFulfillmentStatus(lines, fulfillments),
    };
  });
}

describe('order.status GENERATED column — backfills existing-shaped inserts', () => {
  beforeEach(async () => { await wipe(); await seedStore(); });
  afterAll(async () => { await wipe(); });

  it('PendingPayment -> open', async () => expect(await orderStatus(await seedOrder({ code: 'O1', state: 'PendingPayment' }))).toBe('open'));
  it('Paid -> completed', async () => expect(await orderStatus(await seedOrder({ code: 'O2', state: 'Paid' }))).toBe('completed'));
  it('PartiallyRefunded -> completed', async () => expect(await orderStatus(await seedOrder({ code: 'O3', state: 'PartiallyRefunded' }))).toBe('completed'));
  it('Refunded -> completed', async () => expect(await orderStatus(await seedOrder({ code: 'O4', state: 'Refunded' }))).toBe('completed'));
  it('Cancelled -> cancelled', async () => expect(await orderStatus(await seedOrder({ code: 'O5', state: 'Cancelled' }))).toBe('cancelled'));
  it('deleted_at wins over every state -> archived', async () => {
    expect(await orderStatus(await seedOrder({ code: 'O6', state: 'Paid', deletedAt: true }))).toBe('archived');
    expect(await orderStatus(await seedOrder({ code: 'O7', state: 'Cancelled', deletedAt: true }))).toBe('archived');
  });
});

describe('paymentStatus/fulfillmentStatus — SQL fragment agrees with the TS function', () => {
  beforeEach(async () => { await wipe(); await seedStore(); });
  afterAll(async () => { await wipe(); });

  const cases: Array<[string, SeedOrder, OrderPaymentStatus, OrderFulfillmentStatus]> = [
    ['no payment attempt yet', { code: 'P1', state: 'PendingPayment', lines: [{ quantity: 2 }] }, 'pending', 'unfulfilled'],
    ['most recent payment Authorized', { code: 'P2', state: 'PendingPayment', payments: ['Failed', 'Authorized'], lines: [{ quantity: 1 }] }, 'authorized', 'unfulfilled'],
    ['most recent payment Declined', { code: 'P3', state: 'PendingPayment', payments: ['Declined'], lines: [{ quantity: 1 }] }, 'failed', 'unfulfilled'],
    ['Paid, fully fulfilled and delivered', { code: 'P4', state: 'Paid', payments: ['Settled'], lines: [{ quantity: 2, fulfilledQty: 2 }], fulfillments: ['Delivered'] }, 'paid', 'delivered'],
    ['Paid, shipped but not delivered', { code: 'P5', state: 'Paid', payments: ['Settled'], lines: [{ quantity: 2, fulfilledQty: 2 }], fulfillments: ['Shipped'] }, 'paid', 'fulfilled'],
    ['Paid, partially fulfilled', { code: 'P6', state: 'Paid', payments: ['Settled'], lines: [{ quantity: 4, fulfilledQty: 1 }] }, 'paid', 'partially_fulfilled'],
    ['Paid, a fully-cancelled line never blocks fulfilled', { code: 'P7', state: 'Paid', payments: ['Settled'], lines: [{ quantity: 2, cancelledQty: 2 }] }, 'paid', 'fulfilled'],
    ['PartiallyRefunded', { code: 'P8', state: 'PartiallyRefunded', payments: ['Settled'] }, 'partially_refunded', 'fulfilled'],
    ['Refunded', { code: 'P9', state: 'Refunded', payments: ['Settled'] }, 'refunded', 'fulfilled'],
    ['Cancelled with an Authorized-never-captured payment -> voided', { code: 'P10', state: 'Cancelled', payments: ['Authorized'] }, 'voided', 'fulfilled'],
    ['Cancelled with no payment attempt -> pending', { code: 'P11', state: 'Cancelled' }, 'pending', 'fulfilled'],
    ['Cancelled with only Declined attempts -> failed', { code: 'P12', state: 'Cancelled', payments: ['Declined', 'Failed'] }, 'failed', 'fulfilled'],
  ];

  it.each(cases)('%s', async (_label, seed, expectedPayment, expectedFulfillment) => {
    const orderId = await seedOrder(seed);
    const { sqlPaymentStatus, sqlFulfillmentStatus, tsPaymentStatus, tsFulfillmentStatus } = await bothPaymentAndFulfillmentStatus(orderId);
    expect(tsPaymentStatus).toBe(expectedPayment);
    expect(sqlPaymentStatus).toBe(expectedPayment);
    expect(tsFulfillmentStatus).toBe(expectedFulfillment);
    expect(sqlFulfillmentStatus).toBe(expectedFulfillment);
  });

  it('partially_delivered when one of two active fulfillment records is Delivered', async () => {
    const orderId = await seedOrder({ code: 'P13', state: 'Paid', payments: ['Settled'], lines: [{ quantity: 2, fulfilledQty: 2 }], fulfillments: ['Delivered', 'Shipped'] });
    const { sqlFulfillmentStatus, tsFulfillmentStatus } = await bothPaymentAndFulfillmentStatus(orderId);
    expect(tsFulfillmentStatus).toBe('partially_delivered');
    expect(sqlFulfillmentStatus).toBe('partially_delivered');
  });
});

describe('GET /v1/admin/orders — status/paymentStatus/fulfillmentStatus filters', () => {
  beforeEach(async () => { await wipe(); await seedStore(); });
  afterAll(async () => { await wipe(); });

  it('?paymentStatus=voided returns only the matching Cancelled-with-authorized-payment order', async () => {
    await seedOrder({ code: 'F-open', state: 'PendingPayment' });
    await seedOrder({ code: 'F-voided', state: 'Cancelled', payments: ['Authorized'] });
    await seedOrder({ code: 'F-cancelled-pending', state: 'Cancelled' });
    const rows = await withStore(STORE, (tx) =>
      tx.select({ code: s.order.code }).from(s.order).where(sql`${paymentStatusSql(s.order)} = 'voided'`),
    );
    expect(rows.map((r) => r.code)).toEqual(['F-voided']);
  });

  it('?fulfillmentStatus=delivered returns only fully-delivered orders', async () => {
    await seedOrder({ code: 'G-unfulfilled', state: 'Paid', lines: [{ quantity: 1 }] });
    await seedOrder({ code: 'G-delivered', state: 'Paid', lines: [{ quantity: 1, fulfilledQty: 1 }], fulfillments: ['Delivered'] });
    const rows = await withStore(STORE, (tx) =>
      tx.select({ code: s.order.code }).from(s.order).where(sql`${fulfillmentStatusSql(s.order)} = 'delivered'`),
    );
    expect(rows.map((r) => r.code)).toEqual(['G-delivered']);
  });

  it('?status=cancelled uses the generated column directly', async () => {
    await seedOrder({ code: 'H-open', state: 'PendingPayment' });
    await seedOrder({ code: 'H-cancelled', state: 'Cancelled' });
    const rows = await withStore(STORE, (tx) => tx.select({ code: s.order.code }).from(s.order).where(sql`${s.order.status} = 'cancelled'`));
    expect(rows.map((r) => r.code)).toEqual(['H-cancelled']);
  });
});

// One shared pool (db/client.js's module-level singleton) across all three
// describe blocks above — end it exactly once, after everything in this file
// has run, not per-describe (ending it early would break every later test in
// this file, and potentially sibling test files sharing the same process).
afterAll(async () => { await pool.end(); });
