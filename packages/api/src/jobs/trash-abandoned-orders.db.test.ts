/**
 * #359: orders cancelled by the stale-unpaid job are trashed (soft delete) 60 min later; everything else survives.
 * Runs against a *_test database only (TRUNCATE store CASCADE between cases).
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { financialReconciliationMetadata } from '../import/financial-reconciliation.testkit.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: () => {} }));

import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { CANCEL_SOURCE_RELEASE_STALE } from '../orders/cancel-unpaid.js';
import { releaseStaleAllocations } from './release-stale-allocations.js';
import { TRASH_ABANDONED_ACTOR, trashAbandonedOrders } from './trash-abandoned-orders.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'trash-abandoned-orders.db.test.ts');

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2';
const SLUG = 'trash-abandoned-test-store';
const VARIANT = 'eeeeeeee-eeee-eeee-eeee-00000000001b';
const MIN = 60_000;

const wipe = () => pool.query('TRUNCATE store CASCADE');

async function seedStore(allocated = 0): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG})`);
    const p = await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') RETURNING id`);
    const pid = (p.rows[0] as { id: string }).id;
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT}, ${STORE}, ${pid}, 'SKU1', 'V1', 1000)`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 100, ${allocated})`);
  });
}

type Seed = {
  state?: string;
  /** Minutes since the latest move to Cancelled; null = no cancel audit row. Default 61 (just past the delay). */
  cancelledMinAgo?: number | null;
  /** `data.cancelSource` on the cancel audit row (default release-stale; null = the row carries none). */
  source?: string | null;
  metadata?: unknown;
  trashed?: boolean;
  heldUnits?: number;
};

async function seedOrder(code: string, o: Seed = {}): Promise<string> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total, created_at, updated_at, metadata, deleted_at)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, ${o.state ?? 'Cancelled'}, 'USD', 1000, now() - interval '3 days', now() - interval '3 days',
        ${JSON.stringify(o.metadata ?? {})}::jsonb, ${o.trashed ? sql`now() - interval '1 day'` : null})
      RETURNING id`);
    const id = (r.rows[0] as { id: string }).id;
    const held = o.heldUnits ?? 0;
    await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty, cancelled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${id}, ${VARIANT}, 'SKU1', 'V1', 2, 500, 1000, 1000, 0, ${2 - held})`);
    const minAgo = o.cancelledMinAgo === undefined ? 61 : o.cancelledMinAgo;
    if (minAgo !== null) await cancelRow(id, minAgo, o.source === undefined ? CANCEL_SOURCE_RELEASE_STALE : o.source);
    return id;
  });
}

async function cancelRow(orderId: string, minAgo: number, source: string | null): Promise<void> {
  const data = JSON.stringify(source ? { reason: 'stale_unpaid', cancelSource: source } : { reason: 'stale_unpaid' });
  await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO audit_log (store_id, actor, entity, entity_id, action, from_state, to_state, data, at)
    VALUES (${STORE}, 'x', 'order', ${orderId}, 'cancel', 'PendingPayment', 'Cancelled', ${data}::jsonb, now() - make_interval(secs => ${minAgo * 60}))`));
}

async function addPayment(orderId: string, state: string): Promise<string> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`INSERT INTO payment (store_id, order_id, amount, method, state) VALUES (${STORE}, ${orderId}, 1000, 'nmi', ${state}) RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
}

async function addAttempt(orderId: string, status: string): Promise<void> {
  await withStore(STORE, (tx) => tx.execute(sql`
    INSERT INTO payment_attempt (store_id, order_id, operation, method, account_id, mode, amount, currency, idempotency_key, fingerprint, status)
    VALUES (${STORE}, ${orderId}, 'charge', 'nmi', 'acct', 'live', 1000, 'USD', gen_random_uuid()::text, 'fp', ${status})`));
}

/** Codes of the orders now in the trash. */
const trashedCodes = () => withStore(STORE, async (tx) =>
  ((await tx.execute(sql`SELECT code FROM "order" WHERE deleted_at IS NOT NULL ORDER BY code`)).rows as { code: string }[]).map((r) => r.code));
