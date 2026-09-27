/**
 * Admin loyalty points (LOYALTY-1): program settings (store.config.loyalty),
 * per-customer balance + ledger, and permission-gated manual adjustments.
 * Every mutation writes audit_log in the same transaction.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { LoyaltySettingsSchema, loyaltySettingsFromConfig, pointsToCents } from '../money/loyalty.js';
import { adjustPoints, ledgerPage, loyaltyBalance, LoyaltyAdjustError } from '../loyalty/ledger.js';
import { mutateStoreConfig } from './admin-settings.js';
import { HttpError, J, errBody, guard, requireAdmin, requireManage, requirePermission, requireStore, requireWrite } from './admin-helpers.js';

export const adminLoyalty = new OpenAPIHono();

const Settings = LoyaltySettingsSchema;
// Shape-checked uuid (any version — ids come from gen_random_uuid and the
// importer's deterministic ids) so a malformed id is a 400, never a PG cast error.
const CustomerId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

adminLoyalty.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/loyalty/settings', summary: 'Loyalty program settings',
    responses: { 200: { description: 'OK', content: J(Settings) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const [row] = await withStore(st.storeId, (tx) => tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1));
    return c.json(loyaltySettingsFromConfig(row?.config), 200);
  }),
);

adminLoyalty.openapi(
  createRoute({
    method: 'put', path: '/v1/admin/loyalty/settings', summary: 'Update loyalty program settings',
    request: { body: { content: J(Settings) } },
    responses: { 200: { description: 'OK', content: J(Settings) }, 401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requireManage(st);
    const b = c.req.valid('json');
    const next = await mutateStoreConfig(st.storeId, (config) => ({ ...config, loyalty: b }), {
      actor: admin.email,
      action: 'settings_update',
      // Settings are plain numbers/booleans — no secrets — so the whole
      // before/after block is safe to persist.
      detail: (prev) => ({ section: 'loyalty', before: loyaltySettingsFromConfig(prev), after: b }),
    });
    return c.json(loyaltySettingsFromConfig(next), 200);
  }),
);

const LedgerRow = z.object({
  id: z.string(), kind: z.string(), points: z.number().int(), shortfall: z.number().int(),
  reason: z.string().nullable(), actor: z.string().nullable(), orderCode: z.string().nullable(),
  expiresAt: z.string().nullable(), createdAt: z.string(),
});
const CustomerLoyalty = z.object({
  customerId: z.string(), enabled: z.boolean(),
  balance: z.number().int(), available: z.number().int(), pendingExpiry: z.number().int(),
  availableValue: z.number().int(), ledger: z.array(LedgerRow),
});

async function customerLoyalty(storeId: string, customerId: string) {
  return withStore(storeId, async (tx) => {
    const [cust] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.id, customerId)).limit(1);
    if (!cust) return null;
    const [st] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
    const program = loyaltySettingsFromConfig(st?.config);
    const bal = await loyaltyBalance(tx, customerId);
    const rows = await ledgerPage(tx, customerId, 200);
    return {
      customerId, enabled: program.enabled, balance: bal.balance, available: bal.available, pendingExpiry: bal.pendingExpiry,
      availableValue: pointsToCents(bal.available, program.pointsPerDollarOff),
      ledger: rows.map((r) => ({ ...r, orderCode: r.orderCode ?? null, expiresAt: r.expiresAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() })),
    };
  });
}

adminLoyalty.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/customers/{id}/loyalty', summary: "Customer's points balance + ledger",
    request: { params: z.object({ id: CustomerId }) },
    responses: { 200: { description: 'OK', content: J(CustomerLoyalty) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const out = await customerLoyalty(st.storeId, c.req.valid('param').id);
    if (!out) throw new HttpError(404, 'customer not found');
    return c.json(out, 200);
  }),
);

adminLoyalty.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/customers/{id}/loyalty/adjust', summary: 'Manually add or remove points',
    request: {
      params: z.object({ id: CustomerId }),
      body: { content: J(z.object({
        points: z.number().int().min(-100_000_000).max(100_000_000).refine((n) => n !== 0, 'points must be non-zero'),
        reason: z.string().trim().min(3).max(500),
        idempotencyKey: z.string().min(8).max(200).optional(),
      })) },
    },
    responses: {
      200: { description: 'OK', content: J(CustomerLoyalty) },
      404: { description: 'Not found', ...errBody }, 409: { description: 'Insufficient points', ...errBody },
      401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requirePermission(st, 'loyalty');
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const res = await withStore(st.storeId, async (tx) => {
      const [cust] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.id, id)).limit(1);
      if (!cust) return { kind: 'notfound' as const };
      const [store] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1);
      try {
        const adj = await adjustPoints(tx, { storeId: st.storeId, customerId: id, points: b.points, reason: b.reason,
          actor: admin.email, idempotencyKey: b.idempotencyKey ?? null, expiryDays: loyaltySettingsFromConfig(store?.config).expiryDays });
        if (adj.id) {
          await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'customer', entityId: id,
            action: 'loyalty_adjust', data: { ledgerId: adj.id, points: b.points, reason: b.reason, balanceAfter: adj.balance.balance } });
        }
        return { kind: 'ok' as const };
      } catch (e) {
        if (e instanceof LoyaltyAdjustError) return { kind: 'conflict' as const, message: e.message };
        throw e;
      }
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'customer not found');
    if (res.kind === 'conflict') throw new HttpError(409, res.message);
    return c.json((await customerLoyalty(st.storeId, id))!, 200);
  }),
);
