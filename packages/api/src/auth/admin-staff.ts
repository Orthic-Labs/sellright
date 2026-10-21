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
import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { unsafeUnscopedDb as db } from '../db/client.js';
import * as s from '../db/schema.js';
import { createHash } from 'node:crypto';
import { env } from '../env.js';
import { regenerateRecoveryCodesTx, deleteRecoveryCodes, verifySecondFactorTx } from './second-factor.js';
import { totpRequiredFor } from './mfa-policy.js';
import { normalizeEmail } from './email.js';
import { openTotpSecret, sealTotpSecret } from './totp-secret.js';

// ── 2FA (admin_user.totpSecret) ───────────────────────────────────────────────

/** Read the current 2FA secret for an admin. null = not enabled. */
export async function getAdminTotpSecret(adminId: string): Promise<string | null> {
  const [u] = await db
    .select({ totpSecret: s.adminUser.totpSecret })
    .from(s.adminUser)
    .where(eq(s.adminUser.id, adminId))
    .limit(1);
  return openTotpSecret(adminId, u?.totpSecret);
}

/** Both credential facts POST /v1/admin/step-up needs in one query: the
 *  password hash to verify against, and whether TOTP must additionally be
 *  checked (a null/absent totpSecret means 2FA isn't enabled — password
 *  alone is the full step-up, same as login's own rule). */
export async function getAdminCredentialsById(adminId: string): Promise<{ passwordHash: string | null; totpSecret: string | null; totpVersion: string | null ; securityEpoch: number } | null> {
  const [u] = await db
    .select({ passwordHash: s.adminUser.passwordHash, totpSecret: s.adminUser.totpSecret , securityEpoch: s.adminUser.securityEpoch })
    .from(s.adminUser)
    .where(eq(s.adminUser.id, adminId))
    .limit(1);
  return u ? { passwordHash: u.passwordHash, totpSecret: openTotpSecret(adminId, u.totpSecret), totpVersion: u.totpSecret, securityEpoch: u.securityEpoch } : null;
}

/** Set the TOTP secret (called from /v1/admin/2fa/enable after a code is confirmed). Sealed at rest
 *  with the master key (auth/totp-secret.ts). */
export async function setAdminTotpSecret(adminId: string, secret: string): Promise<void> {
  await db.update(s.adminUser).set({ totpSecret: sealTotpSecret(adminId, secret) }).where(eq(s.adminUser.id, adminId));
}

/** Commit a verified factor mutation only while its credential snapshot & calling session remain current.
 * Factor, recovery-code replacement & session revocation share one transaction, serialized per admin.
 * Slow password/factor proof happens before this call; its results cannot resurrect superseded credentials. */
