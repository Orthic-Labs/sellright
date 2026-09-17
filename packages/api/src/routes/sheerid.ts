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
import { HttpError, J, errBody, guard, requireAdmin, requireManage, requireStore, requireWrite } from './admin-helpers.js';
import {
  applyVerificationDetails, fetchVerificationDetails, recomputeCustomerVerifications,
  revokeVerification, sheeridConfig, sheeridProgram, startVerification,
  SheerIdClient,
} from '../sheerid/service.js';

export const sheeridRoutes = new OpenAPIHono();

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
    const st = requireStore(admin, c); requireWrite(st);
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
