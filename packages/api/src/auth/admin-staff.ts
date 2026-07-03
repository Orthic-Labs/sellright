/**
 * Cross-store admin / staff / invite / session operations.
 *
 * Why this lives here and not in src/routes/:
 *   - Routes are lint-blocked from importing `unsafeUnscopedDb` (no-restricted-
 *     imports in eslint.config.mjs) so they MUST go through withStore(). But the
 *     admin_user / admin_user_store / staff_invite / session tables are
 *     deliberately NOT store-scoped — they're the global registry that gates
 *     access TO stores. The audit flagged the eslint-disable on
 *     admin-settings.ts and admin-settings-advanced.ts as a regression risk
 *     (ra-005): a blanket suppression means a future change adding a
 *     withStore-required query to these files would slip through lint.
 *   - Extracting the queries into a non-routes module keeps routes as thin
 *     shells, removes the lint suppression entirely, and centralizes the IDOR
 *     and "global tables are global" invariants in one auditable file.
 */
import { and, desc, eq } from 'drizzle-orm';
import { unsafeUnscopedDb as db } from '../db/client.js';
import * as s from '../db/schema.js';
import { normalizeEmail } from './email.js';

// ── 2FA (admin_user.totpSecret) ───────────────────────────────────────────────

/** Read the current 2FA secret for an admin. null = not enabled. */
export async function getAdminTotpSecret(adminId: string): Promise<string | null> {
  const [u] = await db
    .select({ totpSecret: s.adminUser.totpSecret })
    .from(s.adminUser)
    .where(eq(s.adminUser.id, adminId))
    .limit(1);
  return u?.totpSecret ?? null;
}

/** Set the TOTP secret (called from /v1/admin/2fa/enable after a code is confirmed). */
export async function setAdminTotpSecret(adminId: string, secret: string): Promise<void> {
  await db.update(s.adminUser).set({ totpSecret: secret }).where(eq(s.adminUser.id, adminId));
}

/** Clear the TOTP secret (called from /v1/admin/2fa/disable). */
export async function clearAdminTotpSecret(adminId: string): Promise<void> {
  await db.update(s.adminUser).set({ totpSecret: null }).where(eq(s.adminUser.id, adminId));
}

/** Update an admin's password (used by the staff-invite accept flow when the
 *  inviter-email already has an account; the freshly-supplied password replaces
 *  the prior hash, gated by the invite token's own validation). */
export async function setAdminPassword(adminId: string, passwordHash: string): Promise<void> {
  await db.update(s.adminUser).set({ passwordHash }).where(eq(s.adminUser.id, adminId));
}

// ── staff (admin_user_store ACL) ──────────────────────────────────────────────

/** List staff for a store with email + role + permissions, denormalized via the
 *  admin_user join. UI consumer. */
export async function listStoreStaff(storeId: string): Promise<
  Array<{ adminUserId: string; email: string; role: string; createdAt: Date; permissions: unknown }>
> {
  return db
    .select({
      adminUserId: s.adminUser.id,
      email: s.adminUser.email,
      role: s.adminUserStore.role,
      createdAt: s.adminUser.createdAt,
      permissions: s.adminUserStore.permissions,
    })
    .from(s.adminUserStore)
    .innerJoin(s.adminUser, eq(s.adminUser.id, s.adminUserStore.adminUserId))
    .where(eq(s.adminUserStore.storeId, storeId));
}

/** Find an admin by exact (normalized) email, returning only the columns the
 *  staff-invite / 2FA flows need. null when no such admin. */
export async function findAdminIdByEmail(email: string): Promise<string | null> {
  const [existing] = await db
    .select({ id: s.adminUser.id })
    .from(s.adminUser)
    .where(eq(s.adminUser.email, normalizeEmail(email)))
    .limit(1);
  return existing?.id ?? null;
}

/** Create a new admin_user row, returning the id. Password has already been
 *  hashed by the caller. */
export async function createAdminUser(email: string, passwordHash: string): Promise<string> {
  const [u] = await db
    .insert(s.adminUser)
    .values({ email: normalizeEmail(email), passwordHash })
    .returning({ id: s.adminUser.id });
  return u!.id;
}

/** Idempotently attach an admin to a store with a role. Existing attachment's
 *  role is updated to the new value. */
export async function attachStaffToStore(
  adminUserId: string,
  storeId: string,
  role: 'owner' | 'manager' | 'staff' | 'read_only',
): Promise<void> {
  await db
    .insert(s.adminUserStore)
    .values({ adminUserId, storeId, role })
    .onConflictDoUpdate({
      target: [s.adminUserStore.adminUserId, s.adminUserStore.storeId],
      set: { role },
    });
}

