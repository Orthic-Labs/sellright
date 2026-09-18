import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomBytes, createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { normalizeEmail } from '../auth/email.js';
import {
  createAdminUser,
  findAdminIdByEmail,
  findInviteByTokenHash,
  listStoreInvites,
  listStoreStaff,
  setAdminPassword,
} from '../auth/admin-staff.js';
import { sendStaffInvite } from '../email/dispatch.js';
import { err as logErr } from '../lib/logger.js';
import { env } from '../env.js';
import { assertSafeOutboundUrl, type OutboundUrlLookup } from '../security/outbound-url.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireManage, requireOwner, requirePermission, guard } from './admin-helpers.js';

export const adminSettingsAdvanced = new OpenAPIHono();

// SR-16: staff / permission / invite mutations below write their audit_log row
// in the SAME withStore transaction as the mutation itself — both commit or
// both roll back, and a denied action throws before the insert so it never
// produces a "success" record. The mutations hit admin_user_store /
// staff_invite / session, which are deliberately RLS-EXEMPT (drizzle/0008,
// 0018, 0025 — they're the global ACL registry), so a store-scoped tx can
// write them; audit_log is tenant_isolation-gated and gets storeId = the
// caller's store, keeping each store's audit rows invisible to other stores.
// Audit payloads never carry passwords, hashes, tokens, or signing secrets.

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
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()) })) }, 401: { description: 'Unauthorized', ...errBody } },
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
      // SR-16: the signing secret is returned once and NEVER written to the
      // audit row — only the non-secret endpoint shape is recorded.
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'webhook_endpoint', entityId: w!.id, action: 'create', data: { url, topics: b.topics } });
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
      const [w] = await tx.select({ id: s.webhookEndpoint.id, url: s.webhookEndpoint.url, topics: s.webhookEndpoint.topics, enabled: s.webhookEndpoint.enabled }).from(s.webhookEndpoint).where(eq(s.webhookEndpoint.id, id)).limit(1);
      if (!w) return false;
      await tx.update(s.webhookEndpoint).set(patch).where(eq(s.webhookEndpoint.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'webhook_endpoint', entityId: id, action: 'update', data: { before: { url: w.url, topics: w.topics, enabled: w.enabled }, after: patch } });
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
    await withStore(st.storeId, async (tx) => {
      const [w] = await tx.select({ url: s.webhookEndpoint.url }).from(s.webhookEndpoint).where(eq(s.webhookEndpoint.id, id)).limit(1);
      await tx.delete(s.webhookDelivery).where(eq(s.webhookDelivery.endpointId, id));
      await tx.delete(s.webhookEndpoint).where(eq(s.webhookEndpoint.id, id));
      if (w) await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'webhook_endpoint', entityId: id, action: 'delete', data: { url: w.url } });
    });
    return c.json({ id }, 200);
  }),
);

// ── staff & roles ────────────────────────────────────────────────────────────
const roleEnum = z.enum(['owner', 'manager', 'staff', 'read_only']);

adminSettingsAdvanced.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/staff', summary: 'Staff with access to this store',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    // Include `permissions` from admin_user_store so the UI can render the
    // existing grants without a second round-trip. Unknown keys are kept as-is
    // (they round-trip through PUT with the same preservation rule).
    const items = await listStoreStaff(st.storeId);
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
    // SEC-OWNER-1: only an existing owner may grant the 'owner' role.
    if (role === 'owner') requireOwner(st);
    const email = normalizeEmail(rawEmail);
    let adminUserId = await findAdminIdByEmail(email);
    if (!adminUserId) {
      adminUserId = await createAdminUser(email, await hashPassword(password));
    }
    // SR-16: the store-scoped grant (admin_user_store is RLS-exempt — see
    // drizzle/0008 — so a withStore tx can write it) and its audit row commit
    // or roll back together. The password never leaves this handler.
    const uid = adminUserId;
    await withStore(st.storeId, async (tx) => {
      await tx
        .insert(s.adminUserStore)
        .values({ adminUserId: uid, storeId: st.storeId, role })
        .onConflictDoUpdate({ target: [s.adminUserStore.adminUserId, s.adminUserStore.storeId], set: { role } });
      await tx.insert(s.auditLog).values({
        storeId: st.storeId,
        actor: admin.email,
        entity: 'staff',
        entityId: uid,
        action: 'add',
        toState: role,
        data: { email },
      });
    });
    return c.json({ adminUserId }, 200);
  }),
);

