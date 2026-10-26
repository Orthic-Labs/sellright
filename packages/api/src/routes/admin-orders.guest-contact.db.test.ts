/**
 * #374: a guest order (no linked customer) shows its own checkout contact — metadata.contact.email and the
 * shipping (else billing) name/phone — in the admin order list, search, detail, export and dashboard; a linked
 * customer still wins. Route-level against a *_test database (wiped per case).
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { admin } from './admin.js';
import { adminOrderOps } from './admin-order-ops.js';
import { adminDashboard } from './admin-dashboard.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-orders.guest-contact.db.test.ts');

const STORE = 'cccccccc-cccc-cccc-cccc-cccccccccc74';
const SLUG = 'guest-contact-test-store';
const ADMIN = 'cccccccc-cccc-cccc-cccc-00000000000a';

const app = new OpenAPIHono();
app.route('/', admin);
app.route('/', adminOrderOps);
app.route('/', adminDashboard);

let token = '';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG})`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@guest.test', 'x')`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner')`);
    const cust = await tx.execute(sql`INSERT INTO customer (id, store_id, email, first_name, last_name, phone)
      VALUES (gen_random_uuid(), ${STORE}, 'member@guest.test', 'Mia', 'Member', '+1 555 0100') RETURNING id`);
    const customerId = (cust.rows[0] as { id: string }).id;
    const order = (code: string, state: string, minutesAgo: number, extra: { customerId?: string; metadata?: unknown; ship?: unknown; bill?: unknown }) => tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total, customer_id, metadata, shipping_address, billing_address, placed_at, created_at)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, ${state}::order_state, 'USD', 1000, ${extra.customerId ?? null},
        ${JSON.stringify(extra.metadata ?? {})}::jsonb, ${extra.ship ? JSON.stringify(extra.ship) : null}::jsonb, ${extra.bill ? JSON.stringify(extra.bill) : null}::jsonb,
        now() - make_interval(mins => ${minutesAgo}), now() - make_interval(mins => ${minutesAgo}))`);
    await order('G-GUEST', 'Paid', 1, { metadata: { contact: { email: 'guest@guest.test' } }, ship: { fullName: 'Gus Guest', phone: '+1 555 0199', line1: '1 St' } });
    await order('G-BILLONLY', 'Paid', 2, { metadata: { contact: { email: 'billy@guest.test' } }, bill: { fullName: 'Billy Bill', phone: '+1 555 0177' } });
    await order('G-MEMBER', 'Paid', 3, { customerId, metadata: { contact: { email: 'other@guest.test' } }, ship: { fullName: 'Shipped To Someone' } });
    await order('G-UNPAID', 'PendingPayment', 4, { metadata: { contact: { email: 'unpaid@guest.test' } } });
    await order('G-CANCELLED', 'Cancelled', 5, { metadata: { contact: { email: 'cancelled@guest.test' } } });
  });
  return createAdminSession(ADMIN);
}

const get = async (path: string) => {
  const res = await app.request(path, { headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG } });
  expect(res.status).toBe(200);
  return res;
};
type Row = { code: string; email: string | null; customerName: string | null };
const list = async (query = '') => ((await (await get(`/v1/admin/orders?${query}`)).json()) as { items: Row[] }).items;

beforeEach(async () => { await wipe(); token = await seed(); });
afterEach(wipe);
afterAll(() => pool.end());

describe('guest order contact (#374)', () => {
  it('list: a guest order shows its own email and name; a linked customer wins', async () => {
    const rows = Object.fromEntries((await list()).map((r) => [r.code, { email: r.email, customerName: r.customerName }]));
    expect(rows['G-GUEST']).toEqual({ email: 'guest@guest.test', customerName: 'Gus Guest' });
    expect(rows['G-BILLONLY']).toEqual({ email: 'billy@guest.test', customerName: 'Billy Bill' });
    expect(rows['G-MEMBER']).toEqual({ email: 'member@guest.test', customerName: 'Mia Member' });
  });

  it('search finds a guest order by its own email, name and phone', async () => {
    expect((await list('q=guest%40guest')).map((r) => r.code)).toEqual(['G-GUEST']);
    expect((await list('q=gus+gue')).map((r) => r.code)).toEqual(['G-GUEST']);
    expect((await list('q=0177')).map((r) => r.code)).toEqual(['G-BILLONLY']);
    expect((await list('q=member%40')).map((r) => r.code)).toEqual(['G-MEMBER']);
    expect((await list('q=G-UNP')).map((r) => r.code)).toEqual(['G-UNPAID']);
  });

  it('the paid-orders view (status=completed) leaves out unpaid and cancelled orders; open is the unpaid tab', async () => {
    expect((await list('status=completed')).map((r) => r.code)).toEqual(['G-GUEST', 'G-BILLONLY', 'G-MEMBER']);
    expect((await list('status=open')).map((r) => r.code)).toEqual(['G-UNPAID']);
    expect((await list('status=cancelled')).map((r) => r.code)).toEqual(['G-CANCELLED']);
  });

  it('detail carries the order contact next to the (absent) customer', async () => {
    const guest = await (await get('/v1/admin/orders/G-GUEST')).json() as { customer: unknown; contact: unknown };
    expect(guest.customer).toBeNull();
    expect(guest.contact).toEqual({ name: 'Gus Guest', email: 'guest@guest.test', phone: '+1 555 0199' });
    const bill = await (await get('/v1/admin/orders/G-BILLONLY')).json() as { contact: unknown };
    expect(bill.contact).toEqual({ name: 'Billy Bill', email: 'billy@guest.test', phone: '+1 555 0177' });
  });

  it('export falls back to the order contact (email, name, phone)', async () => {
    const text = await (await get('/v1/admin/export/orders?columns=code,email,customerName,customerPhone')).text();
    const rows = Object.fromEntries(text.trim().split('\n').slice(1).map((l) => { const [code, ...rest] = l.split(','); return [code, rest]; }));
    // A leading + is quoted by the export's formula-injection guard (guardCell), like every free-text cell.
    expect(rows['G-GUEST']).toEqual(['guest@guest.test', 'Gus Guest', "'+1 555 0199"]);
    expect(rows['G-MEMBER']).toEqual(['member@guest.test', 'Mia Member', "'+1 555 0100"]);
    const search = await (await get('/v1/admin/export/orders?columns=code&q=billy')).text();
    expect(search.trim().split('\n').slice(1)).toEqual(['G-BILLONLY']);
  });

  it('dashboard recent orders show the guest email', async () => {
    const body = await (await get('/v1/admin/dashboard')).json() as { recentOrders: { code: string; email: string | null }[] };
    expect(body.recentOrders.find((o) => o.code === 'G-GUEST')?.email).toBe('guest@guest.test');
  });
});
