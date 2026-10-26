/**
 * Admin account-credit operator tooling (issue #395). The previous the previous platform store had
 * operator scripts (account-credit/scripts: issue-test-credit.ts, import-credits.ts,
 * maintain-credit.ts); SellRight had only the service functions. This is the admin
 * surface over those functions — issue (email-bound), bulk issue, adjust,
 * disable/enable and manual restore — and every mutation writes audit_log in the
 * same transaction. Mutations are human-only and need the `account_credit`
 * permission (owner/manager always pass); reads need it too because a credit's
 * coupon code is spendable.
 *
 * Idempotency: adjust/status/restore take a client-generated `operationKey` (the
 * service replays a repeated key instead of posting twice); issue takes an
 * `issuanceKey`. The admin page generates a fresh key per submit.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import { LockSetUnstable, orderIdByCode, withLockedSet } from '../db/locks.js';
import * as s from '../db/schema.js';
import { adjust, disable, issue, restoreManual } from '../account-credit/service.js';
import { MAX_CREDIT_CENTS, normalizeCreditEmail } from '../account-credit/math.js';
import { AccountCreditError } from '../account-credit/types.js';
import { HttpError, J, errBody, guard, requireAdmin, requireHuman, requirePermission, requireStore, requireWrite } from './admin-helpers.js';

export const adminAccountCredit = new OpenAPIHono();

const UuidShape = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const Cents = z.number().int().min(1).max(MAX_CREDIT_CENTS);
const Reason = z.string().trim().min(3).max(255);
const Key = z.string().trim().min(8).max(120);
const MAX_BATCH = 500;

function httpFor(e: unknown): never {
  if (e instanceof AccountCreditError) {
    const status = e.code === 'invalid_input' ? 400 : e.code === 'missing' ? 404 : 409;
    throw new HttpError(status, e.message, `account_credit_${e.code}`);
  }
  if (e instanceof LockSetUnstable) throw new HttpError(409, 'credit account is busy, retry shortly');
  throw e;
}

async function audit(tx: Tx, storeId: string, actor: string, accountId: string, action: string, data: Record<string, unknown>) {
  await tx.insert(s.auditLog).values({ storeId, actor, entity: 'account_credit', entityId: accountId, action, data });
}
const alreadyPosted = async (tx: Tx, storeId: string, key: string) => {
  const [row] = await tx.select({ id: s.accountCreditTransaction.id }).from(s.accountCreditTransaction)
    .where(and(eq(s.accountCreditTransaction.storeId, storeId), eq(s.accountCreditTransaction.idempotencyKey, key))).limit(1);
  return !!row;
};

const AccountView = z.object({
  id: z.string(), code: z.string().nullable(), email: z.string(), currency: z.string(),
  initialAmount: z.number().int(), balance: z.number().int(), held: z.number().int(), available: z.number().int(),
  disabled: z.boolean(), createdAt: z.string(),
});
type Row = {
  id: string; code: string | null; email: string; currency: string; initialAmount: number; balance: number;
  held: number; disabled: boolean; createdAt: Date;
};
const view = (r: Row) => ({
  id: r.id, code: r.code, email: r.email, currency: r.currency, initialAmount: r.initialAmount, balance: r.balance,
  held: r.held, available: r.balance - r.held, disabled: r.disabled, createdAt: r.createdAt.toISOString(),
});
/** Account columns + coupon code + pending-hold total. */
const accountSelect = (tx: Tx, storeId: string) => tx.select({
  id: s.accountCredit.id, code: s.promotion.code, email: s.accountCredit.emailNormalized, currency: s.accountCredit.currency,
  initialAmount: s.accountCredit.initialAmount, balance: s.accountCredit.balance, disabled: s.accountCredit.disabled,
  createdAt: s.accountCredit.createdAt,
  held: sql<number>`coalesce((SELECT sum(t.amount) FROM account_credit_transaction t WHERE t.store_id = ${storeId}
    AND t.account_credit_id = ${s.accountCredit.id} AND t.kind = 'RESERVE' AND t.status = 'PENDING'), 0)::int`,
}).from(s.accountCredit).innerJoin(s.promotion, eq(s.promotion.id, s.accountCredit.promotionId));
async function loadAccount(tx: Tx, storeId: string, id: string) {
  const [row] = await accountSelect(tx, storeId)
    .where(and(eq(s.accountCredit.storeId, storeId), eq(s.accountCredit.id, id))).limit(1);
  return row ? view(row as Row) : null;
}

