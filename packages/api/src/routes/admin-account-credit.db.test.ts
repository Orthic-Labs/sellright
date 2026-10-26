/**
 * #395 account-credit operator routes: issue (email-bound), bulk issue, adjust, disable/enable,
 * permission gating, idempotent replay and the audit trail. Mirrors admin-seo.db.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { adminAccountCredit } from './admin-account-credit.js';
import { redeem, reserve } from '../account-credit/service.js';
import * as schema from '../db/schema.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-account-credit.db.test.ts');

const STORE = 'cccccccc-0000-0000-0000-0000000003c1';
const SLUG = 'admin-credit-test-store';
const OWNER = 'cccccccc-0000-0000-0000-0000000003c2';
const STAFF = 'cccccccc-0000-0000-0000-0000000003c3';

const app = new OpenAPIHono();
app.route('/', adminAccountCredit);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}
async function seed() {
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, $2, 'Credit Test Store', 'USD') ON CONFLICT (id) DO NOTHING`, [STORE, SLUG]);
  for (const [id, email, role] of [[OWNER, 'owner@credit.test', 'owner'], [STAFF, 'staff@credit.test', 'staff']] as const) {
    await pool.query(`INSERT INTO admin_user (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, email]);
    await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, STORE, role]);
  }
  return { owner: await createAdminSession(OWNER), staff: await createAdminSession(STAFF) };
}
const req = (token: string, method: string, path: string, body?: Record<string, unknown>) => app.request(path, {
  method, headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});
const auditActions = () => withStore(STORE, async (tx) =>
  (await tx.execute(sql`SELECT action FROM audit_log WHERE entity = 'account_credit' ORDER BY at, id`)).rows.map((r) => (r as { action: string }).action));

type Acct = { id: string; code: string; email: string; balance: number; disabled: boolean };
async function issueOne(token: string, over: Record<string, unknown> = {}) {
  const res = await req(token, 'POST', '/v1/admin/account-credit/issue',
    { email: 'Buyer@Example.test', amountCents: 5000, issuanceKey: 'issue-key-0001', reason: 'goodwill', ...over });
  return { res, body: await res.json() as { account: Acct; created: boolean } };
}

describe('admin account credit', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('issues an email-bound credit once per issuanceKey and audits it', async () => {
    const { owner } = await seed();
    const first = await issueOne(owner);
    expect(first.res.status).toBe(200);
    expect(first.body).toMatchObject({ created: true, account: { email: 'buyer@example.test', balance: 5000, disabled: false } });
    expect(first.body.account.code).toMatch(/^ACC-/);
    const replay = await issueOne(owner);
    expect(replay.body).toMatchObject({ created: false, account: { id: first.body.account.id } });
    expect(await auditActions()).toEqual(['account_credit_issue']);
    const conflict = await issueOne(owner, { amountCents: 6000 });
    expect(conflict.res.status).toBe(409);
  });

  it('gates every route on the account_credit permission (staff without it is refused)', async () => {
    const { staff } = await seed();
    expect((await req(staff, 'GET', '/v1/admin/account-credit')).status).toBe(403);
    expect((await issueOne(staff)).res.status).toBe(403);
  });

  it('adjusts, replays an operationKey once, refuses to go negative, and audits', async () => {
    const { owner } = await seed();
    const { body } = await issueOne(owner);
    const id = body.account.id;
    const adjust = (deltaCents: number, operationKey: string) =>
      req(owner, 'POST', `/v1/admin/account-credit/${id}/adjust`, { deltaCents, operationKey, reason: 'correction' });
    expect((await adjust(-1000, 'adjust-key-001')).status).toBe(200);
    const replay = await adjust(-1000, 'adjust-key-001');
    expect((await replay.json() as { account: Acct }).account.balance).toBe(4000);
    expect((await adjust(-9000, 'adjust-key-002')).status).toBe(409);
    expect(await auditActions()).toEqual(['account_credit_issue', 'account_credit_adjust']);
  });

  it('disables and re-enables with an audit row each', async () => {
    const { owner } = await seed();
    const id = (await issueOne(owner)).body.account.id;
    const toggle = (disabled: boolean, operationKey: string) =>
      req(owner, 'POST', `/v1/admin/account-credit/${id}/status`, { disabled, operationKey, reason: 'support request' });
    expect(((await (await toggle(true, 'status-key-01')).json()) as { account: Acct }).account.disabled).toBe(true);
    expect(((await (await toggle(false, 'status-key-02')).json()) as { account: Acct }).account.disabled).toBe(false);
    expect(await auditActions()).toEqual(['account_credit_issue', 'account_credit_disable', 'account_credit_enable']);
    const detail = await req(owner, 'GET', `/v1/admin/account-credit/${id}`);
    const kinds = ((await detail.json()) as { ledger: Array<{ kind: string }> }).ledger.map((l) => l.kind).sort();
    expect(kinds).toEqual(['DISABLE', 'ENABLE', 'ISSUE']);
  });

  it('bulk issue previews first, then applies only with the previewed digest', async () => {
    const { owner } = await seed();
    const rows = [{ email: 'a@example.test', amountCents: 1000 }, { email: 'b@example.test', amountCents: 2500 }];
    const post = (extra: Record<string, unknown>) => req(owner, 'POST', '/v1/admin/account-credit/issue-batch', { batch: 'goodwill-1', rows, reason: 'batch', ...extra });
    const preview = await (await post({ apply: false })).json() as { applied: boolean; digest: string; totalCents: number };
    expect(preview).toMatchObject({ applied: false, totalCents: 3500 });
    expect((await post({ apply: true, digest: 'f'.repeat(64) })).status).toBe(400);
    const applied = await (await post({ apply: true, digest: preview.digest })).json() as { applied: boolean; issued: unknown[] };
    expect(applied.applied).toBe(true);
    expect(applied.issued).toHaveLength(2);
    // Re-running the same batch is a no-op replay.
    const again = await (await post({ apply: true, digest: preview.digest })).json() as { issued: Array<{ created: boolean }> };
    expect(again.issued.every((r) => !r.created)).toBe(true);
    expect((await auditActions()).filter((a) => a === 'account_credit_issue')).toHaveLength(2);
  });

  it('manually restores one returned unit of an order that redeemed the credit, once per operationKey', async () => {
    const { owner, staff } = await seed();
    const id = (await issueOne(owner, { amountCents: 1000 })).body.account.id;
    const { orderCode, lineId } = await withStore(STORE, async (tx) => {
      const promotionId = ((await tx.execute(sql`SELECT promotion_id FROM account_credit WHERE id = ${id}`)).rows[0] as { promotion_id: string }).promotion_id;
      const [o] = await tx.insert(schema.order).values({ storeId: STORE, code: 'CREDIT-RESTORE-1', currency: 'USD', promotionId, subtotal: 1500, discountTotal: 101, grandTotal: 1399 }).returning();
      const [line] = await tx.insert(schema.orderLine).values({ storeId: STORE, orderId: o!.id, variantSku: 'SYNTHETIC', variantName: 'Synthetic item',
        quantity: 3, unitPrice: 500, lineSubtotal: 1500, lineDiscount: 101, lineTotal: 1399 }).returning();
      await reserve(tx, { storeId: STORE, orderId: o!.id, accountId: id, appliedAmount: 101, phase: 'ArrangingPayment' });
      await tx.insert(schema.payment).values({ storeId: STORE, orderId: o!.id, amount: 1399, method: 'synthetic', state: 'Settled', currency: 'USD' });
      await tx.update(schema.order).set({ state: 'Paid' }).where(sql`id = ${o!.id}`);
      await redeem(tx, { storeId: STORE, orderId: o!.id, appliedAmount: 101, allocation: { [line!.id]: [34, 34, 33] } });
      return { orderCode: o!.code, lineId: line!.id };
    });
    const body = { orderCode, orderLineId: lineId, quantity: 1, expectedCents: 34, operationKey: 'restore-key-01', reason: 'returned unit' };
    expect((await req(staff, 'POST', `/v1/admin/account-credit/${id}/restore`, body)).status).toBe(403);
    const first = await req(owner, 'POST', `/v1/admin/account-credit/${id}/restore`, body);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ restoredCents: 34, account: { id, balance: 933 } });
    const replay = await req(owner, 'POST', `/v1/admin/account-credit/${id}/restore`, body);
    expect(await replay.json()).toMatchObject({ restoredCents: 34, account: { balance: 933 } });
    expect(await auditActions()).toEqual(['account_credit_issue', 'account_credit_restore']);
  });
});
