import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomBytes, createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
// eslint-disable-next-line no-restricted-imports -- Staff/session routes manage global admin-user/session tables; store data access below uses withStore().
import { unsafeUnscopedDb as db, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { normalizeEmail } from '../auth/email.js';
import { sendStaffInvite } from '../email/dispatch.js';
import { env } from '../env.js';
import { assertSafeOutboundUrl, type OutboundUrlLookup } from '../security/outbound-url.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireManage, requirePermission, guard } from './admin-helpers.js';

export const adminSettingsAdvanced = new OpenAPIHono();

export async function sanitizeWebhookEndpointPatch(
  input: { url?: string; topics?: string[]; enabled?: boolean },
  opts: { lookup?: OutboundUrlLookup } = {},
): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = { ...input };
  if (input.url !== undefined) patch.url = await assertSafeOutboundUrl(input.url, opts);
  return patch;
}

// ── webhooks (outbox endpoints) ───────────────────────────────────────────────
adminSettingsAdvanced.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/webhooks', summary: 'List webhook endpoints',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const items = await withStore(st.storeId, async (tx) => tx.select({ id: s.webhookEndpoint.id, url: s.webhookEndpoint.url, topics: s.webhookEndpoint.topics, enabled: s.webhookEndpoint.enabled }).from(s.webhookEndpoint).orderBy(desc(s.webhookEndpoint.createdAt)));
    return c.json({ items }, 200);
  }),
);

adminSettingsAdvanced.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/webhooks', summary: 'Create a webhook endpoint (returns the signing secret once)',
    request: { body: { content: J(z.object({ url: z.string().url(), topics: z.array(z.string()).min(1) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), secret: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requirePermission(st, 'webhooks');
    const b = c.req.valid('json');
    const url = await assertSafeOutboundUrl(b.url);
    const secret = randomBytes(24).toString('hex');
    const id = await withStore(st.storeId, async (tx) => {
      const [w] = await tx.insert(s.webhookEndpoint).values({ storeId: st.storeId, url, topics: b.topics, secret }).returning({ id: s.webhookEndpoint.id });
      return w!.id;
    });
    return c.json({ id, secret }, 200);
  }),
);

adminSettingsAdvanced.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/webhooks/{id}', summary: 'Update a webhook endpoint',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ url: z.string().url().optional(), topics: z.array(z.string()).optional(), enabled: z.boolean().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const patch = await sanitizeWebhookEndpointPatch(b);
    const ok = await withStore(st.storeId, async (tx) => {
      const [w] = await tx.select({ id: s.webhookEndpoint.id }).from(s.webhookEndpoint).where(eq(s.webhookEndpoint.id, id)).limit(1);
      if (!w) return false;
      await tx.update(s.webhookEndpoint).set(patch).where(eq(s.webhookEndpoint.id, id));
      return true;
    });
    if (!ok) throw new HttpError(404, 'webhook not found');
    return c.json({ id }, 200);
  }),
);

adminSettingsAdvanced.openapi(
  createRoute({
    method: 'delete', path: '/v1/admin/webhooks/{id}', summary: 'Delete a webhook endpoint',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { id } = c.req.valid('param');
    await withStore(st.storeId, async (tx) => { await tx.delete(s.webhookDelivery).where(eq(s.webhookDelivery.endpointId, id)); await tx.delete(s.webhookEndpoint).where(eq(s.webhookEndpoint.id, id)); });
    return c.json({ id }, 200);
  }),
);

// ── staff & roles ────────────────────────────────────────────────────────────
const roleEnum = z.enum(['owner', 'manager', 'staff', 'read_only']);

adminSettingsAdvanced.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/staff', summary: 'Staff with access to this store',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    // Include `permissions` from admin_user_store so the UI can render the
    // existing grants without a second round-trip. Unknown keys are kept as-is
    // (they round-trip through PUT with the same preservation rule).
    const items = await db
      .select({
        adminUserId: s.adminUser.id,
        email: s.adminUser.email,
        role: s.adminUserStore.role,
        createdAt: s.adminUser.createdAt,
        permissions: s.adminUserStore.permissions,
      })
      .from(s.adminUserStore)
      .innerJoin(s.adminUser, eq(s.adminUser.id, s.adminUserStore.adminUserId))
      .where(eq(s.adminUserStore.storeId, st.storeId));
    return c.json({
      items: items.map((i) => ({
        adminUserId: i.adminUserId,
        email: i.email,
        role: i.role,
        createdAt: i.createdAt.toISOString(),
        permissions: (i.permissions ?? {}) as Record<string, boolean>,
        isYou: i.email === admin.email,
      })),
    }, 200);
  }),
);