// ── list / search ────────────────────────────────────────────────────────────
adminAccountCredit.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/account-credit', summary: 'List/search account credits (by email or coupon code)',
    request: { query: z.object({ q: z.string().trim().max(200).optional() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(AccountView) })) },
      401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requirePermission(st, 'account_credit');
    const q = c.req.valid('query').q?.toLowerCase();
    const items = await withStore(st.storeId, async (tx) => {
      const where = q
        ? and(eq(s.accountCredit.storeId, st.storeId),
          sql`(${s.accountCredit.emailNormalized} like ${'%' + q.replace(/[\\%_]/g, '\\$&') + '%'} OR lower(${s.promotion.code}) = ${q})`)
        : eq(s.accountCredit.storeId, st.storeId);
      const rows = await accountSelect(tx, st.storeId).where(where).orderBy(desc(s.accountCredit.createdAt)).limit(100);
      return rows.map((r) => view(r as Row));
    });
    return c.json({ items }, 200);
  }),
);

// ── detail: ledger + redeemed orders (lines + per-unit credit, to prepare a manual restore) ──
const Ledger = z.object({
  id: z.string(), kind: z.string(), status: z.string(), amount: z.number().int(), delta: z.number().int(),
  balanceAfter: z.number().int().nullable(), reason: z.string().nullable(), actor: z.string().nullable(),
  orderCode: z.string().nullable(), createdAt: z.string(),
});
const RedeemedOrder = z.object({
  orderId: z.string(), orderCode: z.string().nullable(),
  lines: z.array(z.object({ id: z.string(), name: z.string(), quantity: z.number().int(), unitCreditCents: z.array(z.number().int()) })),
});
adminAccountCredit.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/account-credit/{id}', summary: 'Account credit detail with ledger',
    request: { params: z.object({ id: UuidShape }) },
    responses: { 200: { description: 'OK', content: J(z.object({ account: AccountView, ledger: z.array(Ledger), redeemedOrders: z.array(RedeemedOrder) })) },
      404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requirePermission(st, 'account_credit');
    const { id } = c.req.valid('param');
    const out = await withStore(st.storeId, async (tx) => {
      const account = await loadAccount(tx, st.storeId, id);
      if (!account) return null;
      const rows = await tx.select().from(s.accountCreditTransaction).where(and(
        eq(s.accountCreditTransaction.storeId, st.storeId), eq(s.accountCreditTransaction.accountCreditId, id)))
        .orderBy(desc(s.accountCreditTransaction.createdAt)).limit(200);
      const redeemedOrders: z.infer<typeof RedeemedOrder>[] = [];
      for (const r of rows.filter((x) => x.kind === 'REDEEM' && x.status === 'POSTED' && x.orderId)) {
        const lines = await tx.select({ id: s.orderLine.id, name: s.orderLine.variantName, quantity: s.orderLine.quantity })
          .from(s.orderLine).where(and(eq(s.orderLine.storeId, st.storeId), eq(s.orderLine.orderId, r.orderId!)));
        redeemedOrders.push({ orderId: r.orderId!, orderCode: r.orderCode, lines: lines.map((l) => ({ ...l, unitCreditCents: r.operationalAllocation?.[l.id] ?? [] })) });
      }
      return { account, redeemedOrders, ledger: rows.map((r) => ({
        id: r.id, kind: r.kind, status: r.status, amount: r.amount, delta: r.delta, balanceAfter: r.balanceAfter,
        reason: r.reason, actor: r.actor, orderCode: r.orderCode, createdAt: r.createdAt.toISOString(),
      })) };
    });
    if (!out) throw new HttpError(404, 'credit account not found');
    return c.json(out, 200);
  }),
);

// ── issue (email-bound) ──────────────────────────────────────────────────────
adminAccountCredit.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/account-credit/issue', summary: 'Issue account credit to an email address',
    request: { body: { content: J(z.object({
      email: z.string().trim().min(3).max(320), amountCents: Cents, issuanceKey: Key,
      code: z.string().trim().min(3).max(200).optional(), reason: Reason,
    })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ account: AccountView, created: z.boolean() })) },
      400: { description: 'Invalid', ...errBody }, 409: { description: 'Conflict', ...errBody },
      401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requireHuman(admin); requirePermission(st, 'account_credit');
    const b = c.req.valid('json');
    try {
      const res = await withStore(st.storeId, async (tx) => {
        const r = await issue(tx, { storeId: st.storeId, email: b.email, amount: b.amountCents, issuanceKey: b.issuanceKey, code: b.code });
        if (r.created) await audit(tx, st.storeId, admin.email, r.account.id, 'account_credit_issue',
          { email: normalizeCreditEmail(b.email), amountCents: b.amountCents, code: r.code, issuanceKey: b.issuanceKey, reason: b.reason });
        return { created: r.created, account: (await loadAccount(tx, st.storeId, r.account.id))! };
      });
      return c.json(res, 200);
    } catch (e) { return httpFor(e); }
  }),
);

