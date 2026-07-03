/**
 * DB tests for the bulk order management endpoints: cancel / soft-delete /
 * restore / purge (cascade). Route-level — drives the real Hono handlers through
 * app.request() with a seeded owner session, so auth + withStore + RLS all run
 * exactly as in production.
 *
 * Runs against sellright_test ONLY (these wipe data). Mirrors
 * licensing/activations.test.ts: _test-DB guard + TRUNCATE store CASCADE wipe +
 * seed helpers under withStore(). vitest runs files serially
 * (fileParallelism: false), so the shared DB is safe between files.
 *
 * Covers:
 *   1. cancel a PendingPayment order → Cancelled + stock allocation released
 *   2. cancel skips a Paid order (use Refund)
 *   3. soft-delete sets deletedAt; default list excludes it, ?trashed=1 includes
 *   4. restore clears deletedAt
 *   5. purge a trashed order with payment + line + license + activation →
 *      every child row gone, no FK error (the cascade proof)
 *   6. purge refuses a non-trashed order
 *   7. purge refuses a Paid order without force
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { admin } from './admin.js';
import { adminOrders } from './admin-orders.js';
import { adminOrderOps } from './admin-order-ops.js';

// Safety: refuse to run against anything but a *_test database.
const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `bulk-ops test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`,
  );
}

const STORE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SLUG = 'bulk-test-store';
const ADMIN = 'cccccccc-cccc-cccc-cccc-00000000000a';
const VARIANT = 'cccccccc-cccc-cccc-cccc-00000000000b';

// One app with the routers mounted so we can hit the list (adminOrders) + the
// bulk ops (adminOrderOps — cancel/soft-delete/restore/purge live here after the
// admin-order-ops split) through the same request pipeline.
const app = new OpenAPIHono();
app.route('/', admin);
app.route('/', adminOrders);
app.route('/', adminOrderOps);

let token = '';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  // session/admin_user are not store-scoped (RLS-exempt) — clear by hand.
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

/** Seed store + owner admin + session + one stocked variant. Returns the token. */
async function seedStoreAndAdmin(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@bulk.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    // a product + variant + stock row so cancel can release an allocation
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT}, ${STORE}, ${pid}, 'SKU1', 'V1', 1000) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 100, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 100, allocated = 0`);
  });
  return createAdminSession(ADMIN);
}

interface SeedOrderOpts {
  code: string;
  state?: string; // order_state
  deleted?: boolean;
  allocated?: number; // stock allocation to seed against VARIANT (cancel releases it)
  withChildren?: boolean; // payment + line + license + activation (purge cascade)
}

/** Seed one order (+ optional line/payment/license/activation) under STORE. */
async function seedOrder(opts: SeedOrderOpts): Promise<string> {
  const { code, state = 'PendingPayment', deleted = false, allocated = 0, withChildren = false } = opts;
  const orderId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total, deleted_at)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, ${state}::order_state, 'USD', 1000, ${deleted ? new Date().toISOString() : null}::timestamptz)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  if (allocated > 0) {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`UPDATE stock SET allocated = allocated + ${allocated} WHERE variant_id = ${VARIANT}`);
    });
  }
  // A line is always created so cancel has something to release.
  const lineId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${VARIANT}, 'SKU1', 'V1', ${allocated || 1}, 1000, 1000, 1000, 0)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  if (withChildren) {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO payment (id, store_id, order_id, amount, method, state) VALUES (gen_random_uuid(), ${STORE}, ${orderId}, 1000, 'manual', 'Settled')`);
      const lr = await tx.execute(sql`
        INSERT INTO license (id, store_id, order_id, order_line_id, app_key, license_key, status, seats)
        VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${lineId}, 'viewright', ${'LK-' + code}, 'active', 1)
        RETURNING id`);
      const licId = (lr.rows[0] as { id: string }).id;
      await tx.execute(sql`
        INSERT INTO license_activation (id, store_id, license_id, app_key, device_id_hash)
        VALUES (gen_random_uuid(), ${STORE}, ${licId}, 'viewright', ${'dev-' + code})`);
      // A converted cart points back at this order via cart.convertedOrderId
      // (set on EVERY real checkout). Purge must UNLINK this (set null), not
      // delete the cart — otherwise the order delete FK-fails. This is the
      // exact case the corrected purge guards against.
      await tx.execute(sql`
        INSERT INTO cart (id, store_id, token, status, converted_order_id)
        VALUES (gen_random_uuid(), ${STORE}, ${'cart-' + code}, 'converted', ${orderId})`);
    });
  }
  return orderId;
}

type BulkBody = { results: { code: string; ok: boolean; error?: string }[]; succeeded: number; skipped: number };
type ListBody = { items: { code: string }[]; total: number; page: number; pageSize: number };

async function callBulk(path: string, body: unknown): Promise<{ status: number; body: BulkBody }> {
  const res = await app.request(`/v1/admin/orders/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as BulkBody };
}

async function listOrders(qs = ''): Promise<ListBody> {
  const res = await app.request(`/v1/admin/orders${qs}`, {
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG },
  });
  return (await res.json()) as ListBody;
}

async function orderState(code: string): Promise<string | null> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT state FROM "order" WHERE code = ${code} LIMIT 1`);
    return (r.rows[0] as { state: string } | undefined)?.state ?? null;
  });
}

