// B3/N12: every stock writer locks stock rows in canonical (variant id) order, so writers touching the same rows in
// different caller orders wait instead of deadlocking. Scenario per writer: a canonical-order holder locks A, the
// writer under test is handed [B, A], then the holder writes B. A caller-order writer would hold B and wait on A →
// deadlock (40P01). A canonical writer waits on A first holding nothing, so both commit.
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';

vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: () => {} }));

import { pool, withStore, type Tx } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminProducts } from '../routes/admin-products.js';
import { reserveStockOrThrow, type ReservableVariant } from './stock-reservation.js';
import { lockStockRowsInOrder } from '../db/locks.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'stock-lock-order.db.test.ts');

const STORE = 'eeeeeeee-3333-3333-3333-333333333333';
const SLUG = 'stock-lock-order-store';
const ADMIN = 'eeeeeeee-3333-3333-3333-00000000000a';
// A sorts before B as lowercase text and as Postgres uuid.
const A = 'eeeeeeee-3333-3333-3333-0000000000a1';
const B = 'eeeeeeee-3333-3333-3333-0000000000b2';
const app = new OpenAPIHono();
app.route('/', adminProducts);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM admin_user WHERE id = $1', [ADMIN]);
}
async function seed(): Promise<string> {
  await withStore(STORE, async tx => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG})`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@stock-lock-order.test', 'x')`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner')`);
    const r = await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') RETURNING id`);
    const pid = (r.rows[0] as { id: string }).id;
    for (const [id, sku] of [[A, 'SKU-A'], [B, 'SKU-B']] as const) {
      await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${id}, ${STORE}, ${pid}, ${sku}, ${sku}, 1000)`);
      await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${id}, ${STORE}, 10, 0)`);
    }
  });
  return createAdminSession(ADMIN);
}
let token = '';
beforeEach(async () => { await wipe(); token = await seed(); });
afterAll(wipe);

/** Resolves once some backend of this database waits on a row lock held on a stock row of this store. */
async function waitForBlockedWriter(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.datname = current_database() AND a.query ILIKE '%stock%'`);
    if (r.rows[0].n > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('writer never blocked');
}

/** Canonical-order holder: locks A, waits for the writer under test to block, then writes B and commits. */
async function canonicalHolder(writer: () => Promise<unknown>): Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]> {
  let started!: () => void;
  const lockedA = new Promise<void>(resolve => { started = resolve; });
  let writerRun!: Promise<unknown>;
  const holder = withStore(STORE, async tx => {
    await tx.execute(sql`SET LOCAL lock_timeout = '4s'`);
    await tx.execute(sql`SELECT 1 FROM stock WHERE variant_id = ${A} FOR NO KEY UPDATE`);
    started();
    await waitForBlockedWriter();
    await tx.execute(sql`UPDATE stock SET on_hand = on_hand + 1 WHERE variant_id = ${B}`);
  });
  await lockedA;
  writerRun = writer();
  return Promise.allSettled([holder, writerRun]) as never;
}
const stock = async () => Object.fromEntries((await withStore(STORE, tx => tx.execute(sql`SELECT variant_id, on_hand, allocated FROM stock WHERE store_id = ${STORE}`)))
  .rows.map((r: any) => r).map((r: { variant_id: string; on_hand: number; allocated: number }) => [r.variant_id, { onHand: r.on_hand, allocated: r.allocated }]));

const bySku = new Map<string, ReservableVariant>([
  ['SKU-A', { id: A, sku: 'SKU-A', enabled: true, isPreOrder: false }],
  ['SKU-B', { id: B, sku: 'SKU-B', enabled: true, isPreOrder: false }],
]);

describe('canonical stock lock order', () => {
  it('reserveStockOrThrow given [B, A] does not deadlock against a canonical writer', async () => {
    const [holder, writer] = await canonicalHolder(() => withStore(STORE, async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '4s'`);
      return reserveStockOrThrow(tx, STORE, [{ sku: 'SKU-B', quantity: 2 }, { sku: 'SKU-A', quantity: 3 }], bySku);
    }));
    expect(holder.status).toBe('fulfilled');
    expect(writer).toMatchObject({ status: 'fulfilled', value: true });
    expect(await stock()).toEqual({ [A]: { onHand: 10, allocated: 3 }, [B]: { onHand: 11, allocated: 2 } });
  });

  it('reservation never oversells under concurrent checkouts of the last units', async () => {
    await withStore(STORE, tx => tx.execute(sql`UPDATE stock SET on_hand = 3 WHERE store_id = ${STORE}`));
    const attempt = (items: { sku: string; quantity: number }[]) => withStore(STORE, tx => reserveStockOrThrow(tx, STORE, items, bySku));
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => attempt(i % 2
      ? [{ sku: 'SKU-A', quantity: 1 }, { sku: 'SKU-B', quantity: 1 }]
      : [{ sku: 'SKU-B', quantity: 1 }, { sku: 'SKU-A', quantity: 1 }])));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter(r => r.status === 'rejected').every(r => (r as PromiseRejectedResult).reason?.name !== 'DatabaseError'
      && !String((r as PromiseRejectedResult).reason).includes('deadlock'))).toBe(true);
    expect(await stock()).toEqual({ [A]: { onHand: 3, allocated: 3 }, [B]: { onHand: 3, allocated: 3 } });
  });

  it('admin bulk stock given [B, A] does not deadlock against a canonical writer', async () => {
    const [holder, writer] = await canonicalHolder(async () => {
      const res = await app.request('/v1/admin/variants/stock/bulk', {
        method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ id: B, onHand: 40 }, { id: A, onHand: 30 }] }),
      });
      return res.status;
    });
    expect(holder.status).toBe('fulfilled');
    expect(writer).toMatchObject({ status: 'fulfilled', value: 200 });
    expect(await stock()).toMatchObject({ [A]: { onHand: 30 }, [B]: { onHand: 40 } });
    // Movement delta is computed from the locked current row (holder's +1 on B committed first).
    const moves = await withStore(STORE, tx => tx.execute(sql`SELECT variant_id, delta FROM stock_movement WHERE store_id = ${STORE} AND reason = 'admin_bulk_adjust' ORDER BY variant_id`));
    expect(moves.rows).toEqual([{ variant_id: A, delta: 20 }, { variant_id: B, delta: 29 }]);
  });

  it('lockStockRowsInOrder locks only this store’s rows, ascending, and returns them', async () => {
    const rows = await withStore(STORE, (tx: Tx) => lockStockRowsInOrder(tx, STORE, [B, A, B]));
    expect(rows.map(r => r.variantId)).toEqual([A, B]);
  });
});