// ── bulk issue (import-credits.ts): preview, then apply with the previewed digest ──
const BatchRow = z.object({ email: z.string().trim().min(3).max(320), amountCents: Cents });
adminAccountCredit.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/account-credit/issue-batch',
    summary: 'Bulk-issue account credit (apply=false previews and returns the digest; apply=true requires it)',
    request: { body: { content: J(z.object({
      batch: z.string().regex(/^[\w-]{1,60}$/), rows: z.array(BatchRow).min(1).max(MAX_BATCH),
      apply: z.boolean().default(false), digest: z.string().length(64).optional(), reason: Reason,
    })) } },
    responses: { 200: { description: 'OK', content: J(z.object({
      applied: z.boolean(), count: z.number().int(), totalCents: z.number().int(), digest: z.string(),
      errors: z.array(z.string()),
      issued: z.array(z.object({ row: z.number().int(), email: z.string(), amountCents: z.number().int(), accountId: z.string(), code: z.string(), created: z.boolean() })),
    })) }, 400: { description: 'Invalid', ...errBody }, 409: { description: 'Conflict', ...errBody },
    401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requireHuman(admin); requirePermission(st, 'account_credit');
    const b = c.req.valid('json');
    const errors: string[] = [];
    const seen = new Set<string>();
    const rows = b.rows.map((r, i) => {
      let email = r.email;
      try { email = normalizeCreditEmail(r.email); } catch { errors.push(`Row ${i + 1}: invalid email`); }
      if (seen.has(email)) errors.push(`Row ${i + 1}: duplicate email`);
      seen.add(email);
      return { row: i + 1, email, amountCents: r.amountCents };
    });
    const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    const totalCents = rows.reduce((n, r) => n + r.amountCents, 0);
    const base = { count: rows.length, totalCents, digest, errors };
    if (!b.apply || errors.length) return c.json({ ...base, applied: false, issued: [] }, 200);
    if (b.digest !== digest) throw new HttpError(400, 'digest does not match the previewed rows');
    try {
      const issued = await withStore(st.storeId, async (tx) => {
        // A batch key that already belongs to different input must never be reused (import-credits.ts parity).
        const prefix = `${b.batch}:`;
        const prior = await tx.select({ key: s.accountCredit.issuanceKey, email: s.accountCredit.emailNormalized, amount: s.accountCredit.initialAmount })
          .from(s.accountCredit).where(and(eq(s.accountCredit.storeId, st.storeId), like(s.accountCredit.issuanceKey, prefix.replace(/[\\%_]/g, '\\$&') + '%')));
        const expected = new Map(rows.map((r) => [`${b.batch}:${digest}:${r.row}`, r]));
        for (const p of prior) {
          const r = expected.get(p.key);
          if (!r || r.email !== p.email || r.amountCents !== p.amount) throw new HttpError(409, 'Batch key already belongs to different input; no credits issued');
        }
        const out: Array<{ row: number; email: string; amountCents: number; accountId: string; code: string; created: boolean }> = [];
        for (const r of rows) {
          const res = await issue(tx, { storeId: st.storeId, email: r.email, amount: r.amountCents, issuanceKey: `${b.batch}:${digest}:${r.row}` });
          if (res.created) await audit(tx, st.storeId, admin.email, res.account.id, 'account_credit_issue',
            { email: r.email, amountCents: r.amountCents, code: res.code, batch: b.batch, row: r.row, reason: b.reason });
          out.push({ row: r.row, email: r.email, amountCents: r.amountCents, accountId: res.account.id, code: res.code, created: res.created });
        }
        return out;
      });
      return c.json({ ...base, applied: true, issued }, 200);
    } catch (e) { return httpFor(e); }
  }),
);

