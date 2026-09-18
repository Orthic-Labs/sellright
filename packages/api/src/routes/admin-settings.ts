import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { desc, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { newTotpSecret, verifyTotp, otpauthUri } from '../auth/totp.js';
import { clearAdminTotpSecret, getAdminTotpSecret, setAdminTotpSecret } from '../auth/admin-staff.js';
import { isSupportedPaymentMethod } from '../payments/provider.js';
import { stripeConfigured, stripeModeFromConfig } from '../payments/stripe.js';
import { invalidateStoreCache } from '../store-context.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireManage, guard } from './admin-helpers.js';

export const adminSettings = new OpenAPIHono();

async function storeRow(storeId: string) {
  const [row] = await withStore(storeId, async (tx) => tx.select().from(s.store).where(eq(s.store.id, storeId)).limit(1));
  return row!;
}
const cfg = (row: { config: unknown }) => (row.config as Record<string, unknown> | null) ?? {};

export function sanitizePaymentSettingsPatch(input: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [method, enabled] of Object.entries(input)) {
    if (!isSupportedPaymentMethod(method)) throw new HttpError(400, `unsupported payment provider: ${method}`);
    out[method] = enabled;
  }
  return out;
}

/** SR-16: durable audit records for sensitive mutations. The `data` payload is
 *  built by each call site from an explicit allow-list of keys — never dump
 *  the whole config blob (it can carry credential-shaped values) and never a
 *  secret. Pass `before`/`after` snapshots of ONLY the keys being changed. */
interface SettingsAudit {
  actor: string;
  action: string;
  /** Called with (prevConfig, nextConfig); return the redacted detail object
   *  persisted in audit_log.data. */
  detail?: (prev: Record<string, unknown>, next: Record<string, unknown>) => Record<string, unknown>;
}

/** Atomic read-modify-write of store.config under a row lock. The config is a
 *  single JSONB blob touched by several setting endpoints; a plain
 *  read-then-write races (two concurrent saves each read the same value and the
 *  second clobbers the first's keys). FOR UPDATE serialises them. Returns the
 *  persisted config.
 *
 *  SR-16: when `audit` is given the audit_log row is written in the SAME
 *  transaction as the config update — both commit or both roll back.
 *
 *  PERF-2: also invalidates the in-process resolveStore / resolveStoreByHost
 *  cache (60s TTL — see store-context.ts) so the next request sees fresh
 *  values without waiting for TTL. Slug + config are read in one locked txn so
 *  the lock guarantees the slug is consistent with the row we just mutated —
 *  a stale slug could leave a host cache entry pointed at the wrong store. */
async function mutateStoreConfig(
  storeId: string,
  mutate: (config: Record<string, unknown>) => Record<string, unknown>,
  audit?: SettingsAudit,
): Promise<Record<string, unknown>> {
  const { slug, next } = await withStore(storeId, async (tx) => {
    const [row] = await tx
      .select({ slug: s.store.slug, config: s.store.config })
      .from(s.store)
      .where(eq(s.store.id, storeId))
      .for('update')
      .limit(1);
    const prev = (row?.config as Record<string, unknown> | null) ?? {};
    const v = mutate(prev);
    await tx.update(s.store).set({ config: v }).where(eq(s.store.id, storeId));
    if (audit) {
      await tx.insert(s.auditLog).values({
        storeId,
        actor: audit.actor,
        entity: 'store',
        entityId: storeId,
        action: audit.action,
        data: audit.detail ? audit.detail(prev, v) : undefined,
      });
    }
    return { slug: row!.slug, next: v };
  });
  invalidateStoreCache(slug);
  return next;
}

