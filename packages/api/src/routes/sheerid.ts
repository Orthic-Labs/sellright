/**
 * PAR-04: SheerID verification lifecycle routes.
 *
 *   POST /v1/shop/sheerid/start            — customer session → pending row + hosted verify URL
 *   GET  /v1/shop/sheerid/status           — customer session → current trusted categories
 *   POST /v1/webhooks/sheerid/{storeId}    — SheerID push (x-sheerid-signature HMAC, raw body)
 *   GET  /v1/admin/sheerid/config          — configured? (secrets never echoed)
 *   PATCH /v1/admin/sheerid/config         — store.config.sheerid (requireManage)
 *   GET  /v1/admin/sheerid/verifications   — operator list of verification rows
 *   POST /v1/admin/sheerid/revoke          — strip a category → coupon eligibility flips
 *   GET  /v1/admin/customers/{id}/verification        — a customer's verification state + history
 *   POST /v1/admin/customers/{id}/verification/clear  — clear all (or one) category, audited
 *
 * The webhook path is mounted outside /v1/shop and /v1/admin CSRF guards (same
 * as /v1/webhooks/stripe): the HMAC signature IS the authentication.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { sheeridVerification } from '../db/schema-ops.js';
import { resolveStoreFromCtx } from './store-context.js';
import { customerToken, resolveCustomer } from '../auth/session.js';
import { HttpError, J, errBody, guard, hasPermission, requireAdmin, requireManage, requirePermission, requireStore, requireWrite } from './admin-helpers.js';
import {
  applyVerificationDetails, clearVerification, fetchVerificationDetails, recomputeCustomerVerifications,
  revokeVerification, sheeridConfig, sheeridProgram, startVerification,
  SheerIdClient,
} from '../sheerid/service.js';

export const sheeridRoutes = new OpenAPIHono();

/** Staff permission key (owner/manager always pass) guarding verification revoke/clear. */
export const VERIFICATION_PERMISSION = 'customer_verification';

// ── shop: start ──────────────────────────────────────────────────────────────
sheeridRoutes.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/sheerid/start',
    summary: 'Start a SheerID verification (returns the hosted verify URL)',
    request: { body: { content: J(z.object({ programId: z.string().min(1).max(128).optional() })) } },
    responses: {
      200: { description: 'OK', content: J(z.object({ verificationId: z.string(), verificationUrl: z.string() })) },
      401: { description: 'Unauthenticated', ...errBody },
      409: { description: 'Not configured', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const st = await resolveStoreFromCtx(c);
    const cfg = sheeridConfig(st.config);
    const programId = sheeridProgram(cfg, c.req.valid('json').programId);
    if (!cfg || !programId) throw new HttpError(409, 'SheerID is not configured for this store');
    const out = await withStore(st.id, async (tx) => {
      const cust = await resolveCustomer(tx, customerToken(c) ?? '');
      if (!cust) return null;
      const { id } = await startVerification(tx, st.id, cust.id, programId);
      const url = new SheerIdClient(cfg).verificationUrl(programId, cust.id);
      return { verificationId: id, verificationUrl: url };
    });
    if (!out) throw new HttpError(401, 'not authenticated');
    return c.json(out, 200);
  }),
);

// ── shop: status ─────────────────────────────────────────────────────────────
sheeridRoutes.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/sheerid/status',
    summary: "Current customer's verification status",
    responses: {
      200: { description: 'OK', content: J(z.object({ activeVerifications: z.array(z.string()), verifications: z.array(z.unknown()) })) },
      401: { description: 'Unauthenticated', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const st = await resolveStoreFromCtx(c);
    const out = await withStore(st.id, async (tx) => {
      const cust = await resolveCustomer(tx, customerToken(c) ?? '');
      if (!cust) return null;
      // Recompute lazily so an expired row drops out of the response even if
      // the sweep job hasn't run yet.
      const active = await recomputeCustomerVerifications(tx, st.id, cust.id);
      const rows = await tx.select({
        programId: sheeridVerification.programId, category: sheeridVerification.category,
        status: sheeridVerification.status, expiresAt: sheeridVerification.expiresAt,
        createdAt: sheeridVerification.createdAt,
      }).from(sheeridVerification)
        .where(and(eq(sheeridVerification.customerId, cust.id)))
        .orderBy(desc(sheeridVerification.createdAt));
      return {
        activeVerifications: active,
        verifications: rows.map((r) => ({ ...r, expiresAt: r.expiresAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() })),
      };
    });
    if (!out) throw new HttpError(401, 'not authenticated');
    return c.json(out, 200);
  }),
);