/** Update a single staff member's role within a store. */
export async function updateStaffRole(
  adminUserId: string,
  storeId: string,
  role: 'owner' | 'manager' | 'staff' | 'read_only',
): Promise<void> {
  await db
    .update(s.adminUserStore)
    .set({ role })
    .where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, storeId)));
}

/** Detach a staff member from a store. The admin_user row itself is preserved
 *  so they can still log in (and be re-invited to other stores). */
export async function removeStaffFromStore(adminUserId: string, storeId: string): Promise<void> {
  await db
    .delete(s.adminUserStore)
    .where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, storeId)));
}

/** True iff the admin is enrolled in this store (used as an IDOR guard before
 *  any cross-store action: revoke-sessions, change-role, etc.). */
export async function isStaffInStore(adminUserId: string, storeId: string): Promise<boolean> {
  const [m] = await db
    .select({ id: s.adminUserStore.adminUserId })
    .from(s.adminUserStore)
    .where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, storeId)))
    .limit(1);
  return !!m;
}

/** Read the current permissions JSONB for a store member. null when not enrolled
 *  or when no permissions have ever been set. */
export async function getStaffPermissions(
  adminUserId: string,
  storeId: string,
): Promise<Record<string, boolean> | null> {
  const [cur] = await db
    .select({ permissions: s.adminUserStore.permissions })
    .from(s.adminUserStore)
    .where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, storeId)))
    .limit(1);
  return (cur?.permissions ?? null) as Record<string, boolean> | null;
}

/** Persist a merged permissions JSONB. Caller is responsible for the merge
 *  (see admin-settings-advanced.ts mergeStaffPermissions — the merge is pure
 *  and unit-tested). */
export async function setStaffPermissions(
  adminUserId: string,
  storeId: string,
  permissions: Record<string, boolean>,
): Promise<void> {
  await db
    .update(s.adminUserStore)
    .set({ permissions })
    .where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, storeId)));
}

// ── staff invites ────────────────────────────────────────────────────────────

/** Insert a new invite row; returns the row id. The raw token is the caller's
 *  responsibility (and lives only in the response — the DB only sees the hash). */
export async function createStaffInvite(
  storeId: string,
  email: string,
  role: 'owner' | 'manager' | 'staff' | 'read_only',
  tokenHash: string,
  expiresAt: Date,
): Promise<string> {
  const [inv] = await db
    .insert(s.staffInvite)
    .values({ storeId, email: normalizeEmail(email), role, tokenHash, expiresAt })
    .returning({ id: s.staffInvite.id });
  return inv!.id;
}

/** List pending invites for a store (most recent first, capped at 100). */
export async function listStoreInvites(
  storeId: string,
): Promise<Array<{ id: string; email: string; role: string; acceptedAt: Date | null; expiresAt: Date }>> {
  return db
    .select({
      id: s.staffInvite.id,
      email: s.staffInvite.email,
      role: s.staffInvite.role,
      acceptedAt: s.staffInvite.acceptedAt,
      expiresAt: s.staffInvite.expiresAt,
    })
    .from(s.staffInvite)
    .where(eq(s.staffInvite.storeId, storeId))
    .orderBy(desc(s.staffInvite.createdAt))
    .limit(100);
}

/** Look up an invite by its hashed token. Returns the full row (incl.
 *  acceptedAt + expiresAt) so the caller can validate the lifecycle. */
export async function findInviteByTokenHash(tokenHash: string) {
  const [inv] = await db.select().from(s.staffInvite).where(eq(s.staffInvite.tokenHash, tokenHash)).limit(1);
  return inv ?? null;
}

/** Mark an invite as accepted. The session/attach work happens in the route
 *  (needs the auth chain + the caller-chosen password). */
export async function markInviteAccepted(inviteId: string): Promise<void> {
  await db.update(s.staffInvite).set({ acceptedAt: new Date() }).where(eq(s.staffInvite.id, inviteId));
}

// ── session revoke (force-logout) ─────────────────────────────────────────────

/** Revoke every session for an admin. Returns the number revoked. The route
 *  MUST have already verified the target is enrolled in the caller's store
 *  (use isStaffInStore) — sessions are global and not RLS-gated, so this is
 *  the only thing preventing a manager from kicking a superadmin. */
export async function revokeAllSessionsForAdmin(adminUserId: string): Promise<number> {
  const del = await db.delete(s.session).where(eq(s.session.adminUserId, adminUserId)).returning({ id: s.session.id });
  return del.length;
}

// NOTE: stale-invite cleanup is intentionally not exposed here yet — the
// accepted/expiry invariant is enforced at the accept route, and a hard
// delete of expired rows is a future jobs/ cleanup concern (would need a
// `revokedAt` column or a separate `staff_invite_archive` table to avoid
// losing the audit trail). Keeping the housekeeping out until the cleanup
// story is concrete avoids landing a half-built function that pretends to
// do work.
