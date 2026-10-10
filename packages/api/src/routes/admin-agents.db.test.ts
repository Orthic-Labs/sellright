import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { _resetPoolsForTest, initPools, pool, withStore, assertRuntimeRoleUnprivileged } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { hashAgentToken } from '../auth/admin-api-token.js';
import { AGENT_DENIED } from '../auth/agent-policy.js';
import { buildHttpApp } from '../app.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) throw new Error('agent tests truncate data — use a *_test database');
// Astra v5 F8: CI's DATABASE_URL is the superuser (bypasses RLS). Run the APP (buildHttpApp + withStore) on the
// unprivileged role when DATABASE_URL_NONOWNER is set, exactly like payments/tenant-resolution.db.test.ts; keep a
// separate OWNER pool for TRUNCATE/wipe. Single-role dev fallback: the foreign-id tenancy case is skipped (as there).
const NONOWNER = env.DATABASE_URL_NONOWNER;
const ownerPool = new Pool({ connectionString: DB });
_resetPoolsForTest(); initPools({ ...env, DATABASE_URL: NONOWNER ?? DB });

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000a', MANAGER = 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000b', STAFF = 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000c';
const PA = 'aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1', VA = 'aaaaaaaa-aaaa-4aaa-8aaa-0000000000a2', RA = 'aaaaaaaa-aaaa-4aaa-8aaa-0000000000a3';
const PB = 'bbbbbbbb-bbbb-4bbb-8bbb-0000000000b1';
const ORDER_FULL = 'AGT-A-FULL', ORDER_TRASH = 'AGT-A-TRASH', ORDER_PENDING = 'AGT-A-PENDING', ORDER_EDIT = 'AGT-A-EDIT';
const CUST = 'aaaaaaaa-aaaa-4aaa-8aaa-0000000000c1', RET = 'aaaaaaaa-aaaa-4aaa-8aaa-0000000000d1';
const app = buildHttpApp();
let ownerToken = '', managerToken = '', staffToken = '';
const H = (token: string, slug = 'store-a', extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, 'x-store-slug': slug, ...extra });
const req = (method: string, path: string, token: string, body?: unknown, slug = 'store-a') =>
  app.request(path, { method, headers: H(token, slug, body === undefined ? {} : { 'content-type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });

async function wipe() { await ownerPool.query('TRUNCATE store CASCADE'); await ownerPool.query('DELETE FROM "session"'); await ownerPool.query('DELETE FROM admin_api_token'); await ownerPool.query('DELETE FROM admin_user'); }
async function seed() {
  await withStore(A, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${A}, 'store-a', 'A'), (${B}, 'store-b', 'B')`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${OWNER}, 'owner@agent.test', 'x'), (${MANAGER}, 'manager@agent.test', 'x'), (${STAFF}, 'staff@agent.test', 'x')`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${OWNER}, ${A}, 'owner'), (${OWNER}, ${B}, 'owner'), (${MANAGER}, ${A}, 'manager'), (${STAFF}, ${A}, 'staff')`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PA}, ${A}, 'pa', 'PA', 'active')`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VA}, ${A}, ${PA}, 'SKU-A', 'VA', 1000)`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VA}, ${A}, 10, 0)`);
    await tx.execute(sql`INSERT INTO product_review (id, store_id, product_id, author_name, author_email, rating, body, status) VALUES (${RA}, ${A}, ${PA}, 'Rev', 'rev@agent.test', 5, 'nice', 'pending')`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, first_name, last_name) VALUES (${CUST}, ${A}, 'buyer@agent.test', 'Ada', 'Buyer')`);
    for (const code of [ORDER_FULL, ORDER_TRASH, ORDER_PENDING, ORDER_EDIT]) {
      const state = code === ORDER_PENDING ? 'PendingPayment' : 'Paid';
      // subtotal = grand_total = quantity × unit price (2 × 1000), so a recomputed total matches the stored one (order-edit commit checks expectedGrandTotal)
      await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, currency, subtotal, grand_total, customer_id, shipping_address, billing_address) VALUES (gen_random_uuid(), ${A}, ${code}, ${state}::order_state, 'USD', 2000, 2000, ${CUST}, '{"line1":"1 Ship St"}'::jsonb, '{"line1":"1 Bill St"}'::jsonb)`);
      await tx.execute(sql`INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
        SELECT gen_random_uuid(), ${A}, id, ${VA}, 'SKU-A', 'VA', 2, 1000, 2000, 2000, 0 FROM "order" WHERE code = ${code}`);
    }
    await tx.execute(sql`INSERT INTO return_request (id, store_id, order_id, status) SELECT ${RET}, ${A}, id, 'requested' FROM "order" WHERE code = ${ORDER_FULL}`);
  });
  await withStore(B, async (tx) => { await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PB}, ${B}, 'pb', 'PB', 'active')`); });
  ownerToken = await createAdminSession(OWNER); managerToken = await createAdminSession(MANAGER); staffToken = await createAdminSession(STAFF);
}
async function createAgent(by = managerToken, extra: Record<string, unknown> = {}) { const r = await req('POST', '/v1/admin/agents', by, { name: 'Ops bot', ...extra }); expect(r.status).toBe(200); return (await r.json()) as { adminUserId: string; token: string; email: string; id: string; role: string }; }
async function agentAudit(storeId: string, action: string) { return withStore(storeId, async (tx) => (await tx.execute(sql`SELECT actor, data FROM audit_log WHERE entity = 'agent' AND action = ${action} ORDER BY at`)).rows as { actor: string; data: Record<string, unknown> }[]); }
const count = (storeId: string, table: string) => withStore(storeId, async (tx) => Number((await tx.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))).rows[0]!['n']));
const ok2xx = (r: Response) => r.status >= 200 && r.status < 300;
/** The admin error envelope is `{ error: { code, message } }` (lib/api-error.ts); read the message. */
const errMessage = async (r: Response) => ((await r.json()) as { error?: { message?: string } }).error?.message;

beforeEach(async () => { await wipe(); await seed(); });
afterAll(async () => { await wipe(); await pool.end(); await ownerPool.end(); });

/** What the owner named as "operate the store": each must be 2xx for a staff-role agent. Executed in order. */
const ALLOWED: { method: string; path: string; body?: unknown; label: string }[] = [
  { label: 'create product', method: 'POST', path: '/v1/admin/products', body: { name: 'Agent made', status: 'draft' } },
  { label: 'disable product', method: 'PATCH', path: `/v1/admin/products/${PA}`, body: { status: 'draft' } },
  { label: 'change a price', method: 'PATCH', path: `/v1/admin/variants/${VA}`, body: { price: 1500 } },
  { label: 'add a variant', method: 'POST', path: `/v1/admin/products/${PA}/variants`, body: { sku: 'SKU-A2', name: 'VA2', price: 900 } },
  { label: 'tag a product', method: 'PATCH', path: `/v1/admin/products/${PA}`, body: { tags: ['sale'] } },
  { label: 'set stock', method: 'PATCH', path: `/v1/admin/variants/${VA}/stock`, body: { onHand: 12 } },
  { label: 'create collection', method: 'POST', path: '/v1/admin/collections', body: { name: 'Agent picks' } },
  { label: 'create draft order (unpaid — D10)', method: 'POST', path: '/v1/admin/draft-orders', body: { items: [{ sku: 'SKU-A', quantity: 1 }] } }, // markPaid defaults to false → PendingPayment
  { label: 'fulfil', method: 'POST', path: `/v1/admin/orders/${ORDER_FULL}/fulfill`, body: { state: 'Shipped', trackingCode: 'T1' } },
  { label: 'order note', method: 'POST', path: `/v1/admin/orders/${ORDER_FULL}/notes`, body: { note: 'agent note' } },
  { label: 'approve review', method: 'POST', path: `/v1/admin/reviews/${RA}/approve` },
  { label: 'trash order', method: 'POST', path: '/v1/admin/orders/bulk-soft-delete', body: { codes: [ORDER_TRASH] } },
  { label: 'restore order', method: 'POST', path: '/v1/admin/orders/bulk-restore', body: { codes: [ORDER_TRASH] } },
  { label: 'reject a return', method: 'POST', path: `/v1/admin/returns/${RET}/reject` },
  // commit schema: ops min 1, expectedGrandTotal required (admin-order-edit.ts); a set_address op leaves the total at the seeded 2000 and needs no settlement
  { label: 'ordinary order edit (no refund_now)', method: 'POST', path: `/v1/admin/orders/${ORDER_EDIT}/edit/commit`, body: { ops: [{ op: 'set_address', kind: 'shipping', address: { line1: '2 New St', city: 'Austin', country: 'US' } }], expectedGrandTotal: 2000, idempotencyKey: 'agent-edit-1', notifyCustomer: false, settlement: { type: 'leave_due' } } },
  { label: 'list customers', method: 'GET', path: '/v1/admin/customers' },
  { label: 'export orders', method: 'GET', path: '/v1/admin/export/orders' },
];
/** Hard-blocked for the agent (403 + audit row) even with every grant set; the owner control proves each request is otherwise valid. */
const DENIED: { method: string; path: string; body?: unknown; table?: string; group: string; control?: false }[] = [
  { method: 'DELETE', path: `/v1/admin/products/${PA}`, table: 'product', group: 'delete' },
  { method: 'DELETE', path: `/v1/admin/variants/${VA}`, table: 'product_variant', group: 'delete' },
  { method: 'DELETE', path: `/v1/admin/reviews/${RA}`, table: 'product_review', group: 'delete' },
  { method: 'POST', path: `/v1/admin/orders/${ORDER_PENDING}/cancel`, body: {}, group: 'irreversible_order' }, // cancel only admits PendingPayment (admin.ts)
  { method: 'POST', path: '/v1/admin/orders/bulk-cancel', body: { codes: [ORDER_PENDING] }, group: 'irreversible_order', control: false }, // bulk returns 200 with per-item outcomes; single-cancel control covers the path
  { method: 'POST', path: '/v1/admin/orders/bulk-purge', body: { codes: [ORDER_TRASH] }, group: 'irreversible_order', control: false },
  { method: 'POST', path: `/v1/admin/orders/${ORDER_FULL}/refund`, body: { amount: 1 }, group: 'money_out', control: false },
  { method: 'POST', path: `/v1/admin/returns/${RET}/approve`, body: {}, group: 'money_out', control: false }, // D11
  { method: 'POST', path: '/v1/admin/payment-reconciliation/effects/00000000-0000-4000-8000-000000000000/retry', body: {}, group: 'settlement', control: false },
  { method: 'POST', path: '/v1/admin/licenses', body: {}, group: 'entitlement', control: false },
  { method: 'POST', path: '/v1/admin/apps/releases', body: {}, group: 'release', control: false },
  { method: 'POST', path: '/v1/admin/staff', body: { email: 'new@agent.test', role: 'staff', password: 'password123' }, table: 'admin_user', group: 'identity' },
  { method: 'PATCH', path: `/v1/admin/staff/${STAFF}`, body: { role: 'manager' }, group: 'identity' },
  { method: 'POST', path: '/v1/admin/agents', body: { name: 'self-replicate' }, table: 'admin_api_token', group: 'identity' },
  { method: 'POST', path: '/v1/admin/2fa/setup', body: {}, group: 'credentials' },
  { method: 'POST', path: '/v1/admin/step-up', body: { password: 'x' }, group: 'credentials', control: false },
  { method: 'PUT', path: '/v1/admin/email/settings', body: {}, group: 'credentials', control: false },
  { method: 'PATCH', path: '/v1/admin/sheerid/config', body: { clientSecret: 'x' }, group: 'credentials', control: false },
  { method: 'POST', path: '/v1/admin/settings/preview-token', body: {}, group: 'credentials' },
  { method: 'PATCH', path: '/v1/admin/settings/payments/stripe-mode', body: { mode: 'test' }, group: 'credentials', control: false },
  { method: 'POST', path: '/v1/admin/staff/accept', body: { token: 'not-a-real-invite', password: 'password123' }, group: 'identity', control: false }, // public route, but an agent credential on it is still denied (F4)
  { method: 'POST', path: `/v1/admin/customers/${CUST}/loyalty/adjust`, body: { points: 100, reason: 'agent test' }, group: 'credit', control: false }, // body shape per admin-loyalty.ts:116; the owner control needs the loyalty program enabled — mark feasible once the fixture has it
  { method: 'POST', path: '/v1/admin/system/canary', body: {}, group: 'system', control: false },
];

describe('agent seats', () => {
  it('creation needs manage; role defaults to staff and never owner; /me reports kind=agent with real role; audited', async () => {
    expect((await req('POST', '/v1/admin/agents', staffToken, { name: 'x' })).status).toBe(403);
    expect((await req('POST', '/v1/admin/agents', managerToken, { name: 'x', role: 'owner' })).status).toBe(400);
    expect((await req('POST', '/v1/admin/agents', managerToken, { name: 'x', expiresAt: '2000-01-01T00:00:00Z' })).status).toBe(400);
    const a = await createAgent();
    expect(await (await req('GET', '/v1/admin/me', a.token)).json()).toMatchObject({ kind: 'agent', auth: 'api_token', stores: [{ role: 'staff' }] });
    expect((await agentAudit(A, 'create'))[0]).toMatchObject({ actor: 'manager@agent.test', data: { role: 'staff' } });
  });

  it('a staff-role agent operates the store: every ALLOWED request is 2xx and persists', async () => {
    const a = await createAgent();
    for (const x of ALLOWED) {
      const r = await req(x.method, x.path, a.token, x.body);
      expect([x.label, ok2xx(r) ? 'ok' : `${r.status} ${await r.text()}`]).toEqual([x.label, 'ok']);
    }
    const v = await withStore(A, async (tx) => (await tx.execute(sql`SELECT price FROM product_variant WHERE id = ${VA}`)).rows[0] as { price: number });
    expect(v.price).toBe(1500);
    expect(((await withStore(A, async (tx) => (await tx.execute(sql`SELECT status FROM product_review WHERE id = ${RA}`)).rows[0])) as { status: string }).status).toBe('approved');
    expect(((await withStore(A, async (tx) => (await tx.execute(sql`SELECT deleted_at FROM "order" WHERE code = ${ORDER_TRASH}`)).rows[0])) as { deleted_at: string | null }).deleted_at).toBeNull();
    const reqRows = await agentAudit(A, 'request');
    expect(reqRows.length).toBe(ALLOWED.filter((x) => x.method !== 'GET').length);
    for (const r of reqRows) expect([r.data.route, typeof r.data.status]).toEqual([r.data.route, 'number']); // pre-handler row, status filled in after
    const prod = await withStore(A, async (tx) => (await tx.execute(sql`SELECT actor FROM audit_log WHERE entity = 'product' AND action = 'create' ORDER BY at DESC LIMIT 1`)).rows[0] as { actor: string });
    expect(prod.actor).toBe(a.email);
  });

  it('denied: 403 with the deny group, audited, rows unchanged — even with every permission granted', async () => {
    const a = await createAgent();
    expect((await req('PUT', `/v1/admin/staff/${a.adminUserId}/permissions`, ownerToken, { permissions: { refunds: true, cancel_orders: true, giftcards: true, releases: true, webhooks: true, loyalty: true, affiliate_payouts: true } })).status).toBe(200);
    for (const d of DENIED) {
      const before = d.table ? await count(A, d.table) : null;
      const r = await req(d.method, d.path, a.token, d.body);
      expect([d.method, d.path, r.status]).toEqual([d.method, d.path, 403]);
      if (d.table) expect([d.path, await count(A, d.table)]).toEqual([d.path, before]);
    }
    const denied = (await agentAudit(A, 'denied')).filter((x) => x.actor === a.email);
    expect(denied.map((x) => x.data.group)).toEqual(DENIED.map((d) => d.group));
  });

  it('grants otherwise apply: giftcards granted → create 2xx but DISABLED (D12); enabling/adjusting is human-only; a delete stays 403 whatever is granted', async () => {
    const a = await createAgent();
    const g = { balance: 1000, code: 'AGENT-GC-1' };
    expect((await req('POST', '/v1/admin/gift-cards', a.token, g)).status).toBe(403); // no grant yet
    expect((await req('PUT', `/v1/admin/staff/${a.adminUserId}/permissions`, ownerToken, { permissions: { giftcards: true } })).status).toBe(200);
    const gc = await req('POST', '/v1/admin/gift-cards', a.token, g);
    expect(ok2xx(gc)).toBe(true);
    const gcId = ((await gc.json()) as { id: string }).id;
    expect(((await withStore(A, async (tx) => (await tx.execute(sql`SELECT enabled FROM gift_card WHERE id = ${gcId}`)).rows[0])) as { enabled: boolean }).enabled).toBe(false);
    // PATCH /gift-cards/{id} is requireManage (admin-marketing.ts), not the giftcards grant, so the PATCH half is proven with a manager-role agent
    const m = await createAgent(managerToken, { role: 'manager', name: 'Manager bot' });
    expect((await req('PATCH', `/v1/admin/gift-cards/${gcId}`, m.token, { enabled: true })).status).toBe(403);
    expect((await req('PATCH', `/v1/admin/gift-cards/${gcId}`, m.token, { adjust: 500 })).status).toBe(403);
    expect((await req('PATCH', `/v1/admin/gift-cards/${gcId}`, m.token, { enabled: false })).status).toBe(200); // disabling is reversible → allowed
    expect((await req('PATCH', `/v1/admin/gift-cards/${gcId}`, ownerToken, { enabled: true })).status).toBe(200);
    expect(((await withStore(A, async (tx) => (await tx.execute(sql`SELECT enabled, balance FROM gift_card WHERE id = ${gcId}`)).rows[0])) as { enabled: boolean; balance: number })).toEqual({ enabled: true, balance: 1000 });
    const d = (await (await req('POST', '/v1/admin/discounts', ownerToken, { code: 'AGENT10', type: 'percentage', value: 10 })).json()) as { id: string };
    expect((await req('DELETE', `/v1/admin/discounts/${d.id}`, a.token)).status).toBe(403);
    expect((await req('DELETE', `/v1/admin/discounts/${d.id}`, ownerToken)).status).toBe(200);
  });

  it('mixed route (D10): a draft with markPaid is refused for an agent and no order is created; the same body succeeds for the owner', async () => {
    const a = await createAgent();
    const before = await count(A, '"order"');
    const r = await req('POST', '/v1/admin/draft-orders', a.token, { items: [{ sku: 'SKU-A', quantity: 1 }], markPaid: true });
    expect([r.status, await errMessage(r)]).toEqual([403, expect.stringMatching(/agents cannot/)]);
    expect(await count(A, '"order"')).toBe(before);
    const d = await req('POST', '/v1/admin/draft-orders', a.token, { items: [{ sku: 'SKU-A', quantity: 1 }] });
    expect(((await d.json()) as { state: string }).state).toBe('PendingPayment');
    const h = await req('POST', '/v1/admin/draft-orders', ownerToken, { items: [{ sku: 'SKU-A', quantity: 1 }], markPaid: true });
    expect(((await h.json()) as { state: string }).state).toBe('Paid');
  });

  it('mixed route (D11): an order edit with settlement refund_now is refused for an agent even with the refunds grant', async () => {
    const a = await createAgent();
    expect((await req('PUT', `/v1/admin/staff/${a.adminUserId}/permissions`, ownerToken, { permissions: { refunds: true } })).status).toBe(200);
    const r = await req('POST', `/v1/admin/orders/${ORDER_EDIT}/edit/commit`, a.token, { ops: [{ op: 'set_address', kind: 'shipping', address: { line1: '2 New St', city: 'Austin', country: 'US' } }], expectedGrandTotal: 2000, idempotencyKey: 'agent-edit-refund', notifyCustomer: false, settlement: { type: 'refund_now' } });
    expect([r.status, await errMessage(r)]).toEqual([403, expect.stringMatching(/agents cannot/)]);
  });

  it('a human session can never carry a token binding (seeded invalid state is refused at resolution)', async () => {
    const a = await createAgent();
    const tok = (await ownerPool.query('SELECT id FROM admin_api_token LIMIT 1')).rows[0].id as string;
    await ownerPool.query('DELETE FROM "session" WHERE admin_user_id = $1', [STAFF]); // exactly one STAFF session, so the unique partial index admits the seeded binding
    const human = await createAdminSession(STAFF);
    await ownerPool.query('UPDATE "session" SET api_token_id = $1 WHERE admin_user_id = $2', [tok, STAFF]);
    expect((await req('GET', '/v1/admin/me', human)).status).toBe(401);
    expect((await req('GET', '/v1/admin/me', a.token)).status).toBe(200);
  });

  it('manager-role agent may change settings; re-role via the staff route works; owner is refused', async () => {
    const a = await createAgent(managerToken, { role: 'manager' });
    expect((await req('PATCH', '/v1/admin/settings/store', a.token, { name: 'Renamed by agent' })).status).toBe(200);
    expect((await req('PATCH', `/v1/admin/staff/${a.adminUserId}`, ownerToken, { role: 'staff' })).status).toBe(200);
    expect((await req('PATCH', '/v1/admin/settings/store', a.token, { name: 'again' })).status).toBe(403); // staff cannot manage
    expect((await req('PATCH', `/v1/admin/staff/${a.adminUserId}`, ownerToken, { role: 'owner' })).status).toBe(400);
  });

  it('owner controls: every denied request with a control succeeds for the owner on a fresh seed', async () => {
    for (const d of DENIED.filter((x) => x.control !== false)) {
      await wipe(); await seed();
      const r = await req(d.method, d.path, ownerToken, d.body);
      expect([d.method, d.path, ok2xx(r) ? 'ok' : `${r.status} ${await r.text()}`]).toEqual([d.method, d.path, 'ok']);
    }
  });

  it('billing address is stripped for agents on order detail; shipping stays', async () => {
    const a = await createAgent();
    const o = (await (await req('GET', `/v1/admin/orders/${ORDER_FULL}`, a.token)).json()) as { billingAddress: unknown; shippingAddress: unknown };
    expect(o.billingAddress).toBeNull(); expect(o.shippingAddress).toEqual({ line1: '1 Ship St' });
    const h = (await (await req('GET', `/v1/admin/orders/${ORDER_FULL}`, ownerToken)).json()) as { billingAddress: unknown };
    expect(h.billingAddress).toEqual({ line1: '1 Bill St' });
  });

  it('tenancy: store B is unreachable by slug and by foreign id, for bearer and for the bound cookie', async () => {
    const a = await createAgent();
    expect((await req('GET', '/v1/admin/orders', a.token, undefined, 'store-b')).status).toBe(403);
    if (NONOWNER) { // the foreign-id case is an RLS property; it is only meaningful on the unprivileged role (see tenant-resolution.db.test.ts)
      await expect(assertRuntimeRoleUnprivileged(pool)).resolves.toBeUndefined();
      expect((await req('PATCH', `/v1/admin/products/${PB}`, a.token, { name: 'stolen' })).status).toBe(404);
      expect(((await withStore(B, async (tx) => (await tx.execute(sql`SELECT name FROM product WHERE id = ${PB}`)).rows[0])) as { name: string }).name).toBe('PB');
    }
    const bs = await req('POST', '/v1/admin/agents/browser-session', a.token);
    const sr = /sr_admin=([^;]+)/.exec(bs.headers.get('set-cookie') ?? '')?.[1];
    expect((await app.request('/v1/admin/orders', { headers: { cookie: `sr_admin=${sr}`, 'x-store-slug': 'store-b' } })).status).toBe(403);
  });

  it('identity is immutable: no password login, invite, accept or revoke-sessions; SQL-forced owner is refused at resolution', async () => {
    const a = await createAgent();
    expect((await req('POST', '/v1/admin/login', a.token, { email: a.email, password: 'anything' })).status).toBe(401);
    expect((await req('POST', '/v1/admin/staff', ownerToken, { email: a.email, role: 'manager', password: 'password123' })).status).toBe(400);
    expect((await req('POST', '/v1/admin/staff/invites', ownerToken, { email: a.email, role: 'manager' })).status).toBe(400);
    expect((await req('POST', `/v1/admin/staff/${a.adminUserId}/revoke-sessions`, ownerToken)).status).toBe(400);
    await pool.query(`UPDATE admin_user_store SET role = 'owner' WHERE admin_user_id = $1`, [a.adminUserId]);
    expect((await req('GET', '/v1/admin/me', a.token)).status).toBe(401);
  });

  it('browser session: CSRF applies; allowed and denied mutations; exactly one live session survives a race; dies on rotate; expiry respected', async () => {
    const a = await createAgent(managerToken, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const [r1, r2] = await Promise.all([req('POST', '/v1/admin/agents/browser-session', a.token), req('POST', '/v1/admin/agents/browser-session', a.token)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(Number((await pool.query('SELECT count(*)::int AS n FROM "session" WHERE api_token_id IS NOT NULL')).rows[0].n)).toBe(1);
    const cookiesOf = (r: Response) => ({ sr: /sr_admin=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1], csrf: /sr_csrf=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1] });
    const alive = [];
    for (const r of [r1, r2]) { const { sr } = cookiesOf(r); if ((await app.request('/v1/admin/me', { headers: { cookie: `sr_admin=${sr}`, 'x-store-slug': 'store-a' } })).status === 200) alive.push(r); }
    expect(alive).toHaveLength(1);
    const { sr, csrf } = cookiesOf(alive[0]!);
    expect(((await alive[0]!.clone().json()) as { expiresInSeconds: number }).expiresInSeconds).toBeLessThanOrEqual(3600);
    const ck = (withCsrf: boolean) => ({ cookie: `sr_admin=${sr}; sr_csrf=${csrf}`, ...(withCsrf ? { 'x-csrf-token': csrf! } : {}), 'x-store-slug': 'store-a', 'content-type': 'application/json' });
    expect((await app.request('/v1/admin/products', { method: 'POST', headers: ck(false), body: JSON.stringify({ name: 'x' }) })).status).toBe(403); // CSRF
    expect((await app.request('/v1/admin/products', { method: 'POST', headers: ck(true), body: JSON.stringify({ name: 'x' }) })).status).toBe(200);
    expect((await app.request(`/v1/admin/products/${PA}`, { method: 'DELETE', headers: ck(true) })).status).toBe(403);
    const rot = (await (await req('POST', `/v1/admin/agents/${a.adminUserId}/rotate`, ownerToken)).json()) as { token: string; revoked: number };
    expect(rot.revoked).toBe(1);
    expect((await app.request('/v1/admin/me', { headers: { cookie: `sr_admin=${sr}`, 'x-store-slug': 'store-a' } })).status).toBe(401);
    expect((await req('GET', '/v1/admin/me', a.token)).status).toBe(401);
    expect((await pool.query('SELECT expires_at FROM admin_api_token WHERE token_hash = $1', [hashAgentToken(rot.token)])).rows[0].expires_at).not.toBeNull(); // D4
    const bs2 = await req('POST', '/v1/admin/agents/browser-session', rot.token);
    const sr2 = cookiesOf(bs2).sr;
    await pool.query(`UPDATE "session" SET expires_at = now() - interval '1 minute' WHERE api_token_id IS NOT NULL`);
    expect((await app.request('/v1/admin/me', { headers: { cookie: `sr_admin=${sr2}`, 'x-store-slug': 'store-a' } })).status).toBe(401);
    await pool.query(`UPDATE admin_api_token SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [hashAgentToken(rot.token)]);
    expect((await req('GET', '/v1/admin/me', rot.token)).status).toBe(401);
    expect((await req('POST', '/v1/admin/agents/browser-session', rot.token)).status).toBe(401);
    expect((await req('DELETE', `/v1/admin/agents/${a.adminUserId}`, ownerToken)).status).toBe(200);
    expect((await req('DELETE', `/v1/admin/agents/${a.adminUserId}`, ownerToken)).status).toBe(404);
    expect((await req('POST', '/v1/admin/agents/browser-session', ownerToken)).status).toBe(403);
  });

  it('bootstrap racing a rotate or a remove never leaves a session bound to a dead token', async () => {
    for (const op of ['rotate', 'remove'] as const) {
      await wipe(); await seed();
      const a = await createAgent();
      const [bs, lc] = await Promise.all([
        req('POST', '/v1/admin/agents/browser-session', a.token),
        op === 'rotate' ? req('POST', `/v1/admin/agents/${a.adminUserId}/rotate`, ownerToken) : req('DELETE', `/v1/admin/agents/${a.adminUserId}`, ownerToken),
      ]);
      expect([op, lc.status]).toEqual([op, 200]);
      expect([op, bs.status, [200, 401].includes(bs.status)]).toEqual([op, bs.status, true]); // bootstrap either won the lock (200, then dies) or lost it (401); never 5xx
      const sr = /sr_admin=([^;]+)/.exec(bs.headers.get('set-cookie') ?? '')?.[1];
      if (sr) expect((await app.request('/v1/admin/me', { headers: { cookie: `sr_admin=${sr}`, 'x-store-slug': 'store-a' } })).status).toBe(401);
      const stale = await pool.query(`SELECT count(*)::int AS n FROM "session" s JOIN admin_api_token t ON t.id = s.api_token_id WHERE t.revoked_at IS NOT NULL`);
      expect([op, Number(stale.rows[0].n)]).toEqual([op, 0]);
      expect((await req('GET', '/v1/admin/me', a.token)).status).toBe(401);
    }
    // and the human-side removal path: staff DELETE on an agent also revokes its tokens
    await wipe(); await seed();
    const b = await createAgent();
    expect((await req('DELETE', `/v1/admin/staff/${b.adminUserId}`, ownerToken)).status).toBe(200);
    expect((await req('GET', '/v1/admin/me', b.token)).status).toBe(401);
  });

  it('the DENIED fixture covers every deny group', () => {
    const groups = new Set([...AGENT_DENIED.values()]);
    for (const g of groups) expect([g, DENIED.some((d) => d.group === g)]).toEqual([g, true]);
  });
});