// ── webhook: SheerID pushes the completed verificationId ─────────────────────
// Signature: hex HMAC-SHA256 of the RAW request body with the store's
// config.sheerid.webhookSecret (SheerID webhook token). Unconfigured secret →
// reject everything (fail closed, like DD's controller).
sheeridRoutes.post('/v1/webhooks/sheerid/:storeId', async (c) => {
  const storeId = c.req.param('storeId');
  if (!z.string().uuid().safeParse(storeId).success) return c.json({ error: 'unknown store' }, 404);
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > 262144) return c.json({ error: 'payload too large' }, 413);
  const signature = c.req.header('x-sheerid-signature') ?? '';

  const { rows } = await pool.query<{ config: unknown }>('SELECT config FROM store WHERE id = $1 LIMIT 1', [storeId]);
  const cfg = sheeridConfig(rows[0]?.config ?? null);
  const secret = cfg?.webhookSecret;
  const expected = secret ? createHmac('sha256', secret).update(raw).digest('hex') : '';
  const ok = secret && /^[0-9a-f]+$/i.test(signature) && signature.length === expected.length
    && timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  if (!ok) return c.json({ error: 'invalid signature' }, 401);

  let payload: { verificationId?: string };
  try { payload = JSON.parse(raw); } catch { return c.json({ error: 'invalid event' }, 400); }
  const verificationId = String(payload.verificationId ?? '');
  if (!verificationId) return c.json({ error: 'verificationId required' }, 400);
  if (!cfg?.clientId || !cfg?.clientSecret) return c.json({ error: 'SheerID API credentials not configured' }, 503);

  // Network FIRST (no pooled txn held across provider I/O), then one tx writes.
  const details = await fetchVerificationDetails(cfg, verificationId);
  const result = await withStore(storeId, (tx) => applyVerificationDetails(tx, storeId, details, cfg));
  return c.json({ received: true, result }, 200);
});

// ── admin: config ────────────────────────────────────────────────────────────
const SheerIdConfigBody = z.object({
  programId: z.string().min(1).max(128).nullish(),
  theme: z.string().max(128).nullish(),
  webhookSecret: z.string().max(256).nullish(),
  clientId: z.string().max(256).nullish(),
  clientSecret: z.string().max(256).nullish(),
  baseUrl: z.string().url().max(512).nullish(),
  authUrl: z.string().url().max(512).nullish(),
  verifyBaseUrl: z.string().url().max(512).nullish(),
  verificationTtlDays: z.number().int().min(1).max(3650).nullish(),
  segments: z.record(z.string(), z.object({ category: z.string().optional(), discountPercent: z.number().int().min(0).max(100).optional() })).nullish(),
});

sheeridRoutes.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/sheerid/config', summary: 'SheerID config status',
    responses: { 200: { description: 'OK', content: J(z.any()) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const [row] = await withStore(st.storeId, (tx) => tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1));
    const cfg = sheeridConfig(row?.config ?? null);
    return c.json({
      configured: !!cfg?.programId,
      programId: cfg?.programId ?? null,
      theme: cfg?.theme ?? null,
      hasWebhookSecret: !!cfg?.webhookSecret,
      hasClientCredentials: !!(cfg?.clientId && cfg?.clientSecret),
      verificationTtlDays: cfg?.verificationTtlDays ?? 365,
      segments: cfg?.segments ?? null,
    }, 200);
  }),
);