adminSettingsAdvanced.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/staff/{adminUserId}', summary: 'Change a staff member role',
    request: { params: z.object({ adminUserId: z.string() }), body: { content: J(z.object({ role: roleEnum })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 403: { description: 'Owner-only', ...errBody }, 409: { description: 'Would remove the last owner', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { adminUserId } = c.req.valid('param');
    const { role } = c.req.valid('json');
    // SEC-OWNER-1: a manager passes requireManage() above but must not be able
    // to grant themselves (or anyone) 'owner', nor to demote the real owner —
    // either direction requires the CALLER to already be an owner.
    //
    // SR-16: check + role write + audit row run in ONE transaction (the row is
    // FOR UPDATE locked, so the last-owner check can't race; admin_user_store
    // is RLS-exempt — drizzle/0008 — so a withStore tx can write it). A denied
    // change throws before the audit insert and rolls back — no phantom record.
    await withStore(st.storeId, async (tx) => {
      const [m] = await tx
        .select({ role: s.adminUserStore.role })
        .from(s.adminUserStore)
        .where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, st.storeId)))
        .for('update')
        .limit(1);
      const currentRole = m?.role ?? null;
      if (role === 'owner' || currentRole === 'owner') requireOwner(st);
      // Even an owner can't demote the last remaining owner — that would
      // leave the store with nobody able to grant owner access again.
      if (currentRole === 'owner' && role !== 'owner') {
        const owners = await tx
          .select({ id: s.adminUserStore.adminUserId })
          .from(s.adminUserStore)
          .where(and(eq(s.adminUserStore.storeId, st.storeId), eq(s.adminUserStore.role, 'owner')));
        if (owners.length <= 1) throw new HttpError(409, 'cannot demote the last remaining owner');
      }
      if (currentRole === null) throw new HttpError(404, 'staff member not enrolled in this store');
      await tx
        .update(s.adminUserStore)
        .set({ role })
        .where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, st.storeId)));
      await tx.insert(s.auditLog).values({
        storeId: st.storeId,
        actor: admin.email,
        entity: 'staff',
        entityId: adminUserId,
        action: 'role_change',
        fromState: currentRole,
        toState: role,
      });
    });
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
    // SEC-OWNER-1: removing an owner requires the CALLER to be an owner, and
    // even an owner can't remove the last remaining owner.
    // SR-16: check + delete + audit row share one transaction — see PATCH above.
    await withStore(st.storeId, async (tx) => {
      const [m] = await tx
        .select({ role: s.adminUserStore.role })
        .from(s.adminUserStore)
        .where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, st.storeId)))
        .for('update')
        .limit(1);
      const targetRole = m?.role ?? null;
      if (targetRole === 'owner') {
        requireOwner(st);
        const owners = await tx
          .select({ id: s.adminUserStore.adminUserId })
          .from(s.adminUserStore)
          .where(and(eq(s.adminUserStore.storeId, st.storeId), eq(s.adminUserStore.role, 'owner')));
        if (owners.length <= 1) throw new HttpError(409, 'cannot remove the last remaining owner');
      }
      await tx
        .delete(s.adminUserStore)
        .where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, st.storeId)));
      if (targetRole !== null) {
        await tx.insert(s.auditLog).values({
          storeId: st.storeId,
          actor: admin.email,
          entity: 'staff',
          entityId: adminUserId,
          action: 'remove',
          fromState: targetRole,
        });
      }
    });
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
    // SEC-OWNER-1: same owner-only gate as direct staff creation.
    if (b.role === 'owner') requireOwner(st);
    const token = randomBytes(24).toString('hex');
    // SR-16: invite insert + audit row in one transaction. The raw token is
    // never persisted anywhere but the response — only its sha256 hash is
    // stored, and the audit row carries email/role, not the token or hash.
    const invId = await withStore(st.storeId, async (tx) => {
      const [inv] = await tx
        .insert(s.staffInvite)
        .values({ storeId: st.storeId, email: normalizeEmail(b.email), role: b.role, tokenHash: hashTok(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) })
        .returning({ id: s.staffInvite.id });
      await tx.insert(s.auditLog).values({
        storeId: st.storeId,
        actor: admin.email,
        entity: 'staff_invite',
        entityId: inv!.id,
        action: 'create',
        data: { email: normalizeEmail(b.email), role: b.role },
      });
      return inv!.id;
    });
    const acceptUrl = `/admin/accept-invite?token=${token}`;
    // WP2: best-effort invite email. If SMTP is unconfigured the dev log line
    // will surface the token; the response still includes it for the inviter.
    try { await sendStaffInvite({ name: st.name, currency: st.currency }, normalizeEmail(b.email), { acceptUrl: `${env.STOREFRONT_URL}${acceptUrl}`, role: b.role, inviterEmail: admin.email }); } catch (e) { logErr.error('email staffInvite failed', e, { inviteEmail: b.email }); }
    return c.json({ id: invId, token, acceptUrl }, 200);
  }),
);

