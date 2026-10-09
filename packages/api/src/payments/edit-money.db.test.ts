/**
 * Order-edit money correctness (DB): duplicate captures are not tender, edit
 * refunds don't count as merchandise refunds in dashboard reconciliation, and
 * paid-order edits reconcile license entitlements. *_test DB only (TRUNCATE).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';

vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: vi.fn() }));

import { amountDueForOrder, applyPaymentResult } from './settle.js';
import { reconcileStripeRefund } from './webhook-reconcile.js';
import { loadOrderStatusFacts } from '../routes/order-facts.js';
import { licensedLineEditViolations } from '../licensing/edit-reconcile.js';
import { previewOrderEdit } from '../orders/order-edit-service.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) throw new Error(`edit-money test truncates data — use a *_test DB, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);

const STORE = 'e2000000-0000-0000-0000-0000000e2001';
const wipe = () => pool.query('TRUNCATE store CASCADE');
beforeEach(async () => {
  await wipe();
  await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, 'em', 'em', 'USD', '{}'::jsonb)`));
});
afterAll(async () => { await wipe(); await pool.end(); });

const q = async <T = Record<string, unknown>>(f: (tx: Parameters<Parameters<typeof withStore>[1]>[0]) => Promise<{ rows: unknown[] }>) =>
  (await withStore(STORE, f)).rows as T[];

async function seedOrder(code: string, state: string, grandTotal: number) {
  const [o] = await q<{ id: string }>((tx) => tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, currency, grand_total, subtotal)
    VALUES (gen_random_uuid(), ${STORE}, ${code}, ${state}::order_state, 'USD', ${grandTotal}, ${grandTotal}) RETURNING id`));
  return o!.id;
}
async function seedPayment(orderId: string, amount: number, ref: string, metadata: object | null = null) {
  const [p] = await q<{ id: string }>((tx) => tx.execute(sql`INSERT INTO payment (id, store_id, order_id, amount, method, state, provider_ref, gateway_mode, currency, metadata)
    VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${amount}, 'stripe', 'Settled', ${ref}, 'test', 'USD', ${metadata ? JSON.stringify(metadata) : null}::jsonb) RETURNING id`));
  return p!.id;
}
async function seedRefund(orderId: string, paymentId: string, amount: number, ref: string, metadata: object | null) {
  await q((tx) => tx.execute(sql`INSERT INTO refund (id, store_id, payment_id, order_id, amount, state, provider_ref, metadata)
    VALUES (gen_random_uuid(), ${STORE}, ${paymentId}, ${orderId}, ${amount}, 'Settled', ${ref}, ${metadata ? JSON.stringify(metadata) : null}::jsonb)`));
}
const orderState = async (id: string) => (await q<{ state: string }>((tx) => tx.execute(sql`SELECT state FROM "order" WHERE id = ${id}`)))[0]!.state;

describe('duplicate captures are not tender', () => {
  it('duplicate capture -> duplicate refunded -> order increased: amountDue is positive', async () => {
    const id = await seedOrder('DUP1', 'Paid', 10000);
    await seedPayment(id, 10000, 'pi_orig');
    const dup = await seedPayment(id, 10000, 'pi_dup', { duplicate: true });
    await seedRefund(id, dup, 10000, 're_dup', null);
    await q((tx) => tx.execute(sql`UPDATE "order" SET grand_total = 15000 WHERE id = ${id}`));
    expect(await withStore(STORE, (tx) => amountDueForOrder(tx, STORE, id, 15000))).toBe(5000);
    const facts = await withStore(STORE, async (tx) => loadOrderStatusFacts(tx, { id, state: 'Paid', status: 'open' }));
    expect(facts.paymentStatus).toBe('balance_due');
  });
});

describe('dashboard refund after an order-edit refund', () => {
  it('$100 order reduced to $40 with $60 edit refund then $1 dashboard refund stays PartiallyRefunded', async () => {
    const id = await seedOrder('EDR1', 'Paid', 4000);
    const pay = await seedPayment(id, 10000, 'pi_EDR1');
    await seedRefund(id, pay, 6000, 're_edit', { source: 'order_edit' });
    await withStore(STORE, (tx) => reconcileStripeRefund(tx, STORE, { reId: 're_dash', amount: 100, status: 'succeeded', piId: 'pi_EDR1' }, { mode: 'test' }));
    expect(await orderState(id)).toBe('PartiallyRefunded');
  });
  it('dashboard refunds covering the NET captured amount do mark it Refunded', async () => {
    const id = await seedOrder('EDR2', 'Paid', 4000);
    const pay = await seedPayment(id, 10000, 'pi_EDR2');
    await seedRefund(id, pay, 6000, 're_edit2', { source: 'order_edit' });
    await withStore(STORE, (tx) => reconcileStripeRefund(tx, STORE, { reId: 're_dash2', amount: 4000, status: 'succeeded', piId: 'pi_EDR2' }, { mode: 'test' }));
    expect(await orderState(id)).toBe('Refunded');
  });
});

describe('license entitlements on edited paid orders', () => {
  async function seedLicensed(orderId: string, qty: number, price = 1000) {
    const [p] = await q<{ id: string }>((tx) => tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, ${'p' + orderId}, 'P', 'active') RETURNING id`));
    const [v] = await q<{ id: string }>((tx) => tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, app_key, fulfillment_type)
      VALUES (gen_random_uuid(), ${STORE}, ${p!.id}, ${'L' + orderId}, 'Lic', ${price}, 'app', 'license') RETURNING id`));
    const [l] = await q<{ id: string }>((tx) => tx.execute(sql`INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${v!.id}, 'L', 'Lic', ${qty}, ${price}, ${price * qty}, ${price * qty}) RETURNING id`));
    return { variantId: v!.id, lineId: l!.id };
  }
  const licenseCount = async (orderId: string, status?: string) =>
    Number((await q<{ n: string }>((tx) => tx.execute(sql`SELECT count(*) n FROM license WHERE order_id = ${orderId} AND (${status ?? null}::text IS NULL OR status::text = ${status ?? null})`)))[0]!.n);

  it('adding a licensed line then settling the balance issues its license once', async () => {
    const id = await seedOrder('LIC1', 'Paid', 2000);
    await seedPayment(id, 1000, 'pi_LIC1a');
    await seedLicensed(id, 1);
    expect(await licenseCount(id)).toBe(0);
    for (let i = 0; i < 2; i++) { // replay-safe
      await withStore(STORE, (tx) => applyPaymentResult(tx, { storeId: STORE, method: 'stripe',
        order: { id, state: 'Paid', grandTotal: 2000, currency: 'USD' },
        result: { state: 'Settled', providerRef: 'pi_LIC1b', metadata: {} }, amount: 1000 }));
    }
    expect(await licenseCount(id)).toBe(1);
  });

  it('removing or repointing a line with an issued license is flagged; zero-quantity entitlements are revoked at settlement', async () => {
    const id = await seedOrder('LIC2', 'Paid', 1000);
    await seedPayment(id, 1000, 'pi_LIC2');
    const { lineId, variantId } = await seedLicensed(id, 1);
    await q((tx) => tx.execute(sql`INSERT INTO license (id, store_id, order_id, order_line_id, app_key, license_key, status, source)
      VALUES (gen_random_uuid(), ${STORE}, ${id}, ${lineId}, 'app', 'SR-APP-X', 'active', 'order')`));
    const bad = (quantity: number, v: string | null) => withStore(STORE, (tx) => licensedLineEditViolations(tx, STORE, id, [{ id: lineId, variantId: v, quantity }]));
    expect(await bad(1, variantId)).toEqual([]);
    expect(await bad(0, variantId)).toEqual([lineId]);
    expect(await bad(1, null)).toEqual([lineId]);
    expect(await withStore(STORE, (tx) => licensedLineEditViolations(tx, STORE, id, []))).toEqual([lineId]);
  });
  it('the edit planner refuses to remove a line that carries an issued license (LINE_LICENSED)', async () => {
    const id = await seedOrder('LIC3', 'Paid', 1000);
    await seedPayment(id, 1000, 'pi_LIC3');
    const { lineId } = await seedLicensed(id, 1);
    await q((tx) => tx.execute(sql`INSERT INTO license (id, store_id, order_id, order_line_id, app_key, license_key, status, source)
      VALUES (gen_random_uuid(), ${STORE}, ${id}, ${lineId}, 'app', 'SR-APP-Y', 'active', 'order')`));
    await expect(previewOrderEdit(STORE, 'LIC3', [{ op: 'remove_line', lineId }])).rejects.toMatchObject({ code: 'LINE_LICENSED' });
    await expect(previewOrderEdit(STORE, 'LIC3', [{ op: 'set_quantity', lineId, quantity: 1 }])).resolves.toBeTruthy();
  });
});

describe('deferred edit earn posts when the balance settles', () => {
  it('posts points only once the balance payment clears the amount due', async () => {
    const [c] = await q<{ id: string }>((tx) => tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (gen_random_uuid(), ${STORE}, 'c@example.test') RETURNING id`));
    const id = await seedOrder('LOY1', 'Paid', 2000);
    await q((tx) => tx.execute(sql`UPDATE "order" SET customer_id = ${c!.id},
      metadata = ${JSON.stringify({ loyalty: { earnPoints: 10, deferredEarn: { editId: 'e1', targetEarn: 20 } } })}::jsonb WHERE id = ${id}`));
    await seedPayment(id, 1000, 'pi_LOY1a');
    await q((tx) => tx.execute(sql`INSERT INTO loyalty_ledger (id, store_id, customer_id, order_id, kind, points, actor)
      VALUES (gen_random_uuid(), ${STORE}, ${c!.id}, ${id}, 'earn', 10, 'test')`));
    const pts = async () => Number((await q<{ n: string }>((tx) => tx.execute(sql`SELECT coalesce(sum(points),0) n FROM loyalty_ledger WHERE order_id = ${id}`)))[0]!.n);
    await withStore(STORE, (tx) => applyPaymentResult(tx, { storeId: STORE, method: 'stripe',
      order: { id, state: 'Paid', grandTotal: 2000, currency: 'USD' },
      result: { state: 'Settled', providerRef: 'pi_LOY1b', metadata: {} }, amount: 500 }));
    expect(await pts()).toBe(10); // still owes 500
    await withStore(STORE, (tx) => applyPaymentResult(tx, { storeId: STORE, method: 'stripe',
      order: { id, state: 'Paid', grandTotal: 2000, currency: 'USD' },
      result: { state: 'Settled', providerRef: 'pi_LOY1c', metadata: {} }, amount: 500 }));
    expect(await pts()).toBe(20);
  });
});
