/**
 * DB tests for the order export routes: CSV (existing) + XLSX (new, same
 * columns/rows, streamed via ExcelJS's WorkbookWriter). Route-level — drives
 * the real Hono handlers through app.request() with a seeded owner session.
 *
 * Runs against sellright_test ONLY (these wipe data). Mirrors the pattern in
 * admin-orders.bulk.test.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { admin } from './admin.js';
import { adminOrderOps, ORDER_EXPORT_COLUMNS } from './admin-order-ops.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `order-export test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`,
  );
}

const STORE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SLUG = 'export-test-store';
const ADMIN = 'dddddddd-dddd-dddd-dddd-00000000000a';
const VARIANT = 'dddddddd-dddd-dddd-dddd-00000000000b';

const app = new OpenAPIHono();
app.route('/', admin);
app.route('/', adminOrderOps);

let token = '';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seedStoreAdminAndOrder(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@export.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (gen_random_uuid(), ${STORE}, 'buyer@export.test') ON CONFLICT DO NOTHING`);
    const cust = await tx.execute(sql`SELECT id FROM customer WHERE store_id = ${STORE} AND email = 'buyer@export.test' LIMIT 1`);
    const customerId = (cust.rows[0] as { id: string }).id;
    await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, customer_id, subtotal, discount_total, shipping_total, tax_total, grand_total, placed_at)
      VALUES (gen_random_uuid(), ${STORE}, 'O-EXPORT-1', 'Paid'::order_state, 'USD', ${customerId}, 5000, 500, 1000, 350, 5850, now())
    `);
  });
  return createAdminSession(ADMIN);
}

beforeEach(async () => {
  await wipe();
  token = await seedStoreAdminAndOrder();
});
afterEach(wipe);
afterAll(() => pool.end());

describe('order export — CSV', () => {
  it('returns a header + one row matching the seeded order', async () => {
    const res = await app.request('/v1/admin/export/orders', {
      headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    const text = await res.text();
    const [header, ...rows] = text.trim().split('\n');
    expect(header).toBe(ORDER_EXPORT_COLUMNS.join(','));
    expect(rows).toHaveLength(1);
    const cells = rows[0]!.split(',');
    expect(cells[0]).toBe('O-EXPORT-1');
    expect(cells[2]).toBe('buyer@export.test');
    expect(cells[3]).toBe('Paid');
    expect(cells[7]).toBe('50.00'); // subtotal
    expect(cells[11]).toBe('58.50'); // total
    expect(cells[12]).toBe('USD');
  });
});

describe('order export — XLSX', () => {
  it('streams a real .xlsx workbook with the same columns/rows as the CSV', async () => {
    const res = await app.request('/v1/admin/export/orders.xlsx', {
      headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers.get('content-disposition')).toContain('orders-export-test-store.xlsx');

    const buf = Buffer.from(await res.arrayBuffer());
    const workbook = new ExcelJS.Workbook();
    // exceljs's .load() typing predates @types/node's generic Buffer<TArrayBuffer> —
    // a structural mismatch at the type level only; a real Buffer at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buf as any);
    const sheet = workbook.getWorksheet('Orders');
    expect(sheet).toBeDefined();

    const headerRow = sheet!.getRow(1).values as unknown[];
    // ExcelJS row.values is 1-indexed (index 0 is empty) — drop it.
    expect(headerRow.slice(1)).toEqual([...ORDER_EXPORT_COLUMNS]);

    const dataRow = sheet!.getRow(2).values as unknown[];
    const cells = dataRow.slice(1);
    expect(cells[0]).toBe('O-EXPORT-1');
    expect(cells[2]).toBe('buyer@export.test');
    expect(cells[3]).toBe('Paid');
    expect(cells[7]).toBeCloseTo(50, 2); // subtotal, numeric cell
    expect(cells[11]).toBeCloseTo(58.5, 2); // total
    expect(cells[12]).toBe('USD');
    expect(sheet!.rowCount).toBe(2); // header + 1 order, no stray rows
  });

  it('requires admin auth', async () => {
    const res = await app.request('/v1/admin/export/orders.xlsx', { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(401);
  });
});
