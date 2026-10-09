// T-L2 (refund side): a refund that cascades into licence revocation and a licence revoke cascade
// on the SAME order run concurrently. Both take the order lock set (L2 licences → L3 order), so they
// serialize and never deadlock (40P01). DB-gated: *_test only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefundResult } from './provider.js';

let stripeRefundImpl: () => Promise<RefundResult> = async () => ({ state: 'Settled', providerRef: 're_default' });

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

import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { withLockedSet } from '../db/locks.js';
import { env } from '../env.js';
import { requestRefund } from './refunds.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
const isTestDb = /_test(\b|$|\?)/.test(DB);
const STORE = 'cccccccc-1212-1212-1212-121212121212';
const SLUG = 'refund-cascade-test';
const VARIANT = 'cccccccc-1212-1212-1212-12121212120b';

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

async function seedPaidOrder(code: string, grandTotal = 2000): Promise<{ orderId: string; lineId: string }> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO webhook_endpoint (id, store_id, url, topics, secret)
      VALUES (gen_random_uuid(), ${STORE}, 'https://example.test/hook', ARRAY['*'], 'whsec_test') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status)
      VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, app_key)
      VALUES (${VARIANT}, ${STORE}, ${pid}, 'SKU1', 'V1', 2000, 'app') ON CONFLICT (id) DO NOTHING`);
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

async function seedLicenses(orderId: string, lineId: string, n: number): Promise<string[]> {
  return withStore(STORE, async (tx) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await tx.execute(sql`INSERT INTO license(store_id,order_id,order_line_id,app_key,license_key)
        VALUES (${STORE},${orderId},${lineId},'app',${'cascade-' + orderId + '-' + i}) RETURNING id`);
      const id = (r.rows[0] as { id: string }).id;
      await tx.execute(sql`INSERT INTO license_activation(store_id,license_id,app_key,device_id_hash,generation)
        VALUES (${STORE},${id},'app','device',4)`);
      ids.push(id);
    }
    return ids;
  });
}

/** The licence revoke cascade, under the same order lock set the refund finalizer uses. */
function revokeLicenceCascade(orderId: string) {
  return withLockedSet(STORE, { kind: 'order', orderId }, async (tx) => {
    await tx.execute(sql`UPDATE license SET status = 'revoked', updated_at = now()
      WHERE store_id = ${STORE} AND order_id = ${orderId} AND status <> 'revoked'`);
    await tx.execute(sql`UPDATE license_activation SET state = 'revoked', revoked_at = now(), generation = generation + 1
      WHERE store_id = ${STORE} AND state = 'active'
        AND license_id IN (SELECT id FROM license WHERE order_id = ${orderId})`);
    return 'revoked';
  });
}

async function licenseStatuses(orderId: string): Promise<string[]> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT status FROM license WHERE order_id = ${orderId}`);
    return (r.rows as Array<{ status: string }>).map((x) => x.status);
  });
}

describe.skipIf(!isTestDb)('T-L2 refund vs licence revoke cascade on the same order', () => {
  beforeEach(async () => {
    await wipe();
    stripeRefundImpl = async () => ({ state: 'Settled', providerRef: 're_default' });
  });
  afterAll(async () => { await wipe(); await pool.end(); });

  it('a full refund and a licence revoke cascade on one order both complete, with no deadlock', async () => {
    const { orderId, lineId } = await seedPaidOrder('CASCADE-1');
    await seedLicenses(orderId, lineId, 2);
    // Slow provider call so the two paths genuinely overlap on the lock set.
    stripeRefundImpl = async () => { await new Promise((r) => setTimeout(r, 150)); return { state: 'Settled', providerRef: 're_cascade' }; };

    const settled = await Promise.allSettled([
      requestRefund({ storeId: STORE, orderId, actor: 'test', idempotencyKey: 'cascade-refund' }),
      revokeLicenceCascade(orderId),
    ]);

    for (const r of settled) {
      if (r.status === 'rejected') {
        expect(String((r.reason as { cause?: { code?: string } })?.cause?.code ?? '')).not.toBe('40P01');
        expect(String((r.reason as Error)?.message ?? '')).not.toMatch(/deadlock/i);
      }
    }
    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((settled[0] as PromiseFulfilledResult<{ refundState: string }>).value.refundState).toBe('Settled');
    expect(await licenseStatuses(orderId)).toEqual(['revoked', 'revoked']);
  }, 30000);
});
