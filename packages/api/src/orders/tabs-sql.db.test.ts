/**
 * #406 admin order tabs — the set-based counts (`orderTabCountsSql`, GET /v1/admin/orders/tab-counts) must equal the
 * per-row tab predicates (`orderTabSql`, the list's `?tab=` filter) for every tab. The two are the same rules written
 * twice for speed (perf/pg F1); a failure here means fix one side to match the other, never update the expectation.
 *
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { financialReconciliationMetadata } from '../import/financial-reconciliation.testkit.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { EDIT_REFUND_SOURCE } from '../payments/edit-refund.js';
import { ORDER_TABS, orderTabCountsSql, orderTabCountsSqlLegacy, orderTabFilterSql, orderTabSql, pendingFulfillmentCountSql } from './tabs-sql.js';
import { fulfillmentStatusSql, paymentStatusWithBalanceSql } from './status-sql.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'tabs-sql.db.test.ts');

const STORE = 'f0000000-0000-0000-0000-00000000f406';
const PRODUCT = 'f0000000-0000-0000-0000-00000000a406';
const VARIANT = { regular: 'f0000000-0000-0000-0000-0000000a0406', pre: 'f0000000-0000-0000-0000-0000000b0406' };

type PayState = 'Pending' | 'Authorized' | 'Settled' | 'Declined' | 'Failed';
interface SeedOrder {
  state: 'PendingPayment' | 'Paid' | 'PartiallyRefunded' | 'Refunded' | 'Cancelled';
  grandTotal?: number;
  deleted?: boolean;
  demo?: boolean;
  imported?: boolean;
  /** newest last */
  payments?: Array<PayState | { state: PayState; amount: number; duplicate?: boolean }>;
  lines?: Array<{ quantity: number; fulfilledQty?: number; cancelledQty?: number; pre?: boolean }>;
  editRefunds?: Array<{ amount: number; failed?: boolean; source?: string }>;
}

let n = 0;
async function seedOrder(o: SeedOrder): Promise<void> {
  await withStore(STORE, async (tx) => {
    const code = `TAB-${++n}`;
    const metadata = o.imported ? financialReconciliationMetadata({ source: 'vendure' }) : {};
    const r = await tx.execute(sql`
      INSERT INTO "order" (store_id, code, state, currency, grand_total, deleted_at, is_demo, metadata)
      VALUES (${STORE}, ${code}, ${o.state}, 'USD', ${o.grandTotal ?? 1000}, ${o.deleted ? sql`now()` : null}, ${o.demo ?? false}, ${JSON.stringify(metadata)}::jsonb)
      RETURNING id`);
    const orderId = (r.rows[0] as { id: string }).id;
    let lastPayment: string | null = null;
    for (const [i, p] of (o.payments ?? []).entries()) {
      const pay = typeof p === 'string' ? { state: p, amount: 1000 } : p;
      const pr = await tx.execute(sql`
        INSERT INTO payment (store_id, order_id, amount, method, state, created_at, metadata)
        VALUES (${STORE}, ${orderId}, ${pay.amount}, 'stripe', ${pay.state}, now() + (${i} || ' seconds')::interval,
          ${JSON.stringify('duplicate' in pay && pay.duplicate ? { duplicate: true } : {})}::jsonb)
        RETURNING id`);
      lastPayment = (pr.rows[0] as { id: string }).id;
    }
    for (const [i, l] of (o.lines ?? []).entries()) {
      await tx.execute(sql`
        INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty, cancelled_qty)
        VALUES (${STORE}, ${orderId}, ${l.pre ? VARIANT.pre : VARIANT.regular}, ${'SKU-' + i}, ${'Line ' + i}, ${l.quantity}, 1000, 1000, 1000, ${l.fulfilledQty ?? 0}, ${l.cancelledQty ?? 0})`);
    }
    for (const rf of o.editRefunds ?? []) {
      if (!lastPayment) throw new Error('an edit refund needs a payment');
      await tx.execute(sql`
        INSERT INTO refund (store_id, payment_id, order_id, amount, state, metadata)
        VALUES (${STORE}, ${lastPayment}, ${orderId}, ${rf.amount}, ${rf.failed ? 'Failed' : 'Settled'}, ${JSON.stringify({ source: rf.source ?? EDIT_REFUND_SOURCE })}::jsonb)`);
    }
  });
}