export class AdminFactorMutationError extends Error {
  constructor(readonly code: 'TOTP_REQUIRED' | 'INVALID_FACTOR' | 'PASSKEYS_ENROLLED') { super(code); }
}
export async function mutateAdminSecondFactor(input: {
  adminId: string; token: string; passwordHash: string | null; totpSecret: string | null; totpVersion: string | null;
  /** 0108: the security_epoch captured with the credential snapshot; a mutation whose proof predates an epoch change is refused. */
  securityEpoch?: number;
  /** 0108: receipt of a recovery code consumed outside this transaction (route-level proof); must still be current. */
  receipt?: { id: string; usedAt: Date };
  action: 'enable' | 'disable' | 'recovery'; secret?: string; code?: string;
}): Promise<{ recoveryCodes: string[] } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-credentials:' + input.adminId}, 0))`);
    const [admin] = await tx.select({ passwordHash: s.adminUser.passwordHash, secret: s.adminUser.totpSecret,
      kind: s.adminUser.kind, isInstallationAdmin: s.adminUser.isInstallationAdmin, epoch: s.adminUser.securityEpoch })
      .from(s.adminUser).where(eq(s.adminUser.id, input.adminId)).for('update').limit(1);
    if (!admin || admin.passwordHash !== input.passwordHash || admin.secret !== input.totpVersion) return null;
    if (input.securityEpoch !== undefined && admin.epoch !== input.securityEpoch) return null;
    if (input.receipt) {
      const [rc] = await tx.select({ usedAt: s.adminRecoveryCode.usedAt }).from(s.adminRecoveryCode).where(eq(s.adminRecoveryCode.id, input.receipt.id)).limit(1);
      if (!rc?.usedAt || rc.usedAt.getTime() !== input.receipt.usedAt.getTime()) return null;
    }
    const tokenHash = createHash('sha256').update(input.token).digest('hex');
    const idle = env.ADMIN_SESSION_IDLE_HOURS;
    const [session] = await tx.select({ id: s.session.id, expiresAt: s.session.expiresAt, lastSeenAt: s.session.lastSeenAt, createdAt: s.session.createdAt }).from(s.session)
      .where(and(eq(s.session.tokenHash, tokenHash), eq(s.session.adminUserId, input.adminId),
        sql`${s.session.expiresAt} > clock_timestamp()`,
        sql`(${idle}::float8 <= 0 OR coalesce(${s.session.lastSeenAt}, ${s.session.createdAt}) > clock_timestamp() - make_interval(secs => ${idle}::float8 * 3600))`))
      .for('update').limit(1);
    if (!session || session.expiresAt.getTime() <= Date.now() || (idle > 0 && (session.lastSeenAt ?? session.createdAt).getTime() <= Date.now() - idle * 3600000)) return null;
    if (input.action === 'disable') {
      // 0108 TOTP invariant (design §7): with a passkey enrolled the second factor stays; recovery codes remain the
      // universal recovery factor. Checked under the admin_user lock the registration path also takes.
      const [pk] = await tx.select({ n: count() }).from(s.adminPasskeyCredential).where(eq(s.adminPasskeyCredential.adminUserId, input.adminId));
      if (Number(pk?.n ?? 0) > 0) throw new AdminFactorMutationError('PASSKEYS_ENROLLED');
      // Global credential row precedes membership & store locks. Its FK lock
      // also prevents a new membership from appearing during this decision.
      const memberships = await tx.select().from(s.adminUserStore).where(eq(s.adminUserStore.adminUserId, input.adminId))
        .orderBy(s.adminUserStore.storeId).for('share');
      const stores = memberships.length ? await tx.select().from(s.store).where(inArray(s.store.id, memberships.map(m => m.storeId)))
        .orderBy(s.store.id).for('share') : [];
      const required = totpRequiredFor({ kind: admin.kind === 'agent' ? 'agent' : 'human', isInstallationAdmin: admin.isInstallationAdmin,
        stores: memberships.map(m => {
          const store = stores.find(store => store.id === m.storeId);
          if (!store) throw new Error('Admin store policy missing');
          const config = store.config as { security?: { requireTotp?: unknown } } | null;
          return { storeId: store.id, slug: store.slug, name: store.name, currency: store.currency, taxRate: store.taxRate,
            shippingTaxable: store.shippingTaxable, role: m.role, permissions: null, requireTotp: config?.security?.requireTotp === true };
        }) });
      if (required) throw new AdminFactorMutationError('TOTP_REQUIRED');
      // Proof consumption must follow policy & share its transaction: refusal
      // cannot consume a recovery code or advance the durable TOTP replay guard.
      if (!input.totpSecret || !await verifySecondFactorTx(input.adminId, input.totpSecret, input.code, tx)) {
        throw new AdminFactorMutationError('INVALID_FACTOR');
      }
    }
    if (input.action === 'enable') {
      if (input.totpSecret || !input.secret) return null;
      await tx.update(s.adminUser).set({ totpSecret: sealTotpSecret(input.adminId, input.secret) }).where(eq(s.adminUser.id, input.adminId));
      await tx.delete(s.session).where(and(eq(s.session.adminUserId, input.adminId), ne(s.session.id, session.id)));
    } else if (input.action === 'disable') {
      await tx.update(s.adminUser).set({ totpSecret: null }).where(eq(s.adminUser.id, input.adminId));
      await deleteRecoveryCodes(input.adminId, tx);
      return { recoveryCodes: [] };
    } else if (!input.totpSecret) return null;
    return { recoveryCodes: await regenerateRecoveryCodesTx(input.adminId, tx) };
  });
}

/** Replace an admin's password hash (POST /v1/admin/password, after the route re-verified the current
 *  password and a recent step-up). Never called by invite or staff-management flows. */
export async function setAdminPasswordHash(adminId: string, passwordHash: string): Promise<void> {
  await db.update(s.adminUser).set({ passwordHash }).where(eq(s.adminUser.id, adminId));
}

/** Clear the TOTP secret (called from /v1/admin/2fa/disable). */
export async function clearAdminTotpSecret(adminId: string): Promise<void> {
  await db.update(s.adminUser).set({ totpSecret: null }).where(eq(s.adminUser.id, adminId));
}

/** Credential facts for an existing admin, looked up by (normalized) email. Used by the
 *  staff-invite accept flow: an invite token alone NEVER changes an existing account's
 *  password or role — the existing admin must prove their current password (+ TOTP) or
 *  accept from their own session (P0, security audit 2026-10-15). null when no account. */
