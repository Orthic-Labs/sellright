/**
 * #381 Order Export page: status mapping (one display status per order), the open-orders default, the previous admin's
 * 23 XLSX columns in order with a frozen header, one row per order line or per order with an Items column, CSV, guest
 * contact (#374); and per-admin, per-store preferences (admin_preference, 0114). *_test database only.
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminOrderExport } from './admin-order-export.js';
import { adminPreferences } from './admin-preferences.js';
import { EXPORT_PAGE_COLUMNS } from '../orders/order-export-page.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-order-export.db.test.ts');

const STORE = 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcd0381';
const STORE2 = 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcd0382';
const ADMIN = 'cdcdcdcd-cdcd-4cdc-8cdc-00000000000a';
const ADMIN2 = 'cdcdcdcd-cdcd-4cdc-8cdc-00000000000b';
const app = new OpenAPIHono();
app.route('/', adminOrderExport);
app.route('/', adminPreferences);
let token = ''; let token2 = '';
const req = (path: string, init: RequestInit = {}, t = token, slug = 'export-store') =>
  app.request(path, { ...init, headers: { authorization: `Bearer ${t}`, 'x-store-slug': slug, 'content-type': 'application/json', ...(init.headers ?? {}) } });

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

type Seed = { state?: string; preOrder?: boolean; paid?: number; lines?: Array<{ sku: string; product: string; variant: string; qty: number; unit: number; fulfilled?: number }>; fulfillment?: 'Shipped' | 'Delivered'; contact?: string; created?: string };
async function order(code: string, o: Seed = {}) {
  await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, currency, subtotal, shipping_total, grand_total, is_pre_order, placed_at, created_at, metadata, shipping_address)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, ${o.state ?? 'Paid'}::order_state, 'USD', 5000, 700, 5700, ${o.preOrder ?? false}, now(), ${o.created ?? new Date().toISOString()}::timestamptz,
        ${JSON.stringify({ contact: { email: o.contact ?? `${code.toLowerCase()}@guest.test` } })}::jsonb,
        ${JSON.stringify({ fullName: 'Gus Guest', company: 'Acme', line1: '1 Main St', line2: 'Unit 2', city: 'Reno', province: 'NV', postalCode: '89501', country: 'US', phone: '+1 555 0100' })}::jsonb) RETURNING id`);
    const id = (r.rows[0] as { id: string }).id;
    for (const l of o.lines ?? [{ sku: 'SKU-A', product: 'Fenrir', variant: 'Jade G10', qty: 2, unit: 2500 }]) {
      await tx.execute(sql`INSERT INTO order_line (id, store_id, order_id, variant_sku, product_name, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
        VALUES (gen_random_uuid(), ${STORE}, ${id}, ${l.sku}, ${l.product}, ${l.variant}, ${l.qty}, ${l.unit}, ${l.qty * l.unit}, ${l.qty * l.unit}, ${l.fulfilled ?? (o.fulfillment ? l.qty : 0)})`);
    }
    // A paid order carries its settled payment (paid < grand total = an edit left a balance due).
    if (['Paid', 'PartiallyRefunded', 'Refunded'].includes(o.state ?? 'Paid')) {
      await tx.execute(sql`INSERT INTO payment (store_id, order_id, amount, method, state) VALUES (${STORE}, ${id}, ${o.paid ?? 5700}, 'nmi', 'Settled')`);
    }
    if (o.fulfillment) await tx.execute(sql`INSERT INTO fulfillment (store_id, order_id, state, tracking_code) VALUES (${STORE}, ${id}, ${o.fulfillment}::fulfillment_state, '1Z999AA10123456784')`);
  });
}

beforeEach(async () => {
  await wipe();
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency) VALUES (${STORE}, 'export-store', 'Export Store', 'USD')`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'a@export.test', 'x'), (${ADMIN2}, 'b@export.test', 'x')`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner'), (${ADMIN2}, ${STORE}, 'staff')`);
  });
  await withStore(STORE2, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency) VALUES (${STORE2}, 'export-store-2', 'Other', 'USD')`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE2}, 'owner')`);
  });
  token = await createAdminSession(ADMIN); token2 = await createAdminSession(ADMIN2);
});
afterEach(wipe);
afterAll(() => pool.end());

const statusOf = async (statuses: string) => {
  const res = await req(`/v1/admin/order-export?statuses=${statuses}&format=csv&rows=order&columns=orderCode,orderStatus`);
  return (await res.text()).trim().split('\r\n').slice(1).map((l) => l.split(',')).sort();
};

describe('order export page (#381)', () => {
  it('maps every order to one previous-admin status; the default count is open orders', async () => {
    await order('P-PROC');
    await order('P-PRE', { preOrder: true });
    await order('P-PART', { lines: [{ sku: 'S1', product: 'A', variant: 'x', qty: 2, unit: 100, fulfilled: 1 }] });
    await order('P-SHIP', { fulfillment: 'Shipped' });
    await order('P-DELIV', { fulfillment: 'Delivered' });
    await order('P-CANC', { state: 'Cancelled' });
    await order('P-REF', { state: 'Refunded' });
    await order('P-UNPAID', { state: 'PendingPayment' });
    await order('P-OWES', { paid: 4000 });
    expect(await statusOf('Processing,Pre-ordered,PartiallyShipped,Shipped,Delivered,Cancelled,Refunded,PaymentAuthorized,Modifying,PartiallyDelivered,ArrangingAdditionalPayment')).toEqual([
      ['P-CANC', 'Cancelled'], ['P-DELIV', 'Delivered'], ['P-OWES', 'More Payment Due'], ['P-PART', 'Partially Shipped'], ['P-PRE', 'Pre-ordered'],
      ['P-PROC', 'Processing'], ['P-REF', 'Refunded'], ['P-SHIP', 'Shipped'],
    ]);
    // No statuses param = the previous admin's default "Open orders" set (Processing, Pre-ordered, Part. Shipped, More Payment…).
    expect(await (await req('/v1/admin/order-export/count')).json()).toEqual({ totalOrders: 4 });
    expect(await (await req('/v1/admin/order-export/count?statuses=Shipped,Delivered')).json()).toEqual({ totalOrders: 2 });
    expect((await req('/v1/admin/order-export?statuses=')).status).toBe(400);
  });

  it("XLSX: the previous admin's 23 columns in order, frozen header, one row per line, guest contact, filename + counts", async () => {
    await order('X-1', { lines: [{ sku: 'PFBFENJAD', product: 'Fenrir', variant: 'Jade G10', qty: 2, unit: 2500 }, { sku: 'SHEATH', product: 'Sheath', variant: '', qty: 1, unit: 1500 }] });
    const res = await req('/v1/admin/order-export?statuses=Processing');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="orders_export_\d{4}-\d{2}-\d{2}\.xlsx"$/);
    expect([res.headers.get('x-export-orders'), res.headers.get('x-export-rows')]).toEqual(['1', '2']);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as never);
    const sh = wb.getWorksheet('Orders')!;
    expect((sh.getRow(1).values as unknown[]).slice(1)).toEqual([
      'Order Code', 'Status', 'Order Date', 'Email', 'Customer Name', 'Ship Name', 'Company', 'Street 1', 'Street 2', 'City', 'State', 'Post Code',
      'Country', 'Phone', 'Tracking Number', 'SKU', 'Product', 'Qty', 'Unit Price (USD)', 'Line Total (USD)', 'Shipping (USD)', 'Subtotal (USD)', 'Order Total (USD)',
    ]);
    expect(sh.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    const r2 = (sh.getRow(2).values as unknown[]).slice(1);
    expect(r2.slice(0, 2)).toEqual(['X-1', 'Processing']);
    expect(r2.slice(3, 14)).toEqual(['x-1@guest.test', 'Gus Guest', 'Gus Guest', 'Acme', '1 Main St', 'Unit 2', 'Reno', 'NV', '89501', 'US', "'+1 555 0100"]);
    expect(r2.slice(15)).toEqual(['PFBFENJAD', 'Fenrir - Jade G10', 2, 25, 50, 7, 50, 57]);
    const r3 = (sh.getRow(3).values as unknown[]);
    expect([r3[16], r3[17], r3[21], r3[23]]).toEqual(['SHEATH', 'Sheath', undefined, undefined]); // order totals on the first line only
    expect(EXPORT_PAGE_COLUMNS).toHaveLength(23);
  });

  it('one row per order keeps the line items as an Items column; CSV follows the chosen column order', async () => {
    await order('O-1', { lines: [{ sku: 'PFBFENJAD', product: 'Fenrir', variant: 'Jade G10', qty: 2, unit: 2500 }, { sku: 'SHEATH', product: 'Sheath', variant: '', qty: 1, unit: 1500 }] });
    const res = await req('/v1/admin/order-export?statuses=Processing&format=csv&rows=order&columns=orderTotalUsd,orderCode,sku,quantity,email');
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(await res.text()).toBe('Order Total (USD),Order Code,Items,Email\r\n57.00,O-1,2x Fenrir - Jade G10 (PFBFENJAD); 1x Sheath (SHEATH),o-1@guest.test\r\n');
  });

  it('preferences are per admin and per store', async () => {
    const put = (t: string, slug: string, value: unknown) => req('/v1/admin/preferences/order-export.last', { method: 'PUT', body: JSON.stringify({ value }) }, t, slug);
    const get = async (t: string, slug: string) => (await (await req('/v1/admin/preferences/order-export.last', {}, t, slug)).json()) as { value: unknown };
    expect((await get(token, 'export-store')).value).toBeNull();
    expect((await put(token, 'export-store', { statuses: ['Shipped'], rows: 'line' })).status).toBe(200);
    expect((await put(token, 'export-store', { statuses: ['Delivered'], rows: 'order' })).status).toBe(200);
    expect((await get(token, 'export-store')).value).toEqual({ statuses: ['Delivered'], rows: 'order' });
    expect((await get(token2, 'export-store')).value).toBeNull();
    expect((await get(token, 'export-store-2')).value).toBeNull();
    expect((await req('/v1/admin/preferences/Bad Key')).status).toBe(400);
    expect((await put(token, 'export-store', 'x'.repeat(70_000))).status).toBe(400);
  });
});
