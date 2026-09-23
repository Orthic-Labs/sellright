/**
 * DB test — zero-cache stock rule: a settled refund that restocks units must
 * trigger an immediate catalog-manifest regeneration (manifest/stock-hook.js),
 * fired AFTER the settlement transaction commits, never before. A refund that
 * never reaches 'Settled' (provider response lost/pending) must not trigger
 * one — nothing durable changed yet.
 *
 * Provider boundary is stubbed (no real gateway call), matching
 * payments/refund-reconcile.test.ts conventions. Self-skips outside a *_test
 * database instead of hard-throwing at module scope, so it's safe to collect
 * in the `unit` project too (mirrors refund-reconcile.test.ts).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefundResult } from './provider.js';

let stripeRefundImpl: () => Promise<RefundResult> = async () => ({ state: 'Pending', providerRef: null, errorMessage: 'lost' });
vi.mock('./provider.js', async (orig) => {
  const actual = await orig<typeof import('./provider.js')>();
  return {
    ...actual,
    getProvider: (method: string) => {
      if (method !== 'stripe') return actual.getProvider(method);
      return {
        method: 'stripe',
        requiresRedirect: false,
        async createPayment() { throw new Error('not used in this test'); },
        async refundPayment() { return stripeRefundImpl(); },
      };
    },
  };
});

const onStockChangedCalls: string[] = [];
vi.mock('../manifest/stock-hook.js', () => ({
  onStockChanged: (storeSlug: string) => { onStockChangedCalls.push(storeSlug); },
}));

import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { requestRefund } from './refunds.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
const isTestDb = /_test(\b|$|\?)/.test(DB);

const STORE = 'eeeeeeee-6666-6666-6666-666666666666';
const SLUG = 'refund-stock-hook-test';
const VARIANT = 'eeeeeeee-6666-6666-6666-66666666660b';

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

/** Paid order, one physical line (qty 1, fulfilled — restockable on refund),
 *  stock row at onHand=10/allocated=0, a Settled stripe payment. */
async function seedPaidOrder(code: string, grandTotal = 2000): Promise<{ orderId: string; lineId: string }> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status)
      VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type)
      VALUES (${VARIANT}, ${STORE}, ${pid}, 'SKU1', 'V1', 2000, 'physical') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated)
      VALUES (${VARIANT}, ${STORE}, 10, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 10, allocated = 0`);
  });
  const orderId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total, metadata)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, 'Paid'::order_state, 'USD', ${grandTotal},
        ${JSON.stringify({ contact: { email: 'buyer@example.test' } })}::jsonb)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  const lineId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${VARIANT}, 'SKU1', 'V1', 1, ${grandTotal}, ${grandTotal}, ${grandTotal}, 1)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO payment (id, store_id, order_id, amount, method, state, provider_ref, gateway_mode, currency)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${grandTotal}, 'stripe', 'Settled', ${'pi_' + code}, 'test', 'USD')`);
  });
  return { orderId, lineId };
}

describe.skipIf(!isTestDb)('requestRefund — zero-cache stock hook wiring', () => {
  beforeEach(async () => {
    await wipe();
    onStockChangedCalls.length = 0;
    stripeRefundImpl = async () => ({ state: 'Pending', providerRef: null, errorMessage: 'lost' });
  });
  afterAll(async () => { await wipe(); await pool.end(); });

  it('triggers the manifest hook once a restocking refund SETTLES, after the transaction commits', async () => {
    const { orderId, lineId } = await seedPaidOrder('SR-STOCKHOOK-1');
    stripeRefundImpl = async () => ({ state: 'Settled', providerRef: 're_stockhook_1' });

    await requestRefund({
      storeId: STORE, orderId, actor: 'test', idempotencyKey: 'stockhook-1', amount: 2000,
      lines: [{ orderLineId: lineId, quantity: 1, restock: true }],
    });

    expect(onStockChangedCalls).toEqual([SLUG]);
    const [row] = await withStore(STORE, (tx) => tx.execute(sql`SELECT on_hand, allocated FROM stock WHERE variant_id = ${VARIANT}`).then(r => r.rows as { on_hand: number; allocated: number }[]));
    expect(row).toMatchObject({ on_hand: 11, allocated: 0 }); // restocked +1
  });

  it('does not trigger the hook while the refund is still Pending — nothing durable changed yet', async () => {
    const { orderId, lineId } = await seedPaidOrder('SR-STOCKHOOK-2');
    stripeRefundImpl = async () => ({ state: 'Pending', providerRef: null, errorMessage: 'lost' });

    await requestRefund({
      storeId: STORE, orderId, actor: 'test', idempotencyKey: 'stockhook-2', amount: 2000,
      lines: [{ orderLineId: lineId, quantity: 1, restock: true }],
    });

    expect(onStockChangedCalls).toEqual([]);
  });
});