export async function findAdminCredentialsByEmail(email: string): Promise<{ id: string; kind: string; passwordHash: string | null; totpSecret: string | null; totpVersion: string | null; securityEpoch: number } | null> {
  const [u] = await db
    .select({ id: s.adminUser.id, kind: s.adminUser.kind, passwordHash: s.adminUser.passwordHash, totpSecret: s.adminUser.totpSecret, securityEpoch: s.adminUser.securityEpoch })
    .from(s.adminUser)
    .where(eq(s.adminUser.email, normalizeEmail(email)))
    .limit(1);
  return u ? { ...u, totpVersion: u.totpSecret, totpSecret: openTotpSecret(u.id, u.totpSecret) } : null;
}

// ── staff (admin_user_store ACL) ──────────────────────────────────────────────

/** List staff for a store with email + role + permissions, denormalized via the
 *  admin_user join. UI consumer. */
export async function listStoreStaff(storeId: string): Promise<
  Array<{ adminUserId: string; email: string; kind: string; role: string; createdAt: Date; permissions: unknown }>
> {
  return db
    .select({
      adminUserId: s.adminUser.id,
      email: s.adminUser.email,
      kind: s.adminUser.kind,
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

/** Identity kind of an admin by exact (normalized) email, or null when no such admin. Agents are never created or invited through staff paths. */
export async function adminKindByEmail(email: string): Promise<'human' | 'agent' | null> {
  const [u] = await db.select({ kind: s.adminUser.kind }).from(s.adminUser).where(eq(s.adminUser.email, normalizeEmail(email))).limit(1);
  return u ? (u.kind === 'agent' ? 'agent' : 'human') : null;
}

/** Identity kind of an admin by id, or null when no such admin. */
export async function adminKindById(id: string): Promise<'human' | 'agent' | null> {
  const [u] = await db.select({ kind: s.adminUser.kind }).from(s.adminUser).where(eq(s.adminUser.id, id)).limit(1);
  return u ? (u.kind === 'agent' ? 'agent' : 'human') : null;
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

/** Current role of one staff member within a store, or null if not enrolled.
 *  SEC-OWNER-1: used by the staff PATCH/DELETE routes to check the TARGET's
 *  role before allowing a mutation, not just the caller's. */
export async function getStaffRole(adminUserId: string, storeId: string): Promise<string | null> {
  const [m] = await db
    .select({ role: s.adminUserStore.role })
    .from(s.adminUserStore)
    .where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, storeId)))
    .limit(1);
  return m?.role ?? null;
}

/** Count how many admins hold the 'owner' role in a store. SEC-OWNER-1: used
 *  to block demoting/removing the last remaining owner. */
export async function countStoreOwners(storeId: string): Promise<number> {
  const rows = await db
    .select({ adminUserId: s.adminUserStore.adminUserId })
    .from(s.adminUserStore)
    .where(and(eq(s.adminUserStore.storeId, storeId), eq(s.adminUserStore.role, 'owner')));
  return rows.length;
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
  return db.transaction(async (tx) => {
    // 0108 (design §5): owner row first, then the session rows.
    await tx.select({ id: s.adminUser.id }).from(s.adminUser).where(eq(s.adminUser.id, adminUserId)).for('update');
    const del = await tx.delete(s.session).where(eq(s.session.adminUserId, adminUserId)).returning({ id: s.session.id });
    return del.length;
  });
}

// ── recovery kit (plan §1.10) ─────────────────────────────────────────────────

/** Whether — and when — this admin (must be the installation admin; callers
 *  check requireInstallationAdmin/isInstallationAdmin themselves) has ever
 *  downloaded the recovery kit. Used by the Publish readiness gate. */
export async function getRecoveryKitDownloadedAt(adminId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: s.adminUser.recoveryKitDownloadedAt })
    .from(s.adminUser)
    .where(eq(s.adminUser.id, adminId))
    .limit(1);
  return row?.at ?? null;
}

/** Records that the recovery kit was just downloaded (GET /v1/admin/system/
 *  recovery-kit). Idempotent — re-downloading only refreshes the timestamp. */
export async function markRecoveryKitDownloaded(adminId: string): Promise<void> {
  await db.update(s.adminUser).set({ recoveryKitDownloadedAt: new Date() }).where(eq(s.adminUser.id, adminId));
}

// NOTE: stale-invite cleanup is intentionally not exposed here yet — the
// accepted/expiry invariant is enforced at the accept route, and a hard
// delete of expired rows is a future jobs/ cleanup concern (would need a
// `revokedAt` column or a separate `staff_invite_archive` table to avoid
// losing the audit trail). Keeping the housekeeping out until the cleanup
// story is concrete avoids landing a half-built function that pretends to
// do work.
