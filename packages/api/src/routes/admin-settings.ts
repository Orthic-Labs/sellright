import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { newTotpSecret, verifyTotp, otpauthUri } from '../auth/totp.js';
import { clearAdminTotpSecret, getAdminTotpSecret, setAdminTotpSecret } from '../auth/admin-staff.js';
import { isSupportedPaymentMethod, mergePaymentMethodSetting } from '../payments/provider.js';
import { resolveStripeConfigured, stripeModeFromConfig } from '../payments/stripe.js';
import { broadcastStoreCacheInvalidation } from '../store-context.js';
import { env } from '../env.js';
import { normalizeStorefrontUrl } from '../lib/storefront-url.js';
import { generatePreviewToken, hashPreviewToken } from '../store-publish.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireManage, guard } from './admin-helpers.js';
// Circular with admin-system.ts (which imports mutateStoreConfig from here)
// is safe: both bindings are only ever called from inside route handlers,
// never at module-evaluation time, so ESM's live-binding semantics resolve
// them fine regardless of import order.
import { computeReadiness } from './admin-system.js';

export const adminSettings = new OpenAPIHono();

async function storeRow(storeId: string) {
  const [row] = await withStore(storeId, async (tx) => tx.select().from(s.store).where(eq(s.store.id, storeId)).limit(1));
  return row!;
}
const cfg = (row: { config: unknown }) => (row.config as Record<string, unknown> | null) ?? {};

export type PaymentSettingPatch = boolean | { enabled?: boolean; mode?: 'test' | 'live' };
export function sanitizePaymentSettingsPatch(input: Record<string, PaymentSettingPatch>): Record<string, PaymentSettingPatch> {
  const out: Record<string, PaymentSettingPatch> = {};
  for (const [method, value] of Object.entries(input)) {
    if (!isSupportedPaymentMethod(method)) throw new HttpError(400, `unsupported payment provider: ${method}`);
    if (typeof value === 'object' && value.mode !== undefined && method !== 'nmi' && method !== 'sezzle') {
      // Stripe mode lives at config.stripe.mode (PATCH /settings/payments/stripe-mode).
      throw new HttpError(400, `mode is not configurable here for ${method}`);
    }
    out[method] = value;
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
export async function mutateStoreConfig(
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
  await broadcastStoreCacheInvalidation(slug);
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
      storefrontUrl: typeof config.storefrontUrl === 'string' ? config.storefrontUrl : null,
    }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/settings/store', summary: 'Update store details / tax',
    request: { body: { content: J(z.object({
      name: z.string().optional(), currency: z.string().optional(), taxRate: z.number().int().min(0).optional(),
      taxInclusive: z.boolean().optional(), shippingTaxable: z.boolean().optional(),
      // Domain checklist item (plan §1.5): the Host(s) store-context.ts's
      // resolveStoreByHost matches against. Lives in config.hostnames
      // (JSONB), not a `store` column — handled separately from the rest of
      // this body below. Previously nothing on the admin surface could ever
      // set this after bootstrap.js's one-time BOOTSTRAP_STORE_HOSTNAMES.
      hostnames: z.array(z.string().trim().min(1)).optional(),
      // Public storefront URL (config.storefrontUrl): Sezzle/Stripe return
      // URLs and email links are built from it. https only (http allowed for
      // loopback); null or "" clears it.
      storefrontUrl: z.string().trim().max(2048).nullable().optional(),
    })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { hostnames, storefrontUrl: storefrontUrlRaw, ...b } = c.req.valid('json');
    let storefrontUrl: string | null | undefined;
    if (storefrontUrlRaw !== undefined) {
      if (storefrontUrlRaw === null || storefrontUrlRaw === '') storefrontUrl = null;
      else {
        const normalised = normalizeStorefrontUrl(storefrontUrlRaw);
        if (!normalised) throw new HttpError(400, 'storefrontUrl must be an https URL without credentials, query or fragment');
        storefrontUrl = normalised;
      }
    }
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
      // A hostnames-only PATCH touches no `store` column — skip both the
      // update and its audit row rather than writing a spurious
      // before===after entry.
      if (Object.keys(b).length > 0) {
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
      }
    });
    if (hostnames) {
      await mutateStoreConfig(st.storeId, (config) => ({ ...config, hostnames }), {
        actor: admin.email,
        action: 'settings_update_hostnames',
        detail: () => ({ hostnames }),
      });
    }
    if (storefrontUrl !== undefined) {
      await mutateStoreConfig(st.storeId, (config) => {
        const { storefrontUrl: _drop, ...rest } = config;
        return storefrontUrl === null ? rest : { ...rest, storefrontUrl };
      }, {
        actor: admin.email,
        action: 'settings_update_storefront_url',
        detail: (prev, next) => ({ before: prev.storefrontUrl ?? null, after: next.storefrontUrl ?? null }),
      });
    }
    await broadcastStoreCacheInvalidation(st.slug);
    return c.json({ ok: true }, 200);
  }),
);

