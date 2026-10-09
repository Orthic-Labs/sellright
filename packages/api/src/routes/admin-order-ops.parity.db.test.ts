/**
 * Owner-parity admin ops (Damned cutover): export filters + line-item rows +
 * column picker, tracking import preview/commit/history, open-orders grid feed,
 * auto-deliver run-now, shipping method PATCH. Real Hono handlers over a
 * *_test database ONLY (wipes data).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminOrderOps } from './admin-order-ops.js';
import { adminSettings } from './admin-settings.js';
import { admin as adminRoutes } from './admin.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`parity test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SLUG = 'parity-test-store';
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000a';
const VAR_A = 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000b';
const VAR_B = 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000c';
const CUST = 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000d';

const app = new OpenAPIHono();
app.route('/', adminOrderOps);
app.route('/', adminSettings);
app.route('/', adminRoutes);

let token = '';
const hdr = () => ({ authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' });
const get = (path: string) => app.request(path, { headers: hdr() });
const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: hdr(), body: JSON.stringify(body) });

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seedOrder(o: { code: string; state?: string; placedAt?: string; total?: number; country?: string; preOrder?: boolean; method?: string; promoId?: string; lines?: Array<{ variant: string; sku: string; name: string; qty: number; unit: number; fulfilled?: number }> }) {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, customer_id, code, state, currency, subtotal, grand_total, is_pre_order, placed_at, shipping_address, promotion_id)
      VALUES (gen_random_uuid(), ${STORE}, ${CUST}, ${o.code}, ${o.state ?? 'Paid'}::order_state, 'USD', ${o.total ?? 5000}, ${o.total ?? 5000}, ${o.preOrder ?? false},
        ${o.placedAt ?? new Date().toISOString()}::timestamptz, ${JSON.stringify({ fullName: 'Ship Name', line1: '1 Main St', city: 'Reno', province: 'NV', postalCode: '89501', country: o.country ?? 'US' })}::jsonb, ${o.promoId ?? null})
      RETURNING id`);
    const id = (r.rows[0] as { id: string }).id;
    for (const l of o.lines ?? []) {
      await tx.execute(sql`INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
        VALUES (gen_random_uuid(), ${STORE}, ${id}, ${l.variant}, ${l.sku}, ${l.name}, ${l.qty}, ${l.unit}, ${l.qty * l.unit}, ${l.qty * l.unit}, ${l.fulfilled ?? 0})`);
    }
    if ((o.state ?? 'Paid') !== 'PendingPayment') {
      await tx.execute(sql`INSERT INTO payment (id, store_id, order_id, amount, method, state) VALUES (gen_random_uuid(), ${STORE}, ${id}, ${o.total ?? 5000}, ${o.method ?? 'nmi'}, 'Settled'::payment_state)`);
    }
    return id;
  });
}

const A = { variant: VAR_A, sku: 'SKU-A', name: 'Knife A', qty: 2, unit: 2500 };
const B = { variant: VAR_B, sku: 'SKU-B', name: 'Sheath B', qty: 1, unit: 1500 };

beforeEach(async () => {
  await wipe();
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD')`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@parity.test', 'x')`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner')`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, first_name, last_name) VALUES (${CUST}, ${STORE}, 'buyer@parity.test', 'Ada', 'Buyer')`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-0000000000f1', ${STORE}, 'p', 'P', 'active')`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VAR_A}, ${STORE}, 'aaaaaaaa-aaaa-4aaa-8aaa-0000000000f1', 'SKU-A', 'Knife A', 2500)`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VAR_B}, ${STORE}, 'aaaaaaaa-aaaa-4aaa-8aaa-0000000000f1', 'SKU-B', 'Sheath B', 1500)`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VAR_A}, ${STORE}, 10, 4)`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VAR_B}, ${STORE}, 10, 2)`);
  });
  token = await createAdminSession(ADMIN);
});
afterEach(wipe);
afterAll(() => pool.end());

describe('export filters, line rows, column picker', () => {
  beforeEach(async () => {
    const promo = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`INSERT INTO promotion (id, store_id, code, type, value) VALUES (gen_random_uuid(), ${STORE}, 'SAVE10', 'percentage'::promotion_type, 1000) RETURNING id`);
      return (r.rows[0] as { id: string }).id;
    });
    await seedOrder({ code: 'EX-1', placedAt: '2026-09-10T12:00:00Z', country: 'US', lines: [A, B] });
    await seedOrder({ code: 'EX-2', placedAt: '2026-09-20T12:00:00Z', country: 'CA', method: 'sezzle', promoId: promo, preOrder: true, lines: [A] });
    await seedOrder({ code: 'EX-3', placedAt: '2026-09-25T12:00:00Z', state: 'PendingPayment', lines: [B] });
  });

  const csv = async (qs: string) => {
    const res = await get(`/v1/admin/export/orders?${qs}`);
    expect(res.status).toBe(200);
    const [header, ...rows] = (await res.text()).trim().split('\n');
    return { header: header!.split(','), rows: rows.map((r) => r.split(',')) };
  };

  it('filters by custom date range (inclusive to-date)', async () => {
    const r = await csv('from=2026-09-15&to=2026-09-20');
    expect(r.rows.map((x) => x[0])).toEqual(['EX-2']);
  });
  it('filters by paymentStatus / fulfillmentStatus', async () => {
    expect((await csv('from=2026-09-01&to=2026-09-30&paymentStatus=pending')).rows.map((x) => x[0])).toEqual(['EX-3']);
    expect((await csv('from=2026-09-01&to=2026-09-30&paymentStatus=paid&fulfillmentStatus=unfulfilled')).rows.map((x) => x[0]).sort()).toEqual(['EX-1', 'EX-2']);
    expect((await csv('from=2026-09-01&to=2026-09-30&fulfillmentStatus=delivered')).rows).toHaveLength(0);
  });
  it('filters by pre-order, payment method, country and coupon', async () => {
    const base = 'from=2026-09-01&to=2026-09-30';
    expect((await csv(`${base}&preOrder=1`)).rows.map((x) => x[0])).toEqual(['EX-2']);
    expect((await csv(`${base}&paymentMethod=sezzle`)).rows.map((x) => x[0])).toEqual(['EX-2']);
    expect((await csv(`${base}&country=ca`)).rows.map((x) => x[0])).toEqual(['EX-2']);
    expect((await csv(`${base}&coupon=save10`)).rows.map((x) => x[0])).toEqual(['EX-2']);
  });
  it('emits one row per line item with the picked columns in order', async () => {
    const r = await csv('from=2026-09-01&to=2026-09-30&paymentStatus=paid&rows=line&columns=code,sku,quantity,lineTotal,paymentMethod,coupon,country');
    expect(r.header).toEqual(['code', 'sku', 'quantity', 'lineTotal', 'paymentMethod', 'coupon', 'country']);
    expect(r.rows).toHaveLength(3); // EX-1 has 2 lines, EX-2 has 1
    const ex1a = r.rows.find((x) => x[0] === 'EX-1' && x[1] === 'SKU-A')!;
    expect(ex1a.slice(2)).toEqual(['2', '50.00', 'nmi', '', 'US']);
    expect(r.rows.find((x) => x[0] === 'EX-2')![5]).toBe('SAVE10');
  });
  it('appends default line columns when rows=line has none picked, and drops them for per-order rows', async () => {
    expect((await csv('from=2026-09-01&to=2026-09-30&rows=line&columns=code')).header).toEqual(['code', 'sku', 'item', 'quantity', 'unitPrice', 'lineTotal']);
    expect((await csv('from=2026-09-01&to=2026-09-30&columns=code,sku')).header).toEqual(['code']);
  });
  it('ignores unknown columns and falls back to the default set', async () => {
    expect((await csv('from=2026-09-01&to=2026-09-30&columns=nope')).header[0]).toBe('code');
    expect((await csv('from=2026-09-01&to=2026-09-30&columns=nope')).header).toHaveLength(13);
  });
  it('serves the column catalog', async () => {
    const res = await get('/v1/admin/export/orders/columns');
    const b = (await res.json()) as { columns: Array<{ key: string }>; cap: number };
    expect(b.cap).toBe(50000);
    expect(b.columns.map((c) => c.key)).toContain('lineTotal');
  });
});

describe('tracking import: preview, commit, history', () => {
  it('previews per-row verdicts with items, did-you-mean and carrier detection, writing nothing', async () => {
    await seedOrder({ code: 'DD30284', lines: [A, B] });
    const res = await post('/v1/admin/import-tracking/preview', { csv: 'order,tracking\nDD30284,1Z999AA10123456784\nDD30285,9400111899223817200000\nDD30284,\n,T1' });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { rows: Array<{ status: string; carrier: string | null; suggestion?: string; items: Array<{ sku: string; quantity: number }> }>; summary: { importable: number } };
    expect(b.rows.map((r) => r.status)).toEqual(['ready', 'unknown_order', 'missing_tracking', 'missing_code']);
    expect(b.rows[0]!.carrier).toBe('UPS');
    expect(b.rows[0]!.items).toEqual([{ sku: 'SKU-A', name: 'Knife A', quantity: 2 }, { sku: 'SKU-B', name: 'Sheath B', quantity: 1 }]);
    expect(b.rows[1]!.suggestion).toBe('DD30284');
    expect(b.summary.importable).toBe(1);
    const n = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM fulfillment`)).rows[0] as { n: number });
    expect(n.n).toBe(0);
  });

  it('imports only ready rows, ships remaining lines with fulfillment lines, moves stock, queues email, records history', async () => {
    await seedOrder({ code: 'IMP-1', lines: [A, B] });
    await seedOrder({ code: 'IMP-2', state: 'PendingPayment', lines: [B] });
    const res = await post('/v1/admin/import-tracking', { rows: [{ code: 'imp-1', tracking: '1Z999AA10123456784' }, { code: 'IMP-2', tracking: 'T2' }, { code: 'NOPE', tracking: 'T3' }], source: 'csv', fileName: 'ship.csv' });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { updated: number; skipped: number; emailsQueued: number; errors: Array<{ code: string; error: string }> };
    expect(b.updated).toBe(1);
    expect(b.skipped).toBe(2);
    expect(b.emailsQueued).toBe(1);
    expect(b.errors.map((e) => e.code).sort()).toEqual(['IMP-2', 'NOPE']);

    const db = await withStore(STORE, async (tx) => {
      const f = (await tx.execute(sql`SELECT f.state, f.tracking_code, f.carrier, (select sum(quantity)::int from fulfillment_line fl where fl.fulfillment_id = f.id) AS qty FROM fulfillment f`)).rows as Array<{ state: string; tracking_code: string; carrier: string; qty: number }>;
      const stock = (await tx.execute(sql`SELECT variant_id, on_hand, allocated FROM stock ORDER BY variant_id`)).rows as Array<{ on_hand: number; allocated: number }>;
      const lines = (await tx.execute(sql`SELECT fulfilled_qty FROM order_line ol JOIN "order" o ON o.id = ol.order_id WHERE o.code = 'IMP-1' ORDER BY variant_sku`)).rows as Array<{ fulfilled_qty: number }>;
      const outbox = (await tx.execute(sql`SELECT count(*)::int AS n FROM email_outbox WHERE recipient = 'buyer@parity.test'`)).rows[0] as { n: number };
      return { f, stock, lines, outbox };
    });
    expect(db.f).toEqual([{ state: 'Shipped', tracking_code: '1Z999AA10123456784', carrier: 'UPS', qty: 3 }]);
    expect(db.stock.map((s) => [s.on_hand, s.allocated])).toEqual([[8, 2], [9, 1]]);
    expect(db.lines.map((l) => l.fulfilled_qty)).toEqual([2, 1]);
    expect(db.outbox.n).toBe(1);

    const recent = (await (await get('/v1/admin/import-tracking/recent')).json()) as { items: Array<{ shipped: number; skipped: number; fileName: string; source: string }> };
    expect(recent.items[0]).toMatchObject({ shipped: 1, skipped: 2, fileName: 'ship.csv', source: 'csv' });
  });

  it('skips a row whose tracking number is already on the order and honours notify=false', async () => {
    await seedOrder({ code: 'IMP-3', lines: [A] });
    const first = await post('/v1/admin/import-tracking', { rows: [{ code: 'IMP-3', tracking: 'ABC-1', carrier: 'DHL' }], notify: false });
    const f = (await first.json()) as { updated: number; emailsQueued: number };
    expect(f).toMatchObject({ updated: 1, emailsQueued: 0 });
    const again = await post('/v1/admin/import-tracking/preview', { rows: [{ code: 'IMP-3', tracking: 'abc-1' }] });
    expect(((await again.json()) as { rows: Array<{ status: string }> }).rows[0]!.status).toBe('already_shipped');
  });

  it('ships only the remaining quantity on a partially fulfilled order as a NEW fulfillment', async () => {
    await seedOrder({ code: 'IMP-4', lines: [{ ...A, qty: 3, fulfilled: 1 }] });
    const res = await post('/v1/admin/import-tracking', { rows: [{ code: 'IMP-4', tracking: 'PKG-2' }], notify: false });
    expect(((await res.json()) as { updated: number }).updated).toBe(1);
    const stock = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT on_hand FROM stock WHERE variant_id = ${VAR_A}`)).rows[0] as { on_hand: number });
    expect(stock.on_hand).toBe(8); // 2 remaining units, not 3
  });

  it('marks a duplicate order row inside one file as duplicate_in_file', async () => {
    await seedOrder({ code: 'IMP-5', lines: [A] });
    const res = await post('/v1/admin/import-tracking/preview', { rows: [{ code: 'IMP-5', tracking: 'T-A' }, { code: 'IMP-5', tracking: 'T-B' }] });
    expect(((await res.json()) as { rows: Array<{ status: string }> }).rows.map((r) => r.status)).toEqual(['ready', 'duplicate_in_file']);
  });
});

describe('open orders feed (manual tracking grid)', () => {
  it('lists paid unfulfilled and partially fulfilled orders oldest first with remaining items', async () => {
    await seedOrder({ code: 'OPEN-2', placedAt: '2026-09-02T00:00:00Z', lines: [{ ...A, qty: 3, fulfilled: 1 }] });
    await seedOrder({ code: 'OPEN-1', placedAt: '2026-09-01T00:00:00Z', lines: [A, B] });
    await seedOrder({ code: 'DONE', placedAt: '2026-09-03T00:00:00Z', lines: [{ ...A, fulfilled: 2 }] });
    await seedOrder({ code: 'UNPAID', state: 'PendingPayment', lines: [A] });
    const res = await get('/v1/admin/fulfillment/open-orders');
    const b = (await res.json()) as { total: number; items: Array<{ code: string; name: string; fulfillmentStatus: string; items: Array<{ quantity: number }> }> };
    expect(b.items.map((i) => i.code)).toEqual(['OPEN-1', 'OPEN-2']);
    expect(b.total).toBe(2);
    expect(b.items[0]!.name).toBe('Ada Buyer');
    expect(b.items[1]!.fulfillmentStatus).toBe('partially_fulfilled');
    expect(b.items[1]!.items[0]!.quantity).toBe(2);
  });
});

describe('auto-deliver run now', () => {
  async function shipped(code: string, daysAgo: number) {
    const id = await seedOrder({ code, lines: [A] });
    await withStore(STORE, async (tx) => {
      const t = new Date(Date.now() - daysAgo * 86_400_000);
      await tx.execute(sql`INSERT INTO fulfillment (id, store_id, order_id, state, tracking_code, created_at, updated_at) VALUES (gen_random_uuid(), ${STORE}, ${id}, 'Shipped', ${`T-${code}`}, ${t}, ${t})`);
    });
  }
  it('dry run reports what would change and writes nothing; apply delivers and audits', async () => {
    await shipped('AD-OLD', 12);
    await shipped('AD-NEW', 2);
    const dry = (await (await post('/v1/admin/jobs/auto-deliver', { dryRun: true, days: 10 })).json()) as { count: number; sample: Array<{ code: string }>; dryRun: boolean };
    expect(dry).toMatchObject({ dryRun: true, count: 1 });
    expect(dry.sample.map((s) => s.code)).toEqual(['AD-OLD']);
    const states = async () => withStore(STORE, async (tx) => (await tx.execute(sql`SELECT state FROM fulfillment ORDER BY created_at`)).rows.map((r) => (r as { state: string }).state));
    expect(await states()).toEqual(['Shipped', 'Shipped']);
    const real = (await (await post('/v1/admin/jobs/auto-deliver', { dryRun: false, days: 10 })).json()) as { count: number };
    expect(real.count).toBe(1);
    expect((await states()).sort()).toEqual(['Delivered', 'Shipped']);
    const audit = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE action IN ('auto_delivered','auto_deliver_run')`)).rows[0] as { n: number });
    expect(audit.n).toBe(2);
  });
  it('defaults to a dry run', async () => {
    await shipped('AD-OLD2', 30);
    const r = (await (await post('/v1/admin/jobs/auto-deliver', {})).json()) as { dryRun: boolean; count: number };
    expect(r).toMatchObject({ dryRun: true, count: 1 });
  });
});

describe('PATCH /v1/admin/shipping-methods/{id}', () => {
  async function seedMethod() {
    return withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`INSERT INTO shipping_method (id, store_id, code, name, calculator, enabled) VALUES (gen_random_uuid(), ${STORE}, 'free', 'Free', ${JSON.stringify({ flat: 0, min: 10000 })}::jsonb, true) RETURNING id`);
      await tx.execute(sql`INSERT INTO shipping_method (id, store_id, code, name, calculator, enabled) VALUES (gen_random_uuid(), ${STORE}, 'std', 'Standard', ${JSON.stringify({ flat: 800 })}::jsonb, true)`);
      return (r.rows[0] as { id: string }).id;
    });
  }
  const patch = (id: string, body: unknown) => app.request(`/v1/admin/shipping-methods/${id}`, { method: 'PATCH', headers: hdr(), body: JSON.stringify(body) });

  it('accepts every calculator field plus name, code and enabled', async () => {
    const id = await seedMethod();
    const calc = { flat: 0, min: 12000, max: 500000, countries: ['us', 'PR'], exclude: true, requireCountry: true, subtotalBasis: 'discounted_with_tax' };
    const res = await patch(id, { name: 'Free shipping', code: 'free-us', calculator: calc, enabled: false });
    expect(res.status).toBe(200);
    const row = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT code, name, enabled, calculator FROM shipping_method WHERE id = ${id}`)).rows[0] as { code: string; name: string; enabled: boolean; calculator: unknown });
    expect(row).toMatchObject({ code: 'free-us', name: 'Free shipping', enabled: false, calculator: calc });
  });
  it('rejects min > max, bad country codes and a code already in use', async () => {
    const id = await seedMethod();
    expect((await patch(id, { calculator: { min: 500, max: 100 } })).status).toBe(400);
    expect((await patch(id, { calculator: { countries: ['USA'] } })).status).toBe(400);
    expect((await patch(id, { code: 'std' })).status).toBe(409);
  });
});

describe('orders list: date range, owner-facing "Open", customer name', () => {
  it('filters by from/to, status=active and returns the customer name', async () => {
    await seedOrder({ code: 'L-1', placedAt: '2026-09-10T12:00:00Z', lines: [A] });
    await seedOrder({ code: 'L-2', placedAt: '2026-09-20T12:00:00Z', state: 'Cancelled', lines: [A] });
    await seedOrder({ code: 'L-3', placedAt: '2026-09-25T12:00:00Z', state: 'PendingPayment', lines: [A] });
    const list = async (qs: string) => ((await (await get(`/v1/admin/orders?${qs}`)).json()) as { items: Array<{ code: string; firstName: string; lastName: string; paymentStatus: string; fulfillmentStatus: string }> }).items;
    expect((await list('from=2026-09-15&to=2026-09-25')).map((o) => o.code).sort()).toEqual(['L-2', 'L-3']);
    expect((await list('to=2026-09-10')).map((o) => o.code)).toEqual(['L-1']);
    const active = await list('status=active');
    expect(active.map((o) => o.code).sort()).toEqual(['L-1', 'L-3']);
    expect(active[0]).toMatchObject({ firstName: 'Ada', lastName: 'Buyer' });
    expect((await list('status=active&paymentStatus=paid')).map((o) => o.code)).toEqual(['L-1']);
    const exp = await get('/v1/admin/export/orders?from=2026-09-01&to=2026-09-30&status=active&columns=code');
    expect((await exp.text()).trim().split('\n').slice(1).sort()).toEqual(['L-1', 'L-3']);
  });
});