const orderCount = () => withStore(STORE, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM "order"`)).rows[0] as { n: number }).then((r) => r.n);

describe('trashAbandonedOrders (#359)', () => {
  beforeEach(async () => { await wipe(); });
  afterAll(async () => { await wipe(); await pool.end(); });

  it('soft-deletes a release-stale cancel older than the delay, audits it, and never hard-deletes', async () => {
    await seedStore();
    const old = await seedOrder('T-OLD');
    await addPayment(old, 'Declined');
    await addAttempt(old, 'failed');
    await seedOrder('T-YOUNG', { cancelledMinAgo: 30 });

    expect(await trashAbandonedOrders({ apply: false, minutes: 60 })).toEqual({ trashed: 1, skipped: 0 });
    expect(await trashedCodes()).toEqual([]); // dry run writes nothing
    expect(await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'trash'`)).rows[0])).toEqual({ n: 0 });

    const lines: string[] = [];
    expect(await trashAbandonedOrders({ apply: true, minutes: 60, log: (m) => lines.push(m) })).toEqual({ trashed: 1, skipped: 0 });
    expect(await trashedCodes()).toEqual(['T-OLD']);
    expect(await orderCount()).toBe(2); // soft delete: both rows still exist
    expect(lines).toContain(`[trash-abandoned] ${SLUG}: trashed T-OLD`);
    const audit = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT actor, to_state, data FROM audit_log WHERE entity_id = ${old} AND action = 'trash'`)).rows);
    expect(audit).toEqual([{ actor: TRASH_ABANDONED_ACTOR, to_state: null, data: expect.objectContaining({ reason: 'abandoned_cancelled', cancelSource: CANCEL_SOURCE_RELEASE_STALE, minutes: 60 }) }]);
    expect(await trashAbandonedOrders({ apply: true, minutes: 60 })).toEqual({ trashed: 0, skipped: 0 }); // idempotent
  });

  it('honours a configurable delay', async () => {
    await seedStore();
    await seedOrder('D-90', { cancelledMinAgo: 90 });
    await seedOrder('D-10', { cancelledMinAgo: 10 });
    expect(await trashAbandonedOrders({ apply: true, minutes: 120 })).toEqual({ trashed: 0, skipped: 0 });
    expect(await trashAbandonedOrders({ apply: true, minutes: 5 })).toEqual({ trashed: 2, skipped: 0 });
    await expect(trashAbandonedOrders({ apply: true, minutes: 0 })).rejects.toThrow('minutes must be a positive number');
  });

  it('never trashes orders cancelled by anything other than release-stale', async () => {
    await seedStore();
    await seedOrder('X-MERCHANT', { source: 'admin' });
    await seedOrder('X-NO-SOURCE', { source: null }); // shopper cart reopen / older paths stamp nothing
    await seedOrder('X-NO-AUDIT', { cancelledMinAgo: null });
    // stale-cancelled, restored, then cancelled again by a merchant: the LATEST cancel decides
    const recancelled = await seedOrder('X-RECANCELLED', { cancelledMinAgo: 500 });
    await cancelRow(recancelled, 100, 'admin');
    await seedOrder('Z-TRASH');
    expect(await trashAbandonedOrders({ apply: true, minutes: 60 })).toEqual({ trashed: 1, skipped: 0 });
    expect(await trashedCodes()).toEqual(['Z-TRASH']);
  });

  it('never trashes paid, authorised, partially paid, refunded, fulfilled, imported, retained or already-trashed orders', async () => {
    await seedStore();
    for (const st of ['Settled', 'Authorized', 'Pending']) await addPayment(await seedOrder(`P-${st}`), st);
    for (const status of ['unknown', 'processing', 'pending', 'open', 'settled']) await addAttempt(await seedOrder(`A-${status}`), status);
    const refunded = await seedOrder('R-REFUND');
    const pay = await addPayment(refunded, 'Declined');
    await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO refund (store_id, payment_id, order_id, amount) VALUES (${STORE}, ${pay}, ${refunded}, 100)`));
    const shipped = await seedOrder('F-FULFILLED');
    await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO fulfillment (store_id, order_id) VALUES (${STORE}, ${shipped})`));
    // paid once (audit history), payment rows later gone/declined: still never trashed
    const wasPaid = await seedOrder('H-WAS-PAID');
    await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO audit_log (store_id, actor, entity, entity_id, action, from_state, to_state, at)
      VALUES (${STORE}, 'x', 'order', ${wasPaid}, 'pay', 'PendingPayment', 'Paid', now() - interval '3 hours')`));
    await seedOrder('K-RETAIN', { metadata: { retainCancelled: true } });
    await seedOrder('K-IMPORTED', { metadata: financialReconciliationMetadata(null) });
    await seedOrder('K-TRASHED', { trashed: true });
    await seedOrder('K-PAID-STATE', { state: 'Paid' });
    await seedOrder('K-UNPAID', { state: 'PendingPayment' });
    const before = await orderCount();
    await seedOrder('Z-TRASH');

    expect(await trashAbandonedOrders({ apply: true, minutes: 60 })).toEqual({ trashed: 1, skipped: 0 });
    expect(await trashedCodes()).toEqual(['K-TRASHED', 'Z-TRASH']); // K-TRASHED was already in the trash before the run
    expect(await orderCount()).toBe(before + 1);
  });

  it('end to end: an order release-stale cancels is trashed once the delay has passed, and not before', async () => {
    await seedStore(2);
    await seedOrder('E-STALE', { state: 'PendingPayment', cancelledMinAgo: null, heldUnits: 2 });
    await releaseStaleAllocations({ apply: true, ttlMin: 60 });
    const cancel = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT a.data->>'cancelSource' AS source, o.state FROM audit_log a JOIN "order" o ON o.id::text = a.entity_id WHERE o.code = 'E-STALE' AND a.action = 'cancel'`)).rows);
    expect(cancel).toEqual([{ source: CANCEL_SOURCE_RELEASE_STALE, state: 'Cancelled' }]);

    expect(await trashAbandonedOrders({ apply: true, minutes: 60 })).toEqual({ trashed: 0, skipped: 0 }); // cancelled just now
    expect(await trashAbandonedOrders({ apply: true, minutes: 60, now: new Date(Date.now() + 61 * MIN) })).toEqual({ trashed: 1, skipped: 0 });
    expect(await trashedCodes()).toEqual(['E-STALE']);
  });
});