async function deletedAt(code: string): Promise<string | null | undefined> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT deleted_at FROM "order" WHERE code = ${code} LIMIT 1`);
    return (r.rows[0] as { deleted_at: string | null } | undefined)?.deleted_at;
  });
}

async function stockAllocated(): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT allocated FROM stock WHERE variant_id = ${VARIANT} LIMIT 1`);
    return Number((r.rows[0] as { allocated: number }).allocated);
  });
}

beforeEach(async () => {
  await wipe();
  token = await seedStoreAndAdmin();
});
afterEach(wipe);
afterAll(() => pool.end());

describe('bulk-cancel', () => {
  it('(1) cancels a PendingPayment order → Cancelled + releases stock', async () => {
    await seedOrder({ code: 'O-CANCEL-1', state: 'PendingPayment', allocated: 3 });
    expect(await stockAllocated()).toBe(3);
    const { status, body } = await callBulk('bulk-cancel', { codes: ['O-CANCEL-1'] });
    expect(status).toBe(200);
    expect(body.succeeded).toBe(1);
    expect(body.skipped).toBe(0);
    expect(await orderState('O-CANCEL-1')).toBe('Cancelled');
    expect(await stockAllocated()).toBe(0); // 3 released
  });

  it('(2) skips a Paid order (use Refund)', async () => {
    await seedOrder({ code: 'O-PAID-1', state: 'Paid' });
    const { status, body } = await callBulk('bulk-cancel', { codes: ['O-PAID-1'] });
    expect(status).toBe(200);
    expect(body.succeeded).toBe(0);
    expect(body.skipped).toBe(1);
    expect(body.results[0]!.ok).toBe(false);
    expect(body.results[0]!.error).toMatch(/paid order/i);
    expect(await orderState('O-PAID-1')).toBe('Paid');
  });
});

describe('bulk-soft-delete / restore', () => {
  it('(3) soft-delete sets deletedAt; default list hides it, ?trashed=1 shows only it', async () => {
    await seedOrder({ code: 'O-LIVE-1', state: 'PendingPayment' });
    await seedOrder({ code: 'O-TRASH-1', state: 'PendingPayment' });

    const del = await callBulk('bulk-soft-delete', { codes: ['O-TRASH-1'] });
    expect(del.status).toBe(200);
    expect(del.body.succeeded).toBe(1);
    expect(await deletedAt('O-TRASH-1')).toBeTruthy();

    const liveList = await listOrders();
    const liveCodes = liveList.items.map((o: { code: string }) => o.code);
    expect(liveCodes).toContain('O-LIVE-1');
    expect(liveCodes).not.toContain('O-TRASH-1');

    const trashList = await listOrders('?trashed=1');
    const trashCodes = trashList.items.map((o: { code: string }) => o.code);
    expect(trashCodes).toEqual(['O-TRASH-1']);
  });

  it('(3b) soft-delete refuses an already-trashed order', async () => {
    await seedOrder({ code: 'O-TRASH-2', deleted: true });
    const res = await callBulk('bulk-soft-delete', { codes: ['O-TRASH-2'] });
    const body = res.body;
    expect(body.succeeded).toBe(0);
    expect(body.results[0]!.error).toMatch(/already trashed/i);
  });

  it('(4) restore clears deletedAt', async () => {
    await seedOrder({ code: 'O-REST-1', deleted: true });
    expect(await deletedAt('O-REST-1')).toBeTruthy();
    const res = await callBulk('bulk-restore', { codes: ['O-REST-1'] });
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBe(1);
    expect(await deletedAt('O-REST-1')).toBeFalsy();
  });

  it('(4b) restore refuses a non-trashed order', async () => {
    await seedOrder({ code: 'O-REST-2', deleted: false });
    const res = await callBulk('bulk-restore', { codes: ['O-REST-2'] });
    const body = res.body;
    expect(body.succeeded).toBe(0);
    expect(body.results[0]!.error).toMatch(/not trashed/i);
  });
});