sheeridRoutes.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/sheerid/config', summary: 'Update SheerID config (secrets write-only)',
    request: { body: { content: J(SheerIdConfigBody) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const b = c.req.valid('json');
    await withStore(st.storeId, async (tx) => {
      const [row] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1).for('update');
      const config = { ...((row?.config as Record<string, unknown>) ?? {}) };
      const prev = { ...(((config.sheerid as object) ?? {}) as Record<string, unknown>) };
      for (const [k, v] of Object.entries(b)) {
        if (v === undefined) continue;         // absent = untouched
        if (v === null) delete prev[k];        // explicit null = clear
        else prev[k] = v;
      }
      config.sheerid = prev;
      await tx.update(s.store).set({ config }).where(eq(s.store.id, st.storeId));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'store', entityId: st.storeId, action: 'sheerid_config', data: { programId: prev.programId ?? null } });
    });
    return c.json({ ok: true }, 200);
  }),
);

// ── admin: list + revoke ─────────────────────────────────────────────────────
sheeridRoutes.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/sheerid/verifications', summary: 'List verification rows',
    request: { query: z.object({ status: z.enum(['pending', 'success', 'failed', 'revoked', 'expired']).optional() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { status } = c.req.valid('query');
    const items = await withStore(st.storeId, async (tx) => {
      const rows = await tx.select({
        id: sheeridVerification.id, customerId: sheeridVerification.customerId,
        verificationId: sheeridVerification.verificationId, programId: sheeridVerification.programId,
        category: sheeridVerification.category, status: sheeridVerification.status,
        discountPercent: sheeridVerification.discountPercent, expiresAt: sheeridVerification.expiresAt,
        createdAt: sheeridVerification.createdAt, email: s.customer.email,
      }).from(sheeridVerification)
        .leftJoin(s.customer, eq(s.customer.id, sheeridVerification.customerId))
        .where(status ? eq(sheeridVerification.status, status) : sql`true`)
        .orderBy(desc(sheeridVerification.createdAt)).limit(200);
      return rows.map((r) => ({ ...r, expiresAt: r.expiresAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() }));
    });
    return c.json({ items }, 200);
  }),
);

sheeridRoutes.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/sheerid/revoke', summary: 'Revoke a verified category for a customer',
    request: { body: { content: J(z.object({ customerId: z.string().uuid(), category: z.string().min(1).max(64) })) } },
    responses: {
      200: { description: 'OK', content: J(z.object({ revoked: z.number().int() })) },
      404: { description: 'Not found', ...errBody },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    // Same gate as the customer-page "Clear verification" action: revoking
    // eligibility is a customer-affecting, coupon-affecting change.
    const st = requireStore(admin, c); requireWrite(st); requirePermission(st, VERIFICATION_PERMISSION);
    const b = c.req.valid('json');
    const res = await withStore(st.storeId, async (tx) => {
      const [cust] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.id, b.customerId)).limit(1);
      if (!cust) return null;
      return revokeVerification(tx, st.storeId, { customerId: b.customerId, category: b.category }, admin.email);
    });
    if (!res) throw new HttpError(404, 'customer not found');
    return c.json(res, 200);
  }),
);

// ── G12: per-customer verification state + clear ─────────────────────────────
const CustomerIdParam = z.object({ id: z.string().uuid() });

const VerificationOut = z.object({
  customerId: z.string(),
  /** Categories that currently make the customer eligible for verified_customer coupons. */
  active: z.array(z.string()),
  entries: z.array(z.object({
    category: z.string(), programId: z.string().nullable(), discountPercent: z.number().nullable(),
    verifiedAt: z.string().nullable(), expiresAt: z.string().nullable(), source: z.enum(['sheerid', 'imported']),
  })),
  attempts: z.array(z.object({ id: z.string(), category: z.string().nullable(), status: z.string(), createdAt: z.string(), expiresAt: z.string().nullable() })),
  history: z.array(z.object({ action: z.string(), actor: z.string().nullable(), at: z.string(), categories: z.array(z.string()), reason: z.string().nullable() })),
  /** Whether THIS admin may clear (role + permission), so the UI can hide the button. */
  canClear: z.boolean(),
});