adminSettingsAdvanced.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/staff', summary: 'Add / invite a staff member to this store',
    request: { body: { content: J(z.object({ email: z.string().email(), role: roleEnum.default('staff'), password: z.string().min(8) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ adminUserId: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { email: rawEmail, role, password } = c.req.valid('json');
    const email = normalizeEmail(rawEmail);
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

adminSettingsAdvanced.openapi(
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

adminSettingsAdvanced.openapi(
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

// ── staff invitations + session revocation (P3) ───────────────────────────────
const hashTok = (t: string) => createHash('sha256').update(t).digest('hex');
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

adminSettingsAdvanced.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/staff/invites', summary: 'Invite a staff member (returns a one-time accept token)',
    request: { body: { content: J(z.object({ email: z.string().email(), role: z.enum(['owner', 'manager', 'staff', 'read_only']).default('staff') })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), token: z.string(), acceptUrl: z.string() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const b = c.req.valid('json');
    const token = randomBytes(24).toString('hex');
    const [inv] = await db.insert(s.staffInvite).values({ storeId: st.storeId, email: normalizeEmail(b.email), role: b.role, tokenHash: hashTok(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) }).returning({ id: s.staffInvite.id });
    const acceptUrl = `/admin/accept-invite?token=${token}`;
    // WP2: best-effort invite email. If SMTP is unconfigured the dev log line
    // will surface the token; the response still includes it for the inviter.
    try { await sendStaffInvite({ name: st.name, currency: st.currency }, normalizeEmail(b.email), { acceptUrl: `${env.STOREFRONT_URL}${acceptUrl}`, role: b.role, inviterEmail: admin.email }); } catch (e) { console.error('[email:staffInvite] failed', e); }
    return c.json({ id: inv!.id, token, acceptUrl }, 200);
  }),
);

adminSettingsAdvanced.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/staff/invites', summary: 'List pending invites',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const items = await db.select({ id: s.staffInvite.id, email: s.staffInvite.email, role: s.staffInvite.role, acceptedAt: s.staffInvite.acceptedAt, expiresAt: s.staffInvite.expiresAt }).from(s.staffInvite).where(eq(s.staffInvite.storeId, st.storeId)).orderBy(desc(s.staffInvite.createdAt)).limit(100);
    return c.json({ items: items.map((i) => ({ ...i, acceptedAt: i.acceptedAt?.toISOString() ?? null, expiresAt: i.expiresAt.toISOString() })) }, 200);
  }),
);

// PUBLIC — accept an invite by token (no admin auth; isolation is the token).
adminSettingsAdvanced.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/staff/accept', summary: 'Accept a staff invite + set password',
    request: { body: { content: J(z.object({ token: z.string(), password: z.string().min(8), firstName: z.string().optional(), lastName: z.string().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 409: { description: 'Invalid/expired', ...errBody } },
  }),
  async (c) => {
    const b = c.req.valid('json');
    const [inv] = await db.select().from(s.staffInvite).where(eq(s.staffInvite.tokenHash, hashTok(b.token))).limit(1);
    if (!inv || inv.acceptedAt || inv.expiresAt.getTime() <= Date.now()) throw new HttpError(409, 'invite is invalid, already used, or expired');
    const passwordHash = await hashPassword(b.password);
    const [existing] = await db.select({ id: s.adminUser.id }).from(s.adminUser).where(eq(s.adminUser.email, inv.email)).limit(1);
    const adminId = existing?.id ?? (await db.insert(s.adminUser).values({ email: inv.email, passwordHash }).returning({ id: s.adminUser.id }))[0]!.id;
    if (existing) await db.update(s.adminUser).set({ passwordHash }).where(eq(s.adminUser.id, adminId));
    await db.insert(s.adminUserStore).values({ adminUserId: adminId, storeId: inv.storeId, role: inv.role }).onConflictDoUpdate({ target: [s.adminUserStore.adminUserId, s.adminUserStore.storeId], set: { role: inv.role } });
    await db.update(s.staffInvite).set({ acceptedAt: new Date() }).where(eq(s.staffInvite.id, inv.id));
    return c.json({ ok: true }, 200);
  },
);

adminSettingsAdvanced.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/staff/{adminUserId}/revoke-sessions', summary: 'Force-logout a staff member (revoke all sessions)',
    request: { params: z.object({ adminUserId: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ revoked: z.number().int() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { adminUserId } = c.req.valid('param');
    // ra-sec: sessions are global (RLS-exempt), so scope the action here — confirm
    // the target is enrolled in the caller's store before force-logging them out,
    // or a manager could revoke a superadmin / another store's user by UUID (IDOR).
    const [member] = await db.select({ id: s.adminUserStore.adminUserId }).from(s.adminUserStore).where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, st.storeId))).limit(1);
    if (!member) throw new HttpError(404, 'staff member not enrolled in this store');
    const del = await db.delete(s.session).where(eq(s.session.adminUserId, adminUserId)).returning({ id: s.session.id });
    return c.json({ revoked: del.length }, 200);
  }),
);

// ── currency rates (presentment, display-only) (P3) ───────────────────────────
adminSettingsAdvanced.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/currency-rates', summary: 'List presentment currency rates',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const items = await withStore(st.storeId, async (tx) => tx.select().from(s.currencyRate).orderBy(s.currencyRate.currency));
    return c.json({ items }, 200);
  }),
);