describe('bulk-purge (cascade)', () => {
  it('(5) purges a trashed order with payment + line + license + activation AND a converted cart; every child gone, the cart row SURVIVES with convertedOrderId NULL, no FK error', async () => {
    const orderId = await seedOrder({ code: 'O-PURGE-1', state: 'PendingPayment', deleted: true, withChildren: true });

    // sanity: children exist before purge — incl. the converted cart pointing here
    const before = await withStore(STORE, async (tx) => {
      const p = await tx.execute(sql`SELECT count(*)::int n FROM payment WHERE order_id = ${orderId}`);
      const l = await tx.execute(sql`SELECT count(*)::int n FROM order_line WHERE order_id = ${orderId}`);
      const lic = await tx.execute(sql`SELECT count(*)::int n FROM license WHERE order_id = ${orderId}`);
      const act = await tx.execute(sql`SELECT count(*)::int n FROM license_activation la JOIN license li ON li.id = la.license_id WHERE li.order_id = ${orderId}`);
      const cartLinked = await tx.execute(sql`SELECT count(*)::int n FROM cart WHERE converted_order_id = ${orderId}`);
      return {
        payment: (p.rows[0] as { n: number }).n, line: (l.rows[0] as { n: number }).n,
        license: (lic.rows[0] as { n: number }).n, activation: (act.rows[0] as { n: number }).n,
        cartLinked: (cartLinked.rows[0] as { n: number }).n,
      };
    });
    expect(before).toEqual({ payment: 1, line: 1, license: 1, activation: 1, cartLinked: 1 });

    const res = await callBulk('bulk-purge', { codes: ['O-PURGE-1'] });
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.skipped).toBe(0);
    // no FK error leaked through as a per-row failure
    expect(res.body.results[0]!.ok).toBe(true);

    // every delete-cascaded row (order + children) is gone
    const after = await withStore(STORE, async (tx) => {
      const o = await tx.execute(sql`SELECT count(*)::int n FROM "order" WHERE id = ${orderId}`);
      const p = await tx.execute(sql`SELECT count(*)::int n FROM payment WHERE order_id = ${orderId}`);
      const l = await tx.execute(sql`SELECT count(*)::int n FROM order_line WHERE order_id = ${orderId}`);
      const lic = await tx.execute(sql`SELECT count(*)::int n FROM license WHERE order_id = ${orderId}`);
      return {
        order: (o.rows[0] as { n: number }).n, payment: (p.rows[0] as { n: number }).n,
        line: (l.rows[0] as { n: number }).n, license: (lic.rows[0] as { n: number }).n,
      };
    });
    expect(after).toEqual({ order: 0, payment: 0, line: 0, license: 0 });

    // the cart row is UNLINKED, not deleted — it survives with convertedOrderId NULL
    const cart = await withStore(STORE, async (tx) => {
      const total = await tx.execute(sql`SELECT count(*)::int n FROM cart WHERE token = 'cart-O-PURGE-1'`);
      const stillLinked = await tx.execute(sql`SELECT count(*)::int n FROM cart WHERE converted_order_id = ${orderId}`);
      return { total: (total.rows[0] as { n: number }).n, stillLinked: (stillLinked.rows[0] as { n: number }).n };
    });
    expect(cart).toEqual({ total: 1, stillLinked: 0 });

    // audit row written BEFORE the cascade survives the deletion
    const audit = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT count(*)::int n FROM audit_log WHERE entity = 'order' AND action = 'purge' AND entity_id = ${orderId}`);
      return (r.rows[0] as { n: number }).n;
    });
    expect(audit).toBe(1);
  });

  it('(6) purge refuses a non-trashed order', async () => {
    await seedOrder({ code: 'O-PURGE-2', state: 'PendingPayment', deleted: false });
    const res = await callBulk('bulk-purge', { codes: ['O-PURGE-2'] });
    const body = res.body;
    expect(body.succeeded).toBe(0);
    expect(body.results[0]!.error).toMatch(/trash the order first/i);
    expect(await orderState('O-PURGE-2')).toBe('PendingPayment'); // untouched
  });

  it('(7) purge refuses a Paid order without force', async () => {
    await seedOrder({ code: 'O-PURGE-3', state: 'Paid', deleted: true });
    const res = await callBulk('bulk-purge', { codes: ['O-PURGE-3'] });
    const body = res.body;
    expect(body.succeeded).toBe(0);
    expect(body.results[0]!.error).toMatch(/force \+ reason/i);

    // with force but no reason → still refused
    const res2 = await callBulk('bulk-purge', { codes: ['O-PURGE-3'], force: true });
    expect(res2.body.results[0]!.error).toMatch(/requires a reason/i);

    // with force + reason → purged
    const res3 = await callBulk('bulk-purge', { codes: ['O-PURGE-3'], force: true, reason: 'test cleanup' });
    expect(res3.body.succeeded).toBe(1);
  });

  // 5c — FK-coverage guard: the purge cascade is hand-maintained, so a future FK
  // to "order" would silently break it (the order delete would FK-fail). This
  // introspects the live schema and fails the moment a new child FK appears that
  // the purge does not delete-or-unlink.
  it('purge handles every FK that references order (fails when a new FK is added)', async () => {
    const HANDLED = new Set([
      'order_line', 'license', 'payment', 'refund', 'return_request', 'fulfillment', 'promotion_usage', // delete-cascaded
      'cart', 'stock_movement', 'gift_card_transaction', 'subscription', // unlinked (nullable) back-refs
    ]);
    const r = await pool.query(
      `SELECT conrelid::regclass::text AS child FROM pg_constraint WHERE contype='f' AND confrelid='"order"'::regclass`,
    );
    const children = (r.rows as { child: string }[]).map((x) => x.child.replace(/"/g, ''));
    const unhandled = children.filter((t) => !HANDLED.has(t));
    expect(unhandled, `bulk-purge must delete-or-unlink these new FK children of order: ${unhandled.join(', ')}`).toEqual([]);
  });
});