// ── adjust ───────────────────────────────────────────────────────────────────
adminAccountCredit.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/account-credit/{id}/adjust', summary: 'Adjust an account credit balance (signed cents)',
    request: { params: z.object({ id: UuidShape }), body: { content: J(z.object({
      deltaCents: z.number().int().min(-MAX_CREDIT_CENTS).max(MAX_CREDIT_CENTS).refine((n) => n !== 0, 'delta must be non-zero'),
      operationKey: Key, reason: Reason,
    })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ account: AccountView })) }, 404: { description: 'Not found', ...errBody },
      409: { description: 'Conflict', ...errBody }, 401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requireHuman(admin); requirePermission(st, 'account_credit');
    const { id } = c.req.valid('param'); const b = c.req.valid('json');
    try {
      const account = await withStore(st.storeId, async (tx) => {
        const before = await loadAccount(tx, st.storeId, id);
        if (!before) throw new HttpError(404, 'credit account not found');
        const replay = await alreadyPosted(tx, st.storeId, `adjust:${b.operationKey}`);
        const after = await adjust(tx, { storeId: st.storeId, accountId: id, delta: b.deltaCents, operationKey: b.operationKey, actor: admin.email, reason: b.reason });
        if (!replay) await audit(tx, st.storeId, admin.email, id, 'account_credit_adjust',
          { deltaCents: b.deltaCents, balanceBefore: before.balance, balanceAfter: after.balance, operationKey: b.operationKey, reason: b.reason });
        return (await loadAccount(tx, st.storeId, id))!;
      });
      return c.json({ account }, 200);
    } catch (e) { return httpFor(e); }
  }),
);

// ── disable / enable ─────────────────────────────────────────────────────────
adminAccountCredit.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/account-credit/{id}/status', summary: 'Disable or re-enable an account credit',
    request: { params: z.object({ id: UuidShape }), body: { content: J(z.object({ disabled: z.boolean(), operationKey: Key, reason: Reason })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ account: AccountView })) }, 404: { description: 'Not found', ...errBody },
      409: { description: 'Conflict', ...errBody }, 401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requireHuman(admin); requirePermission(st, 'account_credit');
    const { id } = c.req.valid('param'); const b = c.req.valid('json');
    try {
      const account = await withStore(st.storeId, async (tx) => {
        const before = await loadAccount(tx, st.storeId, id);
        if (!before) throw new HttpError(404, 'credit account not found');
        const replay = await alreadyPosted(tx, st.storeId, `status:${b.operationKey}`);
        await disable(tx, { storeId: st.storeId, accountId: id, disabled: b.disabled, operationKey: b.operationKey, actor: admin.email, reason: b.reason });
        if (!replay) await audit(tx, st.storeId, admin.email, id, b.disabled ? 'account_credit_disable' : 'account_credit_enable',
          { disabledBefore: before.disabled, disabledAfter: b.disabled, operationKey: b.operationKey, reason: b.reason });
        return (await loadAccount(tx, st.storeId, id))!;
      });
      return c.json({ account }, 200);
    } catch (e) { return httpFor(e); }
  }),
);

// ── manual restore (maintain-credit.ts --op restore) ─────────────────────────
adminAccountCredit.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/account-credit/{id}/restore',
    summary: 'Manually restore credit for returned units of an order that redeemed this credit',
    request: { params: z.object({ id: UuidShape }), body: { content: J(z.object({
      orderCode: z.string().trim().min(1).max(100), orderLineId: UuidShape, quantity: z.number().int().min(1).max(100000),
      expectedCents: z.number().int().min(0).max(MAX_CREDIT_CENTS), operationKey: Key, reason: Reason,
    })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ account: AccountView, restoredCents: z.number().int() })) },
      404: { description: 'Not found', ...errBody }, 409: { description: 'Conflict', ...errBody },
      401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requireHuman(admin); requirePermission(st, 'account_credit');
    const { id } = c.req.valid('param'); const b = c.req.valid('json');
    const orderId = await orderIdByCode(st.storeId, b.orderCode);
    if (!orderId) throw new HttpError(404, 'order not found');
    try {
      // Order locks before account locks (service contract): the order set first, then the service takes the account.
      const res = await withLockedSet(st.storeId, { kind: 'order', orderId }, async (tx) => {
        const before = await loadAccount(tx, st.storeId, id);
        if (!before) throw new HttpError(404, 'credit account not found');
        const replay = await alreadyPosted(tx, st.storeId, `manual:${b.operationKey}`);
        const entry = await restoreManual(tx, { storeId: st.storeId, accountId: id, orderId, orderLineId: b.orderLineId, quantity: b.quantity,
          expectedCents: b.expectedCents, operationKey: b.operationKey, actor: admin.email, reason: b.reason });
        const after = (await loadAccount(tx, st.storeId, id))!;
        if (!replay) await audit(tx, st.storeId, admin.email, id, 'account_credit_restore',
          { orderCode: b.orderCode, orderId, orderLineId: b.orderLineId, quantity: b.quantity, restoredCents: entry.amount,
            balanceBefore: before.balance, balanceAfter: after.balance, operationKey: b.operationKey, reason: b.reason });
        return { account: after, restoredCents: entry.amount };
      });
      return c.json(res, 200);
    } catch (e) { return httpFor(e); }
  }),
);