adminSettingsAdvanced.openapi(
  createRoute({
    method: 'put', path: '/v1/admin/currency-rates/{currency}', summary: 'Upsert a presentment rate (×10000 of base)',
    request: { params: z.object({ currency: z.string().length(3) }), body: { content: J(z.object({ rate: z.number().int().min(1), enabled: z.boolean().default(true) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ currency: z.string(), rate: z.number().int() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { currency } = c.req.valid('param');
    const b = c.req.valid('json');
    const cur = currency.toUpperCase();
    await withStore(st.storeId, async (tx) => {
      await tx.insert(s.currencyRate).values({ storeId: st.storeId, currency: cur, rate: b.rate, enabled: b.enabled })
        .onConflictDoUpdate({ target: [s.currencyRate.storeId, s.currencyRate.currency], set: { rate: b.rate, enabled: b.enabled } });
    });
    return c.json({ currency: cur, rate: b.rate }, 200);
  }),
);

// ── per-action staff permissions (P3) ─────────────────────────────────────────
// Backward-compatible PUT: the UI only knows a fixed allow-list of permission
// keys, but the column is a free-form jsonb so other keys may already be set
// (granted by a future feature, or manually by an admin via SQL). We MUST NOT
// erase those unknown keys when the UI saves a partial update — that was the
// long-standing bug where opening the editor + saving wiped a `giftcards: true`
// grant. The merge: start from the stored value, overlay the known UI keys.
const UI_PERMISSION_KEYS = ['giftcards', 'webhooks'] as const;
type UiPermissionKey = typeof UI_PERMISSION_KEYS[number];

export function isUiPermissionKey(k: string): k is UiPermissionKey {
  return (UI_PERMISSION_KEYS as readonly string[]).includes(k);
}

/** Pure merge helper — extracted so the unit test can exercise the round-trip
 *  contract without spinning up a real Postgres. Used by the PUT handler. */
export function mergeStaffPermissions(
  previous: Record<string, boolean> | null,
  next: Record<string, boolean>,
): Record<string, boolean> {
  const prev = previous ?? {};
  const out: Record<string, boolean> = {};
  // Pass through unknown keys untouched.
  for (const [k, v] of Object.entries(prev)) if (!isUiPermissionKey(k)) out[k] = !!v;
  // Overlay known UI keys from the new payload. False is the implicit default
  // for UI keys (not stored) — only true values are persisted.
  for (const k of UI_PERMISSION_KEYS) if (next[k] === true) out[k] = true;
  return out;
}

adminSettingsAdvanced.openapi(
  createRoute({
    method: 'put', path: '/v1/admin/staff/{adminUserId}/permissions', summary: 'Grant per-action permissions to a staff member',
    request: { params: z.object({ adminUserId: z.string() }), body: { content: J(z.object({ permissions: z.record(z.string(), z.boolean()) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ adminUserId: z.string(), permissions: z.record(z.string(), z.boolean()) })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { adminUserId } = c.req.valid('param');
    const b = c.req.valid('json');
    // Reject unknown keys with a clear message so a buggy client can't quietly
    // write the whole map back. This is the only strictness contract — the
    // stored row's unknown keys still round-trip unchanged.
    for (const k of Object.keys(b.permissions)) if (!isUiPermissionKey(k)) throw new HttpError(400, `unknown permission key: ${k}`);
    // The merge is pure: read the previous value, overlay known UI keys, write
    // back. A single UPDATE is fine because the merge happens client-side over
    // the value we just SELECTed — concurrent PUTs to the same member are rare
    // and the resolution is whichever landed last (acceptable: the UI serializes
    // edits from the same operator).
    const [cur] = await db.select({ permissions: s.adminUserStore.permissions }).from(s.adminUserStore).where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, st.storeId))).limit(1);
    if (!cur) throw new HttpError(404, 'staff member not enrolled in this store');
    const next = mergeStaffPermissions((cur.permissions ?? null) as Record<string, boolean> | null, b.permissions);
    await db.update(s.adminUserStore).set({ permissions: next }).where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, st.storeId)));
    return c.json({ adminUserId, permissions: next }, 200);
  }),
);