// ── payments config (which providers are enabled) ────────────────────────────
adminSettings.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/settings/payments', summary: 'Enable/disable payment providers',
    request: { body: { content: J(z.record(z.string(), z.union([z.boolean(), z.object({ enabled: z.boolean().optional(), mode: z.enum(['test', 'live']).optional() }).strict()]))) } },
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
      const current: Record<string, unknown> = { cod: true, manual: true, ...((config.payments as object) ?? {}) };
      for (const [method, value] of Object.entries(b)) current[method] = mergePaymentMethodSetting(current[method], value);
      payments = current;
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
    if (!(await resolveStripeConfigured(st.storeId, mode))) throw new HttpError(409, `cannot switch to ${mode} mode — Stripe ${mode} credentials are not configured`);
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
// Validates the calculator blob the admin editor sends (shipping/calculator.ts
// is the interpreter). Unknown keys are kept (passthrough) so a future calculator
// extension is never silently dropped by an older admin UI; known keys are typed.
const cents = z.number().int().min(0).max(100_000_000);
export const ShippingCalculatorSchema = z.object({
  flat: cents.optional(), min: cents.optional(), max: cents.optional(),
  countries: z.array(z.string().trim().regex(/^[A-Za-z]{2}$/, 'countries must be 2-letter ISO codes')).max(300).optional(),
  exclude: z.boolean().optional(), requireCountry: z.boolean().optional(),
  subtotalBasis: z.enum(['pre_discount', 'discounted_with_tax']).optional(),
  taxRate: z.number().min(0).max(100_000).optional(), taxInclusive: z.boolean().optional(),
}).passthrough().refine((c) => c.min == null || c.max == null || c.min <= c.max, { message: 'minimum subtotal cannot exceed maximum' });

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
    request: { body: { content: J(z.object({ code: z.string().min(1), name: z.string().min(1), calculator: ShippingCalculatorSchema.default({ flat: 0 }), enabled: z.boolean().default(true) })) } },
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
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ name: z.string().trim().min(1).optional(), code: z.string().trim().min(1).max(64).optional(), calculator: ShippingCalculatorSchema.optional(), enabled: z.boolean().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 409: { description: 'Code in use', ...errBody }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const ok = await withStore(st.storeId, async (tx) => {
      const [m] = await tx.select().from(s.shippingMethod).where(eq(s.shippingMethod.id, id)).limit(1);
      if (!m) return false;
      if (b.code && b.code !== m.code) {
        const [dup] = await tx.select({ id: s.shippingMethod.id }).from(s.shippingMethod).where(and(eq(s.shippingMethod.code, b.code), sql`${s.shippingMethod.id} <> ${id}`)).limit(1);
        if (dup) throw new HttpError(409, `shipping method code '${b.code}' is already in use`);
      }
      await tx.update(s.shippingMethod).set(b).where(eq(s.shippingMethod.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'shipping_method', entityId: id, action: 'update', data: { before: { code: m.code, name: m.name, calculator: m.calculator, enabled: m.enabled }, after: b } });
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

// ── store identity/theme (WS-C: runtime storefront configuration) ──────────
// Free-form identity fields are written as one JSON blob under
// config.identity — same shape the public /v1/shop/identity route reads via
// storeIdentityFromConfig. Kept permissive (partial merge, no schema
// enforcement beyond "an object") because this is display copy, not a
// security-sensitive setting; the public route already falls back safely for
// any missing/malformed field.
const IdentityPatchSchema = z.object({
  storeName: z.string().optional(),
  legalName: z.string().optional(),
  tagline: z.string().optional(),
  supportEmail: z.string().optional(),
  logoText: z.string().optional(),
  logoImageUrl: z.string().nullable().optional(),
  ogImageUrl: z.string().optional(),
  siteOrigin: z.string().optional(),
  locale: z.string().optional(),
  address: z.object({
    streetAddress: z.string(), addressLocality: z.string(), addressRegion: z.string(),
    postalCode: z.string(), addressCountry: z.string(),
  }).nullable().optional(),
  social: z.object({
    instagram: z.string().optional(), facebook: z.string().optional(), twitter: z.string().optional(),
    tiktok: z.string().optional(), youtube: z.string().optional(),
  }).optional(),
  colors: z.object({
    primary: z.string().optional(), secondary: z.string().optional(), accent: z.string().optional(),
    background: z.string().optional(), surface: z.string().optional(), text: z.string().optional(),
    textMuted: z.string().optional(), border: z.string().optional(),
  }).optional(),
  fonts: z.object({ display: z.string().optional(), body: z.string().optional(), mono: z.string().optional() }).optional(),
  policies: z.object({
    shipping: z.object({ label: z.string().optional(), sub: z.string().optional() }).optional(),
    returns: z.object({ label: z.string().optional(), sub: z.string().optional() }).optional(),
    payment: z.object({ label: z.string().optional(), sub: z.string().optional() }).optional(),
  }).optional(),
});

adminSettings.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/settings/identity', summary: 'Store identity/theme config',
    responses: { 200: { description: 'OK', content: J(z.any()) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const row = await storeRow(st.storeId);
    const config = cfg(row);
    return c.json({
      identity: (config.identity as object) ?? {},
      published: (config as Record<string, unknown>).published !== false,
      hasPreviewToken: typeof (config as Record<string, unknown>).previewTokenHash === 'string',
    }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/settings/identity', summary: 'Update store identity/theme config (merged with existing)',
    request: { body: { content: J(IdentityPatchSchema) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const patch = c.req.valid('json');
    await mutateStoreConfig(st.storeId, (config) => ({
      ...config,
      identity: { ...((config.identity as object) ?? {}), ...patch },
    }), {
      actor: admin.email,
      action: 'update-identity',
      detail: () => ({ keys: Object.keys(patch) }),
    });
    return c.json({ ok: true }, 200);
  }),
);

// ── publish state + private-preview token (plan §1.5) ───────────────────────
adminSettings.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/settings/publish', summary: 'Set the storefront published flag',
    request: { body: { content: J(z.object({ published: z.boolean() })) } },
    responses: {
      200: { description: 'OK', content: J(z.object({ published: z.boolean() })) },
      401: { description: 'Unauthorized', ...errBody },
      409: { description: 'Readiness checks not met', content: J(z.object({ error: z.string(), failing: z.array(z.string()) })) },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { published } = c.req.valid('json');

    // Publish readiness (plan §1.5): going private never needs a gate — only
    // going live does. Domain is deliberately never a blocker here (no
    // domain/TLS automation has shipped — see computeReadiness's doc
    // comment); off-site backup and the product/shipping checklist items are
    // informational only, not gates, per the plan's exact readiness list.
    if (published) {
      const readiness = await computeReadiness(st.storeId, admin.isInstallationAdmin ? admin.id : null);
      const failing = (['payments', 'email', 'recoveryKit'] as const).filter((k) => !readiness[k].ok);
      if (failing.length > 0) {
        return c.json({ error: 'readiness checks not met', failing }, 409);
      }
    }

    await mutateStoreConfig(st.storeId, (config) => ({ ...config, published }), {
      actor: admin.email,
      action: published ? 'publish-store' : 'unpublish-store',
    });
    return c.json({ published }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/settings/preview-token', summary: 'Issue a new private-preview token (invalidates the previous one)',
    responses: { 200: { description: 'OK', content: J(z.object({ token: z.string(), previewUrl: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const token = generatePreviewToken();
    await mutateStoreConfig(st.storeId, (config) => ({ ...config, previewTokenHash: hashPreviewToken(token) }), {
      actor: admin.email,
      action: 'issue-preview-token',
    });
    // The plaintext token exists only in this response — only its hash is
    // persisted. previewUrl saves the onboarding UI (Setup screen 3) from
    // needing its own STOREFRONT_URL plumbing — layout.tsx reads this exact
    // query param name (`preview_token`, not `token`).
    return c.json({ token, previewUrl: `${env.STOREFRONT_URL}/?preview_token=${token}` }, 200);
  }),
);

export { isUiPermissionKey, mergeStaffPermissions, sanitizeWebhookEndpointPatch } from './admin-settings-advanced.js';
