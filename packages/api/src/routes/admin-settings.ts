import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { db, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireWrite, requireManage, guard } from './admin-helpers.js';

export const adminSettings = new OpenAPIHono();

async function storeRow(storeId: string) {
  const [row] = await db.select().from(s.store).where(eq(s.store.id, storeId)).limit(1);
  return row!;
}
const cfg = (row: { config: unknown }) => (row.config as Record<string, unknown> | null) ?? {};

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
    return c.json({ name: row.name, slug: row.slug, currency: row.currency, taxRate: row.taxRate, shippingTaxable: row.shippingTaxable, payments: (config.payments as object) ?? { cod: true, manual: true }, notifications: (config.notifications as object) ?? {}, googleClientId: (config.googleClientId as string) ?? null }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/settings/store', summary: 'Update store details / tax',
    request: { body: { content: J(z.object({ name: z.string().optional(), currency: z.string().optional(), taxRate: z.number().int().min(0).optional(), shippingTaxable: z.boolean().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const b = c.req.valid('json');
    await db.update(s.store).set({ ...b, updatedAt: new Date() }).where(eq(s.store.id, st.storeId));
    return c.json({ ok: true }, 200);
  }),
);

// ── payments config (which providers are enabled) ────────────────────────────
adminSettings.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/settings/payments', summary: 'Enable/disable payment providers',
    request: { body: { content: J(z.record(z.string(), z.boolean())) } },
    responses: { 200: { description: 'OK', content: J(z.object({ payments: z.any() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const b = c.req.valid('json');
    const row = await storeRow(st.storeId);
    // Seed the credential-free defaults so toggling a gateway never silently
    // disables cod/manual (which aren't persisted until first edited).
    const payments = { cod: true, manual: true, ...((cfg(row).payments as object) ?? {}), ...b };
    await db.update(s.store).set({ config: { ...cfg(row), payments } }).where(eq(s.store.id, st.storeId));
    return c.json({ payments }, 200);
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
    const row = await storeRow(st.storeId);
    await db.update(s.store).set({ config: { ...cfg(row), googleClientId: clientId || undefined } }).where(eq(s.store.id, st.storeId));
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
    const row = await storeRow(st.storeId);
    await db.update(s.store).set({ config: { ...cfg(row), notifications: { ...((cfg(row).notifications as object) ?? {}), ...b } } }).where(eq(s.store.id, st.storeId));
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

// ── staff & roles ────────────────────────────────────────────────────────────
const roleEnum = z.enum(['owner', 'manager', 'staff', 'read_only']);

adminSettings.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/staff', summary: 'Staff with access to this store',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const items = await db
      .select({ adminUserId: s.adminUser.id, email: s.adminUser.email, role: s.adminUserStore.role, createdAt: s.adminUser.createdAt })
      .from(s.adminUserStore)
      .innerJoin(s.adminUser, eq(s.adminUser.id, s.adminUserStore.adminUserId))
      .where(eq(s.adminUserStore.storeId, st.storeId));
    return c.json({ items: items.map((i) => ({ ...i, createdAt: i.createdAt.toISOString(), isYou: i.email === admin.email })) }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/staff', summary: 'Add / invite a staff member to this store',
    request: { body: { content: J(z.object({ email: z.string().email(), role: roleEnum.default('staff'), password: z.string().min(8) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ adminUserId: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { email, role, password } = c.req.valid('json');
    const [existing] = await db.select({ id: s.adminUser.id }).from(s.adminUser).where(eq(s.adminUser.email, email)).limit(1);
    let adminUserId = existing?.id;
    if (!adminUserId) {
      const [u] = await db.insert(s.adminUser).values({ email, passwordHash: await hashPassword(password) }).returning({ id: s.adminUser.id });
      adminUserId = u!.id;
    }
    await db.insert(s.adminUserStore).values({ adminUserId, storeId: st.storeId, role }).onConflictDoUpdate({ target: [s.adminUserStore.adminUserId, s.adminUserStore.storeId], set: { role } });
    return c.json({ adminUserId }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/staff/{adminUserId}', summary: 'Change a staff member role',
    request: { params: z.object({ adminUserId: z.string() }), body: { content: J(z.object({ role: roleEnum })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { adminUserId } = c.req.valid('param');
    const { role } = c.req.valid('json');
    await db.update(s.adminUserStore).set({ role }).where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, st.storeId)));
    return c.json({ ok: true }, 200);
  }),
);

adminSettings.openapi(
  createRoute({
    method: 'delete', path: '/v1/admin/staff/{adminUserId}', summary: 'Revoke a staff member from this store',
    request: { params: z.object({ adminUserId: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 409: { description: 'Cannot remove self', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { adminUserId } = c.req.valid('param');
    if (adminUserId === admin.id) throw new HttpError(409, 'cannot remove your own access');
    await db.delete(s.adminUserStore).where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, st.storeId)));
    return c.json({ ok: true }, 200);
  }),
);
