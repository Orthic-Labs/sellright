/**
 * #374: Cancelled, money-free orders are deleted 24 h after cancellation; anything that touched money, is still
 * unresolved at a provider, was fulfilled/refunded, is imported history or carries the keep marker survives.
 * Runs against a *_test database only (TRUNCATE store CASCADE between cases).
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { financialReconciliationMetadata } from '../import/financial-reconciliation.testkit.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const onStockChangedCalls: string[] = [];
vi.mock('../manifest/stock-hook.js', () => ({
  onStockChanged: (storeSlug: string) => { onStockChangedCalls.push(storeSlug); },
}));

import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { PURGE_CANCELLED_ACTOR, purgeCancelledOrders } from './purge-cancelled-orders.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'purge-cancelled-orders.db.test.ts');

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1';
const SLUG = 'purge-cancelled-test-store';
const VARIANT = 'eeeeeeee-eeee-eeee-eeee-00000000000b';
const HOUR = 3_600_000;

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

type Seed = { state?: string; cancelledHoursAgo?: number | null; updatedHoursAgo?: number; metadata?: unknown; heldUnits?: number };

/** A Cancelled order with one line; `cancelledHoursAgo` writes the cancel audit row (null = none, like older paths). */
async function seedOrder(code: string, o: Seed = {}): Promise<string> {
  return withStore(STORE, async (tx) => {
    const updated = new Date(Date.now() - (o.updatedHoursAgo ?? 0) * HOUR).toISOString();
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total, created_at, updated_at, metadata)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, ${o.state ?? 'Cancelled'}, 'USD', 1000, now() - interval '3 days', ${updated}::timestamptz,
        ${JSON.stringify(o.metadata ?? {})}::jsonb)
      RETURNING id`);
    const id = (r.rows[0] as { id: string }).id;
    const held = o.heldUnits ?? 0;
    await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty, cancelled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${id}, ${VARIANT}, 'SKU1', 'V1', 2, 500, 1000, 1000, 0, ${2 - held})`);
    const hoursAgo = o.cancelledHoursAgo === undefined ? 25 : o.cancelledHoursAgo;
    if (hoursAgo !== null) {
      await tx.execute(sql`INSERT INTO audit_log (store_id, actor, entity, entity_id, action, from_state, to_state, at)
        VALUES (${STORE}, 'system:reservation-expiry', 'order', ${id}, 'cancel', 'PendingPayment', 'Cancelled', now() - make_interval(hours => ${hoursAgo}))`);
    }
    return id;
  });
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

const codes = () => withStore(STORE, async (tx) =>
  ((await tx.execute(sql`SELECT code FROM "order" ORDER BY code`)).rows as { code: string }[]).map((r) => r.code));