async function perRowCounts(excludeDemo: boolean): Promise<Record<string, number>> {
  return withStore(STORE, async (tx) => {
    const live = excludeDemo ? sql`"order"."deleted_at" is null and "order"."is_demo" = false` : sql`"order"."deleted_at" is null`;
    const cols = ORDER_TABS.map((t) => sql`(count(*) filter (where ${orderTabSql(t)}))::int as ${sql.identifier(t)}`);
    const r = await tx.execute(sql`select ${sql.join(cols, sql`, `)}, count(*)::int as "all" from "order" where ${live}`);
    return (r as unknown as { rows: Array<Record<string, number>> }).rows[0]!;
  });
}

async function setCounts(excludeDemo: boolean): Promise<Record<string, number>> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(orderTabCountsSql({ excludeDemo }));
    return (r as unknown as { rows: Array<Record<string, number>> }).rows[0]!;
  });
}

beforeAll(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, 'tabs-test', 'Tabs Test', 'USD')`, [STORE]);
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PRODUCT}, ${STORE}, 'tabs', 'Tabs', 'active')`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type, is_pre_order) VALUES
      (${VARIANT.regular}, ${STORE}, ${PRODUCT}, 'TAB-R', 'Regular', 1000, 'physical', false),
      (${VARIANT.pre}, ${STORE}, ${PRODUCT}, 'TAB-P', 'Pre-order', 1000, 'physical', true)`);
  });
  const cases: SeedOrder[] = [
    { state: 'Paid', payments: ['Settled'], lines: [{ quantity: 2 }] }, // tofulfil
    { state: 'Paid', payments: ['Settled'], lines: [{ quantity: 1, pre: true }] }, // pre only
    { state: 'Paid', payments: ['Settled'], lines: [{ quantity: 1 }, { quantity: 2, pre: true }] }, // tofulfil + pre
    { state: 'Paid', payments: ['Settled'], lines: [{ quantity: 3, fulfilledQty: 1 }] }, // partial
    { state: 'Paid', payments: ['Settled'], lines: [{ quantity: 2, fulfilledQty: 2 }] }, // shipped
    { state: 'Paid', payments: ['Settled'], lines: [{ quantity: 2, fulfilledQty: 1, cancelledQty: 1 }] }, // shipped after removal
    { state: 'Paid', payments: ['Settled'], lines: [{ quantity: 1, cancelledQty: 1 }] }, // nothing left
    { state: 'Paid', grandTotal: 1500, payments: ['Settled'], lines: [{ quantity: 1 }] }, // balance_due
    { state: 'Paid', payments: [{ state: 'Settled', amount: 1000, duplicate: true }], lines: [{ quantity: 1 }] }, // duplicate tender -> balance_due
    { state: 'Paid', payments: ['Settled'], editRefunds: [{ amount: 200 }], lines: [{ quantity: 1 }] }, // edit refund -> balance_due
    { state: 'Paid', payments: ['Settled'], editRefunds: [{ amount: 200, failed: true }] }, // failed edit refund ignored
    { state: 'Paid', payments: ['Settled'], editRefunds: [{ amount: 200, source: 'customer' }] }, // other refund source ignored
    { state: 'Paid', grandTotal: 1500, imported: true, payments: ['Settled'] }, // imported history never balance_due
    { state: 'PartiallyRefunded', payments: ['Settled'], lines: [{ quantity: 2, fulfilledQty: 1 }] },
    { state: 'PartiallyRefunded', grandTotal: 2000, payments: ['Settled'] }, // balance_due beats partially_refunded
    { state: 'Refunded', payments: ['Settled'], lines: [{ quantity: 1, fulfilledQty: 1 }] },
    { state: 'PendingPayment', lines: [{ quantity: 1 }] }, // unpaid, no payment
    { state: 'PendingPayment', payments: ['Declined', 'Authorized'] }, // latest authorized -> unpaid
    { state: 'PendingPayment', payments: ['Authorized', 'Declined'] }, // latest declined -> failed, not unpaid
    { state: 'PendingPayment', payments: ['Failed', 'Pending'] },
    { state: 'Cancelled', payments: ['Settled'], lines: [{ quantity: 1, cancelledQty: 1 }] },
    { state: 'Cancelled', payments: ['Authorized'] },
    { state: 'Cancelled', payments: ['Declined'] },
    { state: 'Cancelled' },
    { state: 'Paid', payments: ['Settled'], lines: [{ quantity: 1 }], demo: true }, // excluded by excludeDemo
    { state: 'Paid', payments: ['Settled'], lines: [{ quantity: 1 }], deleted: true }, // never counted
  ];
  for (const c of cases) await seedOrder(c);
});

afterAll(async () => {
  await pool.query('TRUNCATE store CASCADE');
});

describe('orderTabCountsSql', () => {
  it.each([false, true])('equals the per-row tab predicates (excludeDemo=%s)', async (excludeDemo) => {
    const expected = await perRowCounts(excludeDemo);
    expect(await setCounts(excludeDemo)).toEqual(expected);
    // The fixtures reach every tab, so equality is not vacuous.
    for (const t of ORDER_TABS) expect(expected[t], t).toBeGreaterThan(0);
  });

  it.each([false, true])('BP-M2: the scoped statement equals the legacy whole-store aggregation (excludeDemo=%s)', async (excludeDemo) => {
    const run = (q: ReturnType<typeof orderTabCountsSql>) => withStore(STORE, async (tx) => (await tx.execute(q)).rows[0] as Record<string, number>);
    expect(await run(orderTabCountsSql({ excludeDemo }))).toEqual(await run(orderTabCountsSqlLegacy({ excludeDemo })));
  });

  it('pins the fixture counts', async () => {
    expect(await setCounts(false)).toEqual({ tofulfil: 8, pre: 2, partial: 2, unpaid: 7, shipped: 3, refunded: 3, cancelled: 4, all: 25 });
  });
});

describe('pendingFulfillmentCountSql', () => {
  it('equals the dashboard per-row status predicate', async () => {
    const [perRow, set] = await withStore(STORE, async (tx) => {
      const a = await tx.execute(sql`select count(*)::int as n from "order" where "order"."deleted_at" is null and "order"."is_demo" = false
        and "order"."status" in ('open', 'completed') and ${paymentStatusWithBalanceSql()} = 'paid' and ${fulfillmentStatusSql()} = 'unfulfilled'`);
      const b = await tx.execute(pendingFulfillmentCountSql());
      return [(a.rows[0] as { n: number }).n, (b.rows[0] as { n: number }).n];
    });
    expect(set).toBe(perRow);
    expect(perRow).toBeGreaterThan(0); // the fixtures include paid, unshipped orders, so equality is not vacuous
  });
});

describe('orderTabFilterSql', () => {
  it.each([...ORDER_TABS])('selects the same orders as orderTabSql (%s)', async (tab) => {
    const ids = (cond: ReturnType<typeof orderTabSql>) => withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`select "order"."code" from "order" where "order"."deleted_at" is null and ${cond} order by "order"."code"`);
      return (r.rows as Array<{ code: string }>).map((x) => x.code);
    });
    const expected = await ids(orderTabSql(tab));
    expect(await ids(orderTabFilterSql(tab))).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });
});
