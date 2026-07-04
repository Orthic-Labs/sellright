/**
 * DB tests for SEC-6: per-action RBAC on the money- and supply-chain-sensitive
 * admin mutations that were previously gated only by `requireWrite` (any
 * non-read_only staff). Confirms:
 *   - owner passes every gated route without any explicit permission grant
 *     (role bypass in requirePermission)
 *   - a staff account with an EMPTY permissions map is denied (403) on the
 *     gated route, deny-by-default
 *   - that SAME staff account still succeeds (200) on a non-gated write route
 *     (proves requireWrite still governs ordinary staff actions — the new gate
 *     is additive, not a lockout of staff generally)
 *   - granting the specific permission key flips the staff account to 200
 *
 * Covers the three new keys: 'refunds' (order refund + return-approve),
 * 'cancel_orders' (order cancel), 'releases' (app release create/publish).
 *
 * Runs against sellright_test ONLY (TRUNCATEs). Mirrors admin-orders.bulk.test.ts:
 * route-level via app.request() with a seeded session, so auth + withStore + RLS
 * all run exactly as in production. vitest runs files serially
 * (fileParallelism: false), so the shared DB is safe between files.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { admin } from './admin.js';
import { adminOrders } from './admin-orders.js';
import { apps } from './apps.js';

// Safety: refuse to run against anything but a *_test database.
const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `RBAC-sensitive test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`,
  );
}

const STORE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SLUG = 'rbac-sensitive-store';
const OWNER = 'dddddddd-dddd-dddd-dddd-00000000000a';
const STAFF = 'dddddddd-dddd-dddd-dddd-00000000000b';
const VARIANT = 'dddddddd-dddd-dddd-dddd-00000000000c';

const app = new OpenAPIHono();
app.route('/', admin);
app.route('/', adminOrders);
app.route('/', apps);

let ownerToken = '';
let staffToken = '';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

/** Seed store + owner + staff (no permissions yet) + a stocked variant. */
async function seedStoreAndAdmins(): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${OWNER}, 'owner@rbac.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${STAFF}, 'staff@rbac.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${OWNER}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role, permissions) VALUES (${STAFF}, ${STORE}, 'staff', '{}'::jsonb) ON CONFLICT DO NOTHING`);
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
  ownerToken = await createAdminSession(OWNER);
  staffToken = await createAdminSession(STAFF);
}

/** Grant a single per-action permission key to the STAFF account. */
async function grantStaffPermission(key: string): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`UPDATE admin_user_store SET permissions = jsonb_set(coalesce(permissions, '{}'::jsonb), ${'{' + key + '}'}, 'true'::jsonb) WHERE admin_user_id = ${STAFF} AND store_id = ${STORE}`);
  });
}

interface SeedOrderOpts {
  code: string;
  state?: string; // order_state
  settledPayment?: boolean;
}

async function seedOrder(opts: SeedOrderOpts): Promise<string> {
  const { code, state = 'Paid', settledPayment = false } = opts;
  const orderId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, ${state}::order_state, 'USD', 1000)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${VARIANT}, 'SKU1', 'V1', 1, 1000, 1000, 1000, 0)`);
  });
  if (settledPayment) {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO payment (id, store_id, order_id, amount, method, state) VALUES (gen_random_uuid(), ${STORE}, ${orderId}, 1000, 'manual', 'Settled')`);
    });
  }
  return orderId;
}

async function call(token: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(`/v1/admin${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  await wipe();
  await seedStoreAndAdmins();
});
afterEach(wipe);
afterAll(() => pool.end());

describe('refunds permission gate', () => {
  it('owner passes the refund route without any explicit grant', async () => {
    await seedOrder({ code: 'O-REF-OWNER', state: 'Paid', settledPayment: true });
    const { status } = await call(ownerToken, '/orders/O-REF-OWNER/refund', { restock: false });
    expect(status).toBe(200);
  });

  it('staff WITHOUT refunds permission gets 403 on refund', async () => {
    await seedOrder({ code: 'O-REF-DENY', state: 'Paid', settledPayment: true });
    const { status, body } = await call(staffToken, '/orders/O-REF-DENY/refund', { restock: false });
    expect(status).toBe(403);
    expect(String(body.error)).toMatch(/refunds/);
  });

  it('staff WITH refunds permission gets 200 on refund', async () => {
    await grantStaffPermission('refunds');
    await seedOrder({ code: 'O-REF-GRANT', state: 'Paid', settledPayment: true });
    const { status } = await call(staffToken, '/orders/O-REF-GRANT/refund', { restock: false });
    expect(status).toBe(200);
  });

  it('staff without refunds permission still gets 200 on a non-gated write (open a return request)', async () => {
    const orderId = await seedOrder({ code: 'O-RET-OPEN', state: 'Paid', settledPayment: true });
    const lineId = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT id FROM order_line WHERE order_id = ${orderId} LIMIT 1`);
      return (r.rows[0] as { id: string }).id;
    });
    const { status } = await call(staffToken, '/orders/O-RET-OPEN/returns', { lines: [{ orderLineId: lineId, quantity: 1, restock: true }] });
    expect(status).toBe(200);
  });
});

describe('cancel_orders permission gate', () => {
  it('owner passes the cancel route without any explicit grant', async () => {
    await seedOrder({ code: 'O-CXL-OWNER', state: 'PendingPayment' });
    const { status } = await call(ownerToken, '/orders/O-CXL-OWNER/cancel', {});
    expect(status).toBe(200);
  });

  it('staff WITHOUT cancel_orders permission gets 403 on cancel', async () => {
    await seedOrder({ code: 'O-CXL-DENY', state: 'PendingPayment' });
    const { status, body } = await call(staffToken, '/orders/O-CXL-DENY/cancel', {});
    expect(status).toBe(403);
    expect(String(body.error)).toMatch(/cancel_orders/);
  });

  it('staff WITH cancel_orders permission gets 200 on cancel', async () => {
    await grantStaffPermission('cancel_orders');
    await seedOrder({ code: 'O-CXL-GRANT', state: 'PendingPayment' });
    const { status } = await call(staffToken, '/orders/O-CXL-GRANT/cancel', {});
    expect(status).toBe(200);
  });

  it('staff without cancel_orders permission still gets 200 on a non-gated write (fulfill)', async () => {
    await seedOrder({ code: 'O-FULFILL-OK', state: 'Paid' });
    const { status } = await call(staffToken, '/orders/O-FULFILL-OK/fulfill', { state: 'Shipped' });
    expect(status).toBe(200);
  });
});

describe('releases permission gate', () => {
  const releaseBody = (version: string) => ({ appKey: 'viewright', version, channel: 'stable', manifest: { version } });

  it('owner passes the release-create route without any explicit grant', async () => {
    const { status } = await call(ownerToken, '/apps/releases', releaseBody('1.0.0-owner'));
    expect(status).toBe(200);
  });

  it('staff WITHOUT releases permission gets 403 on release create', async () => {
    const { status, body } = await call(staffToken, '/apps/releases', releaseBody('1.0.0-deny'));
    expect(status).toBe(403);
    expect(String(body.error)).toMatch(/releases/);
  });

  it('staff WITH releases permission gets 200 on release create', async () => {
    await grantStaffPermission('releases');
    const { status } = await call(staffToken, '/apps/releases', releaseBody('1.0.0-grant'));
    expect(status).toBe(200);
  });
});
