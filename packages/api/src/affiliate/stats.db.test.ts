/**
 * DB test (vs a disposable test database ONLY — TRUNCATEs): affiliateRangeStats commission basis.
 * Commission per order = floor(10% of (subtotal - discount - refunded merchandise) + 0.5), summed; the headline equals the
 * sum of the per-order rows. Audit 2026-11-09 M-M5 / M-L6.
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { affiliateRangeStats } from './stats.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'affiliate/stats.db.test.ts');

const STORE = 'abcdabcd-0000-0000-0000-000000000001';
const PROMO = 'abcdabcd-0000-0000-0000-000000000002';

async function seedOrder(n: number, subtotal: number, refundedItems: number | null, source?: string) {
  const oid = `abcdabcd-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`;
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, subtotal, promotion_id, placed_at)
      VALUES (${oid}, ${STORE}, ${'AFF-' + n}, 'Paid', ${subtotal}, ${PROMO}, now())`);
    if (refundedItems != null) {
      const pid = `abcdabcd-0000-0000-0000-0000000002${String(n).padStart(2, '0')}`;
      await tx.execute(sql`INSERT INTO payment (id, store_id, order_id, amount, method, state, provider_ref) VALUES (${pid}, ${STORE}, ${oid}, ${subtotal}, 'stripe', 'Settled', ${'pi_' + n})`);
      await tx.execute(sql`INSERT INTO refund (store_id, order_id, payment_id, amount, state, items_amount, metadata)
        VALUES (${STORE}, ${oid}, ${pid}, ${refundedItems}, 'Settled', ${refundedItems}, ${JSON.stringify(source ? { source } : {})}::jsonb)`);
    }
  });
}

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, 'aff-stats-store', 'aff-stats-store', 'USD', '{}'::jsonb)`);
    await tx.execute(sql`INSERT INTO promotion (id, store_id, code, type, value, enabled) VALUES (${PROMO}, ${STORE}, 'AFFSTATS', 'percentage', 10, true)`);
  });
});
afterAll(async () => { await pool.end(); });

describe('affiliateRangeStats commission', () => {
  it('10000 order with 9000 merchandise refunded earns 100', async () => {
    await seedOrder(1, 10000, 9000);
    const r = await withStore(STORE, (tx) => affiliateRangeStats(tx, STORE, PROMO, {}, 10));
    expect(r.totals).toMatchObject({ orders: 1, revenue: 1000, commission: 100 });
  });
  it('three orders of 1005 earn 303 (rounded per order), not 302', async () => {
    await seedOrder(1, 1005, null); await seedOrder(2, 1005, null); await seedOrder(3, 1005, null);
    const r = await withStore(STORE, (tx) => affiliateRangeStats(tx, STORE, PROMO, {}, 10));
    expect(r.totals).toMatchObject({ orders: 3, revenue: 3015, commission: 303 });
  });
  it('an order-edit refund is not subtracted again (the edit already lowered the order totals)', async () => {
    await seedOrder(1, 10000, 2000, 'order_edit');
    const r = await withStore(STORE, (tx) => affiliateRangeStats(tx, STORE, PROMO, {}, 10));
    expect(r.totals.commission).toBe(1000);
  });
});
