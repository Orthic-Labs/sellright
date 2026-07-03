import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { desc, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { newTotpSecret, verifyTotp, otpauthUri } from '../auth/totp.js';
import { clearAdminTotpSecret, getAdminTotpSecret, setAdminTotpSecret } from '../auth/admin-staff.js';
import { isSupportedPaymentMethod } from '../payments/provider.js';
import { stripeConfigured, stripeModeFromConfig } from '../payments/stripe.js';
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

/** Atomic read-modify-write of store.config under a row lock. The config is a
 *  single JSONB blob touched by several setting endpoints; a plain
 *  read-then-write races (two concurrent saves each read the same value and the
 *  second clobbers the first's keys). FOR UPDATE serialises them. Returns the
 *  persisted config. */
async function mutateStoreConfig(
  storeId: string,
  mutate: (config: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return withStore(storeId, async (tx) => {
    const [row] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).for('update').limit(1);
    const next = mutate((row?.config as Record<string, unknown> | null) ?? {});
    await tx.update(s.store).set({ config: next }).where(eq(s.store.id, storeId));
    return next;
  });
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
    await withStore(st.storeId, async (tx) => tx.update(s.store).set({ ...b, updatedAt: new Date() }).where(eq(s.store.id, st.storeId)));
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
    await mutateStoreConfig(st.storeId, (config) => ({ ...config, googleClientId: clientId || undefined }));
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
    await mutateStoreConfig(st.storeId, (config) => ({ ...config, notifications: { ...((config.notifications as object) ?? {}), ...b } }));
    return c.json({ ok: true }, 200);
  }),
);

// ── shipping methods ─────────────────────────────────────────────────────────
adminSettings.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/shipping-methods', summary: 'List shipping methods',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
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
      const [m] = await tx.select({ id: s.shippingMethod.id }).from(s.shippingMethod).where(eq(s.shippingMethod.id, id)).limit(1);
      if (!m) return false;
      await tx.update(s.shippingMethod).set(b).where(eq(s.shippingMethod.id, id));
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
    await withStore(st.storeId, async (tx) => { await tx.delete(s.shippingMethod).where(eq(s.shippingMethod.id, id)); });
    return c.json({ id }, 200);
  }),
);

// ── tax zones (destination rates; override the store flat taxRate) ────────────
adminSettings.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/tax-zones', summary: 'List tax zones',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
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
      const [z2] = await tx.select({ id: s.taxZone.id }).from(s.taxZone).where(eq(s.taxZone.id, id)).limit(1);
      if (!z2) return false;
      await tx.update(s.taxZone).set(patch).where(eq(s.taxZone.id, id));
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
    await withStore(st.storeId, async (tx) => { await tx.delete(s.taxZone).where(eq(s.taxZone.id, id)); });
    return c.json({ id }, 200);
  }),
);

export { isUiPermissionKey, mergeStaffPermissions, sanitizeWebhookEndpointPatch } from './admin-settings-advanced.js';