// ── admin 2FA (TOTP) ─────────────────────────────────────────────────────────
adminSettings.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/2fa', summary: '2FA status',
    responses: { 200: { description: 'OK', content: J(z.object({ enabled: z.boolean() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const secret = await getAdminTotpSecret(admin.id);
    return c.json({ enabled: !!secret }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/2fa/setup', summary: 'Start 2FA setup (returns a secret to confirm)',
    responses: { 200: { description: 'OK', content: J(z.object({ secret: z.string(), otpauthUri: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const secret = newTotpSecret(); // not persisted until /enable confirms a code
    return c.json({ secret, otpauthUri: otpauthUri(secret, admin.email) }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/2fa/enable', summary: 'Confirm + enable 2FA',
    request: { body: { content: J(z.object({ secret: z.string(), code: z.string() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ enabled: z.boolean() })) }, 401: { description: 'Unauthorized', ...errBody }, 409: { description: 'Bad code', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const { secret, code } = c.req.valid('json');
    // ra-sec: refuse to overwrite an existing factor. /disable requires the current
    // code, so replacing 2FA always proves possession of the old device — otherwise
    // a hijacked session could silently swap in an attacker-controlled secret.
    const existing = await getAdminTotpSecret(admin.id);
    if (existing) throw new HttpError(409, '2FA already enabled — disable it first');
    if (!verifyTotp(secret, code)) throw new HttpError(409, 'code did not match — check your authenticator app');
    await setAdminTotpSecret(admin.id, secret);
    return c.json({ enabled: true }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/2fa/disable', summary: 'Disable 2FA',
    request: { body: { content: J(z.object({ code: z.string() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ enabled: z.boolean() })) }, 401: { description: 'Unauthorized', ...errBody }, 409: { description: 'Bad code', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const { code } = c.req.valid('json');
    const existing = await getAdminTotpSecret(admin.id);
    if (!existing) return c.json({ enabled: false }, 200);
    if (!verifyTotp(existing, code)) throw new HttpError(409, 'invalid code');
    await clearAdminTotpSecret(admin.id);
    return c.json({ enabled: false }, 200);
  }),
);

// ── store details + tax ──────────────────────────────────────────────────────
adminSettings.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/settings/store', summary: 'Store details',
    responses: { 200: { description: 'OK', content: J(z.any()) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const row = await storeRow(st.storeId);
    const config = cfg(row);
    return c.json({
      name: row.name,
      slug: row.slug,
      currency: row.currency,
      taxRate: row.taxRate,
      taxInclusive: row.taxInclusive,
      shippingTaxable: row.shippingTaxable,
      payments: (config.payments as object) ?? { cod: true, manual: true },
      stripeMode: stripeModeFromConfig(config),
      notifications: (config.notifications as object) ?? {},
      googleClientId: (config.googleClientId as string) ?? null,
    }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/settings/store', summary: 'Update store details / tax',
    request: { body: { content: J(z.object({ name: z.string().optional(), currency: z.string().optional(), taxRate: z.number().int().min(0).optional(), taxInclusive: z.boolean().optional(), shippingTaxable: z.boolean().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const b = c.req.valid('json');
    await withStore(st.storeId, async (tx) => {
      // SR-16: lock the row and snapshot the touched columns so the audit row
      // carries a truthful before/after — name/currency/tax flags only, never
      // the config blob.
      const [before] = await tx
        .select({ name: s.store.name, currency: s.store.currency, taxRate: s.store.taxRate, taxInclusive: s.store.taxInclusive, shippingTaxable: s.store.shippingTaxable })
        .from(s.store)
        .where(eq(s.store.id, st.storeId))
        .for('update')
        .limit(1);
      if (!before) throw new HttpError(404, 'store not found');
      await tx.update(s.store).set({ ...b, updatedAt: new Date() }).where(eq(s.store.id, st.storeId));
      const keys = Object.keys(b) as Array<keyof typeof before>;
      const pick = (row: Record<string, unknown>) => Object.fromEntries(keys.map((k) => [k, row[k]]));
      await tx.insert(s.auditLog).values({
        storeId: st.storeId,
        actor: admin.email,
        entity: 'store',
        entityId: st.storeId,
        action: 'settings_update',
        data: { section: 'store', before: pick(before), after: pick({ ...before, ...b }) },
      });
    });
    invalidateStoreCache(st.slug);
    return c.json({ ok: true }, 200);
  }),
);

// ── payments config (which providers are enabled) ────────────────────────────
adminSettings.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/settings/payments', summary: 'Enable/disable payment providers',
    request: { body: { content: J(z.record(z.string(), z.boolean())) } },
    responses: { 200: { description: 'OK', content: J(z.object({ payments: z.any() })) }, 400: { description: 'Bad provider', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const b = sanitizePaymentSettingsPatch(c.req.valid('json'));
    let payments: Record<string, unknown> = {};
    await mutateStoreConfig(st.storeId, (config) => {
      // Seed the credential-free defaults so toggling a gateway never silently
      // disables cod/manual (which aren't persisted until first edited).
      payments = { cod: true, manual: true, ...((config.payments as object) ?? {}), ...b };
      return { ...config, payments };
    }, {
      actor: admin.email,
      action: 'settings_update',
      detail: (prev, next) => ({
        section: 'payments',
        before: { cod: true, manual: true, ...((prev.payments as object) ?? {}) },
        after: next.payments,
      }),
    });
    return c.json({ payments }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/settings/payments/stripe-mode', summary: 'Set the active Stripe mode (test/live)',
    request: { body: { content: J(z.object({ mode: z.enum(['test', 'live']) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ stripeMode: z.enum(['test', 'live']) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { mode } = c.req.valid('json');
    // Don't let an operator flip to a mode whose credentials aren't loaded — every
    // subsequent /payment-intent would 503 with nothing surfaced at this endpoint.
    if (!stripeConfigured(mode)) throw new HttpError(409, `cannot switch to ${mode} mode — Stripe ${mode} credentials are not configured`);
    await mutateStoreConfig(st.storeId, (config) => {
      const stripe = { ...(((config.stripe as object) ?? {}) as Record<string, unknown>), mode };
      return { ...config, stripe };
    }, {
      actor: admin.email,
      action: 'settings_update',
      // mode only — never log the stripe config sub-object (key material).
      detail: (prev) => ({ section: 'stripe', before: { mode: ((prev.stripe as Record<string, unknown> | undefined)?.mode) ?? null }, after: { mode } }),
    });
    return c.json({ stripeMode: mode }, 200);
  }),
);

// ── Google sign-in client id (for customer Google auth) ──────────────────────
adminSettings.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/settings/google', summary: 'Set Google OAuth client id',
    request: { body: { content: J(z.object({ clientId: z.string().nullable() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { clientId } = c.req.valid('json');
    await mutateStoreConfig(st.storeId, (config) => ({ ...config, googleClientId: clientId || undefined }), {
      actor: admin.email,
      action: 'settings_update',
      detail: (prev, next) => ({ section: 'google', before: { clientId: prev.googleClientId ?? null }, after: { clientId: next.googleClientId ?? null } }),
    });
    return c.json({ ok: true }, 200);
  }),
);

// ── notification settings (email templates toggles) ──────────────────────────
adminSettings.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/settings/notifications', summary: 'Update notification settings',
    request: { body: { content: J(z.record(z.string(), z.any())) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const b = c.req.valid('json');
    await mutateStoreConfig(st.storeId, (config) => ({ ...config, notifications: { ...((config.notifications as object) ?? {}), ...b } }), {
      actor: admin.email,
      action: 'settings_update',
      detail: (prev, next) => {
        const keys = Object.keys(b);
        const pick = (n: unknown) => Object.fromEntries(keys.map((k) => [k, (n as Record<string, unknown> | undefined)?.[k]]));
        return { section: 'notifications', before: pick(prev.notifications), after: pick(next.notifications) };
      },
    });
    return c.json({ ok: true }, 200);
  }),
);

// ── shipping methods ─────────────────────────────────────────────────────────
adminSettings.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/shipping-methods', summary: 'List shipping methods',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const items = await withStore(st.storeId, async (tx) => tx.select().from(s.shippingMethod).orderBy(s.shippingMethod.name));
    return c.json({ items }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/shipping-methods', summary: 'Create shipping method',
    request: { body: { content: J(z.object({ code: z.string().min(1), name: z.string().min(1), calculator: z.any().default({ flat: 0 }), enabled: z.boolean().default(true) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const b = c.req.valid('json');
    const id = await withStore(st.storeId, async (tx) => {
      const [m] = await tx.insert(s.shippingMethod).values({ storeId: st.storeId, code: b.code, name: b.name, calculator: b.calculator, enabled: b.enabled }).returning({ id: s.shippingMethod.id });
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'shipping_method', entityId: m!.id, action: 'create', data: { code: b.code, name: b.name } });
      return m!.id;
    });
    return c.json({ id }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/shipping-methods/{id}', summary: 'Update shipping method',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ name: z.string().optional(), calculator: z.any().optional(), enabled: z.boolean().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const ok = await withStore(st.storeId, async (tx) => {
      const [m] = await tx.select().from(s.shippingMethod).where(eq(s.shippingMethod.id, id)).limit(1);
      if (!m) return false;
      await tx.update(s.shippingMethod).set(b).where(eq(s.shippingMethod.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'shipping_method', entityId: id, action: 'update', data: { before: { name: m.name, calculator: m.calculator, enabled: m.enabled }, after: b } });
      return true;
    });
    if (!ok) throw new HttpError(404, 'shipping method not found');
    return c.json({ id }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'delete', path: '/v1/admin/shipping-methods/{id}', summary: 'Delete shipping method',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { id } = c.req.valid('param');
    await withStore(st.storeId, async (tx) => {
      const [m] = await tx.select({ code: s.shippingMethod.code, name: s.shippingMethod.name }).from(s.shippingMethod).where(eq(s.shippingMethod.id, id)).limit(1);
      await tx.delete(s.shippingMethod).where(eq(s.shippingMethod.id, id));
      if (m) await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'shipping_method', entityId: id, action: 'delete', data: { code: m.code, name: m.name } });
    });
    return c.json({ id }, 200);
  }),
);

// ── tax zones (destination rates; override the store flat taxRate) ────────────
adminSettings.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/tax-zones', summary: 'List tax zones',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const items = await withStore(st.storeId, async (tx) => tx.select().from(s.taxZone).orderBy(desc(s.taxZone.priority), s.taxZone.name));
    return c.json({ items }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/tax-zones', summary: 'Create a tax zone',
    request: { body: { content: J(z.object({ name: z.string().min(1), countries: z.array(z.string()).min(1), rate: z.number().int().min(0), priority: z.number().int().default(0), enabled: z.boolean().default(true) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const b = c.req.valid('json');
    const id = await withStore(st.storeId, async (tx) => {
      const [z2] = await tx.insert(s.taxZone).values({ storeId: st.storeId, name: b.name, countries: b.countries.map((x: string) => x.toUpperCase()), rate: b.rate, priority: b.priority, enabled: b.enabled }).returning({ id: s.taxZone.id });
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'tax_zone', entityId: z2!.id, action: 'create', data: { name: b.name, rate: b.rate } });
      return z2!.id;
    });
    return c.json({ id }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/tax-zones/{id}', summary: 'Update a tax zone',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ name: z.string().optional(), countries: z.array(z.string()).optional(), rate: z.number().int().min(0).optional(), priority: z.number().int().optional(), enabled: z.boolean().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const patch: Record<string, unknown> = { ...b };
    if (b.countries) patch.countries = b.countries.map((x: string) => x.toUpperCase());
    const ok = await withStore(st.storeId, async (tx) => {
      const [z2] = await tx.select().from(s.taxZone).where(eq(s.taxZone.id, id)).limit(1);
      if (!z2) return false;
      await tx.update(s.taxZone).set(patch).where(eq(s.taxZone.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'tax_zone', entityId: id, action: 'update', data: { before: { name: z2.name, countries: z2.countries, rate: z2.rate, priority: z2.priority, enabled: z2.enabled }, after: patch } });
      return true;
    });
    if (!ok) throw new HttpError(404, 'tax zone not found');
    return c.json({ id }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'delete', path: '/v1/admin/tax-zones/{id}', summary: 'Delete a tax zone',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { id } = c.req.valid('param');
    await withStore(st.storeId, async (tx) => {
      const [z2] = await tx.select({ name: s.taxZone.name }).from(s.taxZone).where(eq(s.taxZone.id, id)).limit(1);
      await tx.delete(s.taxZone).where(eq(s.taxZone.id, id));
      if (z2) await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'tax_zone', entityId: id, action: 'delete', data: { name: z2.name } });
    });
    return c.json({ id }, 200);
  }),
);

export { isUiPermissionKey, mergeStaffPermissions, sanitizeWebhookEndpointPatch } from './admin-settings-advanced.js';