describe('purgeCancelledOrders (#374)', () => {
  beforeEach(async () => { onStockChangedCalls.length = 0; await wipe(); });
  afterAll(async () => { await wipe(); await pool.end(); });

  it('deletes a money-free order cancelled more than 24 h ago, audits it, and leaves younger ones', async () => {
    await seedStore();
    const old = await seedOrder('C-OLD');
    await addPayment(old, 'Declined');
    await addAttempt(old, 'failed');
    await seedOrder('C-YOUNG', { cancelledHoursAgo: 2 });

    expect(await purgeCancelledOrders({ apply: false, hours: 24 })).toEqual({ purged: 1, skipped: 0 });
    expect(await codes()).toEqual(['C-OLD', 'C-YOUNG']); // dry run writes nothing

    const lines: string[] = [];
    expect(await purgeCancelledOrders({ apply: true, hours: 24, log: (m) => lines.push(m) })).toEqual({ purged: 1, skipped: 0 });
    expect(await codes()).toEqual(['C-YOUNG']);
    expect(lines).toContain(`[purge-cancelled] ${SLUG}: deleted C-OLD`);
    const audit = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT actor, data FROM audit_log WHERE entity_id = ${old} AND action = 'purge'`)).rows);
    expect(audit).toEqual([{ actor: PURGE_CANCELLED_ACTOR, data: expect.objectContaining({ code: 'C-OLD', state: 'Cancelled', reason: 'cancelled_expired', hours: 24 }) }]);
    const left = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT
      (SELECT count(*)::int FROM payment WHERE order_id = ${old}) AS payments,
      (SELECT count(*)::int FROM payment_attempt WHERE order_id = ${old}) AS attempts,
      (SELECT count(*)::int FROM order_line WHERE order_id = ${old}) AS lines`)).rows[0]);
    expect(left).toEqual({ payments: 0, attempts: 0, lines: 0 });
    expect(await purgeCancelledOrders({ apply: true, hours: 24 })).toEqual({ purged: 0, skipped: 0 }); // idempotent
  });

  it('keeps anything that touched money, is unresolved, fulfilled, refunded, imported or marked to keep', async () => {
    await seedStore();
    await addPayment(await seedOrder('K-SETTLED'), 'Settled');
    await addPayment(await seedOrder('K-AUTHORIZED'), 'Authorized');
    await addPayment(await seedOrder('K-PENDING-PAY'), 'Pending');
    for (const status of ['unknown', 'processing', 'pending', 'open', 'settled']) await addAttempt(await seedOrder(`K-ATTEMPT-${status}`), status);
    const refunded = await seedOrder('K-REFUND');
    const pay = await addPayment(refunded, 'Declined');
    await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO refund (store_id, payment_id, order_id, amount) VALUES (${STORE}, ${pay}, ${refunded}, 100)`));
    const shipped = await seedOrder('K-FULFILLED');
    await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO fulfillment (store_id, order_id) VALUES (${STORE}, ${shipped})`));
    await seedOrder('K-RETAIN', { metadata: { retainCancelled: true } });
    await seedOrder('K-IMPORTED', { metadata: financialReconciliationMetadata(null) });
    await seedOrder('K-PAID', { state: 'Paid' });
    await seedOrder('K-UNPAID', { state: 'PendingPayment' });
    await seedOrder('Z-DELETE');

    expect(await purgeCancelledOrders({ apply: true, hours: 24 })).toEqual({ purged: 1, skipped: 0 });
    expect((await codes()).filter((c) => c.startsWith('Z-'))).toEqual([]);
    expect(await codes()).toHaveLength(14);
  });

  it('falls back to updated_at when the order has no cancel audit row', async () => {
    await seedStore();
    await seedOrder('F-OLD', { cancelledHoursAgo: null, updatedHoursAgo: 30 });
    await seedOrder('F-NEW', { cancelledHoursAgo: null, updatedHoursAgo: 1 });
    expect(await purgeCancelledOrders({ apply: true, hours: 24 })).toEqual({ purged: 1, skipped: 0 });
    expect(await codes()).toEqual(['F-NEW']);
  });

  it('releases stock an order still held and regenerates the manifest once, after commit', async () => {
    await seedStore(2);
    await seedOrder('S-HELD', { heldUnits: 2 });
    expect(await purgeCancelledOrders({ apply: true, hours: 24 })).toEqual({ purged: 1, skipped: 0 });
    const allocated = await withStore(STORE, async (tx) => ((await tx.execute(sql`SELECT allocated FROM stock WHERE variant_id = ${VARIANT}`)).rows[0] as { allocated: number }).allocated);
    expect(allocated).toBe(0);
    expect(onStockChangedCalls).toEqual([SLUG]);
  });

  it('never touches stock or the manifest on a dry run', async () => {
    await seedStore(2);
    await seedOrder('D-HELD', { heldUnits: 2 });
    expect(await purgeCancelledOrders({ apply: false, hours: 24 })).toEqual({ purged: 1, skipped: 0 });
    expect(onStockChangedCalls).toEqual([]);
  });
});
