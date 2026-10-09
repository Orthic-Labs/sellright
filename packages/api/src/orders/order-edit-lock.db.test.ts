// T-L2 (de-fork 3.4 step 2, lane C): an order-edit commit and a licence revoke on the
// same order serialize under withLockedSet. The commit plans and locks the order's
// licence rows (L2) before its order row (L3); the revoke takes its customer set in the
// same class order. Both must finish, with no 40P01 deadlock and no partial edit.
// DB-gated: *_test database only (TRUNCATEs store CASCADE).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { withLockedSet } from '../db/locks.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { calculateOrderTotals } from '../money/totals.js';
import { commitOrderEdit, previewOrderEdit } from './order-edit-service.js';
import type { EditOpT } from './order-edit.js';

const stockHook = vi.hoisted(() => ({ onStockChanged: vi.fn() }));
vi.mock('../manifest/stock-hook.js', () => stockHook);
vi.mock('../payments/stripe-reconcile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../payments/stripe-reconcile.js')>();
  return { ...actual, cancelOrderStripeIntents: async () => {} };
});

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
const isTestDb = /_test(\b|$|\?)/.test(DB);
const STORE = '7a7a7a7a-7a7a-7a7a-7a7a-7a7a7a7a0001';
const SLUG = 'lock-c-test';
const CUSTOMER = '7a7a7a7a-7a7a-7a7a-7a7a-7a7a7a7a0002';
const PRODUCT = '7a7a7a7a-7a7a-7a7a-7a7a-7a7a7a7a0003';
const VARIANT = '7a7a7a7a-7a7a-7a7a-7a7a-7a7a7a7a0004';
const ORDER = '7a7a7a7a-7a7a-7a7a-7a7a-7a7a7a7a0005';
const LINE = '7a7a7a7a-7a7a-7a7a-7a7a-7a7a7a7a0006';
const LIC = '7a7a7a7a-7a7a-7a7a-7a7a-7a7a7a7a0007';
const CODE = 'LC-1';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function wipe(): Promise<void> {
  await pool.query('TRUNCATE store CASCADE');
}

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, 'Lock C Test', 'USD', $3::jsonb)`,
    [STORE, SLUG, JSON.stringify({ payments: { stripe: true }, storefrontUrl: 'https://shop.example.test' })],
  );
  const t = calculateOrderTotals({ lines: [{ unitPrice: 1000, quantity: 2 }], shipping: 500, taxRate: 0, promotion: null });
  await withStore(STORE, async (tx) => {
    await tx.insert(s.shippingMethod).values({ storeId: STORE, code: 'std', name: 'Standard', calculator: { flat: 500 } });
    await tx.insert(s.product).values({ id: PRODUCT, storeId: STORE, slug: 'lock-c', name: 'Widget', status: 'active' });
    await tx.insert(s.productVariant).values({ id: VARIANT, storeId: STORE, productId: PRODUCT, sku: 'LC-A', name: 'Widget A', price: 1000 });
    await tx.insert(s.stock).values({ variantId: VARIANT, storeId: STORE, onHand: 20, allocated: 0 });
    await tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (${CUSTOMER}, ${STORE}, 'lock-c@x.test')`);
    await tx.insert(s.order).values({
      id: ORDER, storeId: STORE, code: CODE, state: 'Paid', currency: 'USD', customerId: CUSTOMER,
      subtotal: t.subtotal, discountTotal: t.discountTotal, shippingTotal: t.shippingTotal, taxTotal: t.taxTotal, grandTotal: t.grandTotal,
      shippingAddress: { fullName: 'Ship Er', line1: '1 Main St', city: 'Austin', province: 'TX', postalCode: '78701', country: 'US', phone: '555' },
      billingAddress: { fullName: 'Bill Er', line1: '2 Bill St', city: 'Austin', province: 'TX', postalCode: '78701', country: 'US' },
      metadata: {},
    });
    await tx.insert(s.orderLine).values({
      id: LINE, storeId: STORE, orderId: ORDER, variantId: VARIANT, variantSku: 'LC-A', variantName: 'Widget A', quantity: 2, unitPrice: 1000,
      lineSubtotal: t.lines[0]!.lineSubtotal, lineDiscount: t.lines[0]!.lineDiscount, lineTotal: t.lines[0]!.lineTotal,
    });
    await tx.insert(s.payment).values({ storeId: STORE, orderId: ORDER, amount: t.grandTotal, method: 'stripe', state: 'Settled', providerRef: 'pi_lock_c', gatewayMode: 'test', currency: 'USD' });
    await tx.execute(sql`INSERT INTO license (id, store_id, app_key, license_key, order_id, customer_id) VALUES (${LIC}, ${STORE}, 'app', 'lock-c-key', ${ORDER}, ${CUSTOMER})`);
  });
}

const licenseStatus = async () => withStore(STORE, async (tx) => {
  const [r] = await tx.select({ status: s.license.status }).from(s.license).where(eq(s.license.id, LIC));
  return r!.status;
});
const orderQty = async () => withStore(STORE, async (tx) => {
  const [r] = await tx.select({ quantity: s.orderLine.quantity }).from(s.orderLine).where(eq(s.orderLine.id, LINE));
  return r!.quantity;
});

const ops: EditOpT[] = [{ op: 'set_quantity', lineId: LINE, quantity: 3 }];

function commitEdit(idempotencyKey: string) {
  return previewOrderEdit(STORE, CODE, ops).then((prev) => commitOrderEdit({
    storeId: STORE, storeSlug: SLUG, code: CODE, actor: 'owner@example.test', ops, expectedGrandTotal: prev.after.grandTotal,
    idempotencyKey, notifyCustomer: false, settlement: { type: 'leave_due' },
  }));
}

function revokeLicence() {
  // Licence-first set, as the revoke paths plan it: L2 (licence) then L3 (order).
  return withLockedSet(STORE, { kind: 'customer', customerId: CUSTOMER, scope: 'all' }, async (tx) => {
    await tx.execute(sql`UPDATE license SET status = 'revoked', updated_at = now() WHERE id = ${LIC}`);
    await pause(300);
    await tx.execute(sql`UPDATE "order" SET updated_at = now() WHERE id = ${ORDER}`);
    return 'revoked';
  });
}

describe.skipIf(!isTestDb)('T-L2 order-edit commit vs licence revoke on one order', () => {
  beforeEach(async () => {
    await wipe();
    await seed();
    stockHook.onStockChanged.mockClear();
  });
  afterAll(wipe);

  it('revoke holds the licence first, commit waits for the set; both finish, edit applied once', async () => {
    const revoke = revokeLicence();
    await pause(50);
    const commit = commitEdit('lock-c-revoke-first');
    const [r, c] = await Promise.all([revoke, commit]);
    expect(r).toBe('revoked');
    expect(c.replay).toBe(false);
    expect(c.code).toBe(CODE);
    expect(await licenseStatus()).toBe('revoked');
    expect(await orderQty()).toBe(3);
  }, 20000);

  it('commit holds the order set first, revoke waits for it; both finish without deadlock', async () => {
    const commit = commitEdit('lock-c-commit-first');
    await pause(50);
    const revoke = revokeLicence();
    const [c, r] = await Promise.all([commit, revoke]);
    expect(r).toBe('revoked');
    expect(c.replay).toBe(false);
    expect(await licenseStatus()).toBe('revoked');
    expect(await orderQty()).toBe(3);
  }, 20000);
});