sheeridRoutes.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/customers/{id}/verification', summary: "A customer's SheerID verification state and history",
    request: { params: CustomerIdParam },
    responses: { 200: { description: 'OK', content: J(VerificationOut) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { id } = c.req.valid('param');
    const out = await withStore(st.storeId, async (tx) => {
      const [cust] = await tx.select({ active: s.customer.activeVerifications, entries: s.customer.sheeridVerifications })
        .from(s.customer).where(and(eq(s.customer.id, id), eq(s.customer.storeId, st.storeId))).limit(1);
      if (!cust) return null;
      const attempts = await tx.select({
        id: sheeridVerification.id, category: sheeridVerification.category, status: sheeridVerification.status,
        createdAt: sheeridVerification.createdAt, expiresAt: sheeridVerification.expiresAt, verificationId: sheeridVerification.verificationId,
      }).from(sheeridVerification)
        .where(and(eq(sheeridVerification.storeId, st.storeId), eq(sheeridVerification.customerId, id)))
        .orderBy(desc(sheeridVerification.createdAt)).limit(20);
      const audit = await tx.select({ action: s.auditLog.action, actor: s.auditLog.actor, at: s.auditLog.at, data: s.auditLog.data })
        .from(s.auditLog)
        .where(and(eq(s.auditLog.storeId, st.storeId), eq(s.auditLog.entity, 'customer'), eq(s.auditLog.entityId, id), sql`${s.auditLog.action} in ('verification_cleared','verification_revoked')`))
        .orderBy(desc(s.auditLog.at)).limit(20);
      const rowVids = new Set(attempts.map((a) => a.verificationId).filter((v): v is string => !!v));
      const rawEntries = Array.isArray(cust.entries) ? (cust.entries as Array<Record<string, unknown>>) : [];
      return {
        customerId: id,
        active: (cust.active ?? []) as string[],
        entries: rawEntries.filter((e) => typeof e?.category === 'string').map((e) => ({
          category: e.category as string,
          programId: typeof e.programId === 'string' ? e.programId : null,
          discountPercent: typeof e.discountPercent === 'number' ? e.discountPercent : null,
          verifiedAt: typeof e.verifiedAt === 'string' ? e.verifiedAt : null,
          expiresAt: typeof e.expiresAt === 'string' ? e.expiresAt : null,
          source: typeof e.verificationId === 'string' && rowVids.has(e.verificationId) ? 'sheerid' as const : 'imported' as const,
        })),
        attempts: attempts.map(({ verificationId: _v, ...a }) => ({ ...a, createdAt: a.createdAt.toISOString(), expiresAt: a.expiresAt?.toISOString() ?? null })),
        history: audit.map((a) => {
          const d = (a.data ?? {}) as { category?: unknown; categories?: unknown; reason?: unknown };
          const cats = Array.isArray(d.categories) ? d.categories.filter((x): x is string => typeof x === 'string') : typeof d.category === 'string' ? [d.category] : [];
          return { action: a.action, actor: a.actor, at: a.at.toISOString(), categories: cats, reason: typeof d.reason === 'string' ? d.reason : null };
        }),
      };
    });
    if (!out) throw new HttpError(404, 'customer not found');
    const canClear = (st.role === 'owner' || st.role === 'manager' || st.role === 'staff') && hasPermission(st, VERIFICATION_PERMISSION);
    return c.json({ ...out, canClear }, 200);
  }),
);

sheeridRoutes.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/customers/{id}/verification/clear', summary: "Clear a customer's SheerID verification (all categories, or one)",
    request: {
      params: CustomerIdParam,
      body: { content: J(z.object({
        category: z.string().min(1).max(64).optional(),
        reason: z.string().trim().min(3).max(500),
      })) },
    },
    responses: {
      200: { description: 'OK', content: J(z.object({ cleared: z.array(z.string()), rowsRevoked: z.number().int(), importedRemoved: z.number().int(), active: z.array(z.string()) })) },
      404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requirePermission(st, VERIFICATION_PERMISSION);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const res = await withStore(st.storeId, (tx) => clearVerification(tx, st.storeId, { customerId: id, category: b.category, reason: b.reason }, admin.email));
    if (!res) throw new HttpError(404, 'customer not found');
    return c.json(res, 200);
  }),
);