adminSettingsAdvanced.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/staff/invites', summary: 'List pending invites',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const items = await listStoreInvites(st.storeId);
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
    const inv = await findInviteByTokenHash(hashTok(b.token));
    if (!inv || inv.acceptedAt || inv.expiresAt.getTime() <= Date.now()) throw new HttpError(409, 'invite is invalid, already used, or expired');
    const passwordHash = await hashPassword(b.password);
    let adminId = await findAdminIdByEmail(inv.email);
    if (adminId) {
      // Existing admin accepting a new invite — refresh the password they
      // just provided (gated by the invite token; the route doesn't require
      // the prior password because the invite is the proof of intent).
      await setAdminPassword(adminId, passwordHash);
    } else {
      adminId = await createAdminUser(inv.email, passwordHash);
    }
    // SR-16: the attach + invite-acceptance + audit row commit atomically.
    // Actor is the invitee themselves — this is a public, token-gated route.
    // The password hash never touches the audit row.
    const uid = adminId;
    await withStore(inv.storeId, async (tx) => {
      const role = inv.role as 'owner' | 'manager' | 'staff' | 'read_only';
      await tx
        .insert(s.adminUserStore)
        .values({ adminUserId: uid, storeId: inv.storeId, role })
        .onConflictDoUpdate({ target: [s.adminUserStore.adminUserId, s.adminUserStore.storeId], set: { role } });
      await tx.update(s.staffInvite).set({ acceptedAt: new Date() }).where(eq(s.staffInvite.id, inv.id));
      await tx.insert(s.auditLog).values({
        storeId: inv.storeId,
        actor: `invite:${inv.email}`,
        entity: 'staff',
        entityId: uid,
        action: 'accept_invite',
        toState: inv.role,
        data: { email: inv.email, inviteId: inv.id },
      });
    });
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
    // SR-16: enrollment check + session delete + audit row in one transaction.
    const revoked = await withStore(st.storeId, async (tx) => {
      const [m] = await tx
        .select({ id: s.adminUserStore.adminUserId })
        .from(s.adminUserStore)
        .where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, st.storeId)))
        .limit(1);
      if (!m) throw new HttpError(404, 'staff member not enrolled in this store');
      const del = await tx.delete(s.session).where(eq(s.session.adminUserId, adminUserId)).returning({ id: s.session.id });
      await tx.insert(s.auditLog).values({
        storeId: st.storeId,
        actor: admin.email,
        entity: 'staff',
        entityId: adminUserId,
        action: 'revoke_sessions',
        data: { revoked: del.length },
      });
      return del.length;
    });
    return c.json({ revoked }, 200);
  }),
);

// ── currency rates (presentment, display-only) (P3) ───────────────────────────
adminSettingsAdvanced.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/currency-rates', summary: 'List presentment currency rates',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()) })) }, 401: { description: 'Unauthorized', ...errBody } },
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
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'currency_rate', entityId: cur, action: 'upsert', data: { rate: b.rate, enabled: b.enabled } });
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
const UI_PERMISSION_KEYS = ['giftcards', 'webhooks', 'refunds', 'cancel_orders', 'releases'] as const;
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
    // SR-16: read + merge + write + audit row share one transaction (FOR UPDATE
    // so the "before" snapshot and the merge can't interleave with a second
    // writer). Permission maps are the whole payload — they hold capability
    // flags only, never secrets.
    const next = await withStore(st.storeId, async (tx) => {
      const [cur] = await tx
        .select({ permissions: s.adminUserStore.permissions })
        .from(s.adminUserStore)
        .where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, st.storeId)))
        .for('update')
        .limit(1);
      if (!cur) throw new HttpError(404, 'staff member not enrolled in this store');
      const before = (cur.permissions ?? null) as Record<string, boolean> | null;
      const merged = mergeStaffPermissions(before, b.permissions);
      await tx
        .update(s.adminUserStore)
        .set({ permissions: merged })
        .where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, st.storeId)));
      await tx.insert(s.auditLog).values({
        storeId: st.storeId,
        actor: admin.email,
        entity: 'staff',
        entityId: adminUserId,
        action: 'permissions_update',
        data: { before, after: merged },
      });
      return merged;
    });
    return c.json({ adminUserId, permissions: next }, 200);
  }),
);
