import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull, ne, sql } from 'drizzle-orm';
import { totpRequiredFor } from './mfa-policy.js';
import { unsafeUnscopedDb as db, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { normalizeEmail } from './email.js';
import { env } from '../env.js';
import { openTotpSecret } from './totp-secret.js';

/** Absolute admin session lifetime (P2: ADMIN_SESSION_TTL_DAYS, default 14). */
export const adminSessionTtlMs = () => env.ADMIN_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
/** Idle timeout (P2: ADMIN_SESSION_IDLE_HOURS, default 12; 0 = off). */
const adminSessionIdleMs = () => env.ADMIN_SESSION_IDLE_HOURS * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60_000;
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export interface AdminStoreAccess {
  storeId: string;
  slug: string;
  name: string;
  currency: string;
  taxRate: number;
  shippingTaxable: boolean;
  role: 'owner' | 'manager' | 'staff' | 'read_only';
  permissions: Record<string, boolean> | null;
  /** store.config.security.requireTotp — this store requires TOTP for its owners/managers (P1b). */
  requireTotp?: boolean;
}

export interface AdminPrincipal {
  id: string;
  email: string;
  /** 'agent' = API-token identity (docs/plans/2026-10-10-agent-role-v5.md); 'human' = everyone else. */
  kind: 'human' | 'agent';
  /** How this request authenticated: a cookie/bearer session, or an `sra_` API token directly. */
  auth: 'session' | 'api_token';
  /** The admin_api_token that minted/authenticates this principal (agents only), else null. */
  apiTokenId: string | null;
  /** Install-wide authority (plan §1.3) — distinct from any per-store 'owner'
   *  role. Gates system operations (backup/restore, recovery-kit download,
   *  add-store). See requireInstallationAdmin() in admin-helpers.ts. */
  isInstallationAdmin: boolean;
  /** When THIS session last re-verified the admin's password (+ TOTP if
   *  enabled) via POST /v1/admin/step-up, or null if never. Per-session, not
   *  per-admin — see requireStepUp() in routes/admin-helpers.ts. */
  stepUpAt: Date | null;
  /** 0108: the owner's security_epoch this session's step-up was earned under (null = unusable for epoch-aware
   *  consumers, incl. a step-up written by an older engine). See requireStepUpEpoch() in routes/admin-helpers.ts. */
  stepUpEpoch: number | null;
  /** 0108: the admin_user.security_epoch at resolution time (bumped by trigger on logical TOTP changes). */
  securityEpoch: number;
  stores: AdminStoreAccess[];
  /** The session row this request authenticated with (admin sessions only). */
  sessionId?: string;
  /** When that session was created (issue #333: a freshly signed-in, not-yet-enrolled session enrols without re-entry). */
  sessionCreatedAt?: Date;
  /** P1b: the admin has a TOTP secret enrolled. Absent for agents. */
  totpEnabled?: boolean;
  /** Issue #333: the admin has at least one passkey — a second factor on its own. Absent for agents. */
  passkeyEnabled?: boolean;
  /** Issue #333 review: a password reset put this account's passkeys under review (see mfa-policy.ts REVIEW_ALLOWED). */
  passkeyReviewRequired?: boolean;
  /** P1b: policy (auth/mfa-policy.ts) requires TOTP for this admin. */
  totpRequired?: boolean;
}

/**
 * Create an admin session, return the raw token (only the hash is stored).
 * Admin sessions are global (not bound to a store). On each request the admin
 * selects a store via x-store-slug; resolveAdmin() loads the ACL and returns
 * only the stores this admin is actually enrolled in.
 */
export async function createAdminSession(adminUserId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await db.insert(s.session).values({
    adminUserId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + adminSessionTtlMs()),
    lastSeenAt: new Date(),
  });
  return token;
}

/**
 * Sign-in session bound to the credential that was just verified (P1b review): in one transaction, the admin row is
 * read FOR SHARE and the session is created only if its password hash is still `verifiedHash`. A password change
 * (changeAdminPassword: UPDATE + revoke in one transaction) therefore either completes first — and this login is
 * refused — or waits for this session and then revokes it. Returns null when the credential changed meanwhile.
 */
/** 0108: a recovery-code consumption receipt (second-factor.ts). A later regeneration deletes the row, so a proof
 *  obtained with a code from a replaced set cannot be committed. */
export type RecoveryReceipt = { id: string; usedAt: Date };
export async function recoveryReceiptCurrent(tx: Pick<typeof db, 'select'>, receipt: RecoveryReceipt | undefined): Promise<boolean> {
  if (!receipt) return true;
  const [row] = await tx.select({ usedAt: s.adminRecoveryCode.usedAt }).from(s.adminRecoveryCode).where(eq(s.adminRecoveryCode.id, receipt.id)).limit(1);
  return !!row?.usedAt && row.usedAt.getTime() === receipt.usedAt.getTime();
}

/** Captured BEFORE password/factor verification (design §5): the proof is committed only while the owner row still
 *  carries exactly this epoch and these credentials. */
export type CredentialSnapshot = { epoch: number; totpVersion: string | null; receipt?: RecoveryReceipt };

export async function createAdminSessionIfCredential(adminUserId: string, verifiedHash: string, secondFactorVerified: boolean, captured?: CredentialSnapshot & { rehashTo?: string }): Promise<string | null> {
  return db.transaction(async (tx) => {
    // Owner first (design §5), FOR UPDATE: the conditional rehash below is a write on this row.
    const [row] = await tx.select({ hash: s.adminUser.passwordHash, totp: s.adminUser.totpSecret, epoch: s.adminUser.securityEpoch }).from(s.adminUser).where(eq(s.adminUser.id, adminUserId)).for('update').limit(1);
    if (!row || row.hash !== verifiedHash) return null;
    // A sign-in that verified no second factor must not succeed if 2FA was enabled meanwhile (enrolment races). A
    // registered passkey is a second factor on its own (issue #333): a password alone never signs such an account in.
    if (!secondFactorVerified) {
      if (row.totp !== null) return null;
      const [pk] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.adminPasskeyCredential).where(eq(s.adminPasskeyCredential.adminUserId, adminUserId));
      if (Number(pk?.n ?? 0) > 0) return null;
    }
    if (captured) {
      // 0108: the factor that was verified must still be the enrolled one (same epoch, same stored TOTP version) and a
      // consumed recovery code must still belong to the current set; otherwise the proof is from a superseded epoch.
      if (row.epoch !== captured.epoch || row.totp !== captured.totpVersion || !(await recoveryReceiptCurrent(tx, captured.receipt))) return null;
      // Verified rehash, in the same transaction and only after the snapshot check (a rejected stale proof changes nothing).
      if (captured.rehashTo) await tx.update(s.adminUser).set({ passwordHash: captured.rehashTo }).where(and(eq(s.adminUser.id, adminUserId), eq(s.adminUser.passwordHash, verifiedHash)));
    }
    const token = randomBytes(32).toString('hex');
    await tx.insert(s.session).values({ adminUserId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + adminSessionTtlMs()), lastSeenAt: new Date() });
    return token;
  });
}

/** Password change: new hash + sign out every OTHER session, atomically (see createAdminSessionIfCredential). Applies
 *  only if the stored hash is still the one just verified AND the caller's session still exists — a concurrent change
 *  (which revoked this session) wins. Returns null when refused. */
export async function changeAdminPassword(adminUserId: string, verifiedHash: string, newHash: string, keepToken: string, captured?: CredentialSnapshot & { stepUpAt: Date | null; stepUpEpoch: number | null }): Promise<number | null> {
  return db.transaction(async (tx) => {
    // Match factor mutation lock order: admin row, then session row (avoids cross-session deadlocks).
    const [admin] = await tx.select({ hash: s.adminUser.passwordHash, totp: s.adminUser.totpSecret, epoch: s.adminUser.securityEpoch }).from(s.adminUser)
      .where(eq(s.adminUser.id, adminUserId)).for('update').limit(1);
    if (!admin || admin.hash !== verifiedHash) return null;
    if (captured && (admin.epoch !== captured.epoch || admin.totp !== captured.totpVersion || !(await recoveryReceiptCurrent(tx, captured.receipt)))) return null;
    const idle = env.ADMIN_SESSION_IDLE_HOURS;
    const [own] = await tx.select({ id: s.session.id, stepUpAt: s.session.stepUpAt, stepUpEpoch: s.session.stepUpEpoch }).from(s.session)
      .where(and(eq(s.session.tokenHash, hashToken(keepToken)), eq(s.session.adminUserId, adminUserId), sql`${s.session.expiresAt} > clock_timestamp()`,
        sql`(${idle}::float8 <= 0 OR coalesce(${s.session.lastSeenAt}, ${s.session.createdAt}) > clock_timestamp() - make_interval(secs => ${idle}::float8 * 3600))`)).for('update').limit(1);
    if (!own) return null;
    // 0108: the step-up this request was admitted with must still be the session's live one, fresh, and earned under
    // the current epoch (design §5 "admin password change"); a step-up cleared by passkey deletion or a TOTP cycle fails here.
    if (captured) {
      const fresh = !!own.stepUpAt && Date.now() - own.stepUpAt.getTime() <= 5 * 60 * 1000;
      const same = !!captured.stepUpAt && own.stepUpAt?.getTime() === captured.stepUpAt.getTime() && own.stepUpEpoch === captured.stepUpEpoch && own.stepUpEpoch === admin.epoch;
      if (!fresh || !same) return null;
    }
    const upd = await tx.update(s.adminUser).set({ passwordHash: newHash })
      .where(and(eq(s.adminUser.id, adminUserId), eq(s.adminUser.passwordHash, verifiedHash)))
      .returning({ id: s.adminUser.id });
    if (upd.length !== 1) return null;
    const del = await tx.delete(s.session)
      .where(and(eq(s.session.adminUserId, adminUserId), ne(s.session.tokenHash, hashToken(keepToken))))
      .returning({ id: s.session.id });
    return del.length;
  });
}

/** Rehash on sign-in, only if the stored hash is still the one just verified (never resurrect a replaced password). */
export async function rehashAdminPasswordIfUnchanged(adminUserId: string, verifiedHash: string, newHash: string): Promise<boolean> {
  const r = await db.update(s.adminUser).set({ passwordHash: newHash })
    .where(and(eq(s.adminUser.id, adminUserId), eq(s.adminUser.passwordHash, verifiedHash)))
    .returning({ id: s.adminUser.id });
  return r.length === 1;
}

/** Transaction-aware session insert for agent browser sessions: the session carries the token binding. */
export async function createAdminSessionTx(tx: Tx, adminUserId: string, ttlMs: number, apiTokenId: string | null): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await tx.insert(s.session).values({ adminUserId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs), apiTokenId });
  return token;
}

export async function deleteAdminSession(token: string): Promise<void> {
  await db.delete(s.session).where(eq(s.session.tokenHash, hashToken(token)));
}

/**
 * Resolve an admin principal from a bearer token in a SINGLE query — session ⋈
 * admin_user ⋈ admin_user_store ⋈ store — instead of two round-trips
 * (token→user, then user→stores). One row per accessible store; aggregated in JS.
 * An admin with no store grants still resolves (empty stores) via the left join.
 */
export async function resolveAdmin(token: string): Promise<AdminPrincipal | null> {
  const rows = await db
    .select({
      id: s.adminUser.id,
      email: s.adminUser.email,
      isInstallationAdmin: s.adminUser.isInstallationAdmin,
      kind: s.adminUser.kind,
      totpEnabled: sql<boolean>`(${s.adminUser.totpSecret} is not null)`,
      passkeyEnabled: sql<boolean>`exists(select 1 from admin_passkey_credential pk where pk.admin_user_id = ${s.adminUser.id})`,
      passkeyReviewRequired: s.adminUser.passkeyReviewRequired,
      storeRequireTotp: sql<boolean>`coalesce((${s.store.config} -> 'security' ->> 'requireTotp') = 'true', false)`,
      stepUpAt: s.session.stepUpAt,
      stepUpEpoch: s.session.stepUpEpoch,
      securityEpoch: s.adminUser.securityEpoch,
      sessionId: s.session.id,
      sessionCreatedAt: s.session.createdAt,
      lastSeenAt: sql<Date>`coalesce(${s.session.lastSeenAt}, ${s.session.createdAt})`,
      apiTokenId: s.session.apiTokenId,
      tokenAdminUserId: s.adminApiToken.adminUserId,
      tokenStoreId: s.adminApiToken.storeId,
      tokenRevokedAt: s.adminApiToken.revokedAt,
      tokenExpiresAt: s.adminApiToken.expiresAt,
      storeId: s.store.id,
      slug: s.store.slug,
      name: s.store.name,
      currency: s.store.currency,
      taxRate: s.store.taxRate,
      shippingTaxable: s.store.shippingTaxable,
      role: s.adminUserStore.role,
      permissions: s.adminUserStore.permissions,
    })
    .from(s.session)
    .innerJoin(s.adminUser, eq(s.adminUser.id, s.session.adminUserId))
    .leftJoin(s.adminApiToken, eq(s.adminApiToken.id, s.session.apiTokenId))
    .leftJoin(s.adminUserStore, eq(s.adminUserStore.adminUserId, s.adminUser.id))
    .leftJoin(s.store, eq(s.store.id, s.adminUserStore.storeId))
    .where(
      and(
        eq(s.session.tokenHash, hashToken(token)),
        isNotNull(s.session.adminUserId),
        gt(s.session.expiresAt, new Date()),
      ),
    );
  const first = rows[0];
  if (!first) return null;
  // P2: idle timeout — a session unused for longer than ADMIN_SESSION_IDLE_HOURS is dead (and removed).
  const lastSeen = new Date(first.lastSeenAt).getTime();
  const idleMs = adminSessionIdleMs();
  if (idleMs > 0 && Date.now() - lastSeen > idleMs) {
    await db.delete(s.session).where(eq(s.session.id, first.sessionId));
    return null;
  }
  if (Date.now() - lastSeen > TOUCH_EVERY_MS) {
    await db.update(s.session).set({ lastSeenAt: new Date() }).where(eq(s.session.id, first.sessionId));
  }
  const stores: AdminStoreAccess[] = rows
    .filter((r) => r.storeId && r.slug)
    .map((r) => ({
      storeId: r.storeId!,
      slug: r.slug!,
      name: r.name!,
      currency: r.currency!,
      taxRate: r.taxRate ?? 0,
      shippingTaxable: r.shippingTaxable ?? false,
      role: r.role as AdminStoreAccess['role'],
      permissions: (r.permissions as Record<string, boolean> | null) ?? null,
      requireTotp: r.storeRequireTotp === true,
    }));
  const kind = first.kind === 'agent' ? 'agent' : 'human';
  if (first.apiTokenId) {
    // Token-bound session: the token must be live AND belong to this admin on this single store.
    if (first.tokenRevokedAt || (first.tokenExpiresAt && first.tokenExpiresAt.getTime() <= Date.now())) return null;
    if (first.tokenAdminUserId !== first.id || stores.length !== 1 || first.tokenStoreId !== stores[0]!.storeId) return null;
  }
  // Token-bound sessions belong to agents only; agents only ever hold token-bound sessions, on exactly one store, never as owner (D2).
  if (first.apiTokenId && kind !== 'agent') return null; // invalid state (Astra v5 F12): a human must never inherit a token binding
  if (kind === 'agent' && (!first.apiTokenId || stores.length !== 1 || stores[0]!.role === 'owner')) return null;
  const principal: AdminPrincipal = { id: first.id, email: first.email, kind, auth: 'session', apiTokenId: first.apiTokenId, isInstallationAdmin: first.isInstallationAdmin, stepUpAt: first.stepUpAt, stepUpEpoch: first.stepUpEpoch ?? null, securityEpoch: first.securityEpoch, stores, sessionId: first.sessionId, sessionCreatedAt: first.sessionCreatedAt };
  if (kind === 'human') {
    principal.totpEnabled = first.totpEnabled === true;
    principal.passkeyEnabled = first.passkeyEnabled === true;
    principal.passkeyReviewRequired = first.passkeyReviewRequired === true;
    principal.totpRequired = totpRequiredFor(principal);
  }
  return principal;
}

/** Sign out every OTHER session of this admin (password change). Returns the number revoked. */
export async function revokeOtherAdminSessions(adminUserId: string, keepToken: string): Promise<number> {
  return db.transaction(async (tx) => {
    // 0108 (design §5): the owner row before any session row — never hold session locks while waiting for admin_user.
    await tx.select({ id: s.adminUser.id }).from(s.adminUser).where(eq(s.adminUser.id, adminUserId)).for('update');
    const del = await tx.delete(s.session).where(and(eq(s.session.adminUserId, adminUserId), ne(s.session.tokenHash, hashToken(keepToken)))).returning({ id: s.session.id });
    return del.length;
  });
}

/** Records that THIS session (identified by its own bearer token, not the
 *  admin generally) just re-verified the admin's credentials. Called by
 *  POST /v1/admin/step-up on success. */
export async function markStepUpVerified(token: string, epoch: number | null = null): Promise<void> {
  await db.update(s.session).set({ stepUpAt: new Date(), stepUpEpoch: epoch }).where(eq(s.session.tokenHash, hashToken(token)));
}

/** 0108: the native step-up, owner-first. Verification happened outside; `captured` is the (epoch, hash, totp) snapshot
 *  read before it. Locks admin_user, requires the snapshot to still be current, locks the live calling session, writes
 *  step_up_at + step_up_epoch. Returns false when refused (409 CREDENTIAL_CHANGED at the route). */
export async function markStepUpVerifiedIfCurrent(adminUserId: string, token: string, captured: { epoch: number; passwordHash: string | null; totpVersion: string | null; receipt?: RecoveryReceipt }): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ epoch: s.adminUser.securityEpoch, hash: s.adminUser.passwordHash, totp: s.adminUser.totpSecret })
      .from(s.adminUser).where(eq(s.adminUser.id, adminUserId)).for('update').limit(1);
    if (!row || row.epoch !== captured.epoch || row.hash !== captured.passwordHash || row.totp !== captured.totpVersion) return false;
    if (!(await recoveryReceiptCurrent(tx, captured.receipt))) return false;
    const idle = env.ADMIN_SESSION_IDLE_HOURS;
    const [own] = await tx.select({ id: s.session.id }).from(s.session)
      .where(and(eq(s.session.tokenHash, hashToken(token)), eq(s.session.adminUserId, adminUserId), sql`${s.session.expiresAt} > clock_timestamp()`,
        sql`(${idle}::float8 <= 0 OR coalesce(${s.session.lastSeenAt}, ${s.session.createdAt}) > clock_timestamp() - make_interval(secs => ${idle}::float8 * 3600))`))
      .for('update').limit(1);
    if (!own) return false;
    await tx.update(s.session).set({ stepUpAt: new Date(), stepUpEpoch: captured.epoch }).where(eq(s.session.id, own.id));
    return true;
  });
}

/** Find an admin user by email — global registry lookup on the default db client. */
export async function findAdminByEmail(email: string) {
  const [u] = await db
    .select({ id: s.adminUser.id, email: s.adminUser.email, kind: s.adminUser.kind, passwordHash: s.adminUser.passwordHash, totpSecret: s.adminUser.totpSecret, securityEpoch: s.adminUser.securityEpoch })
    .from(s.adminUser)
    .where(eq(s.adminUser.email, normalizeEmail(email)))
    .limit(1);
  // 0108: `totpVersion` is the stored representation (the snapshot compared under the lock); `totpSecret` the logical one.
  return u ? { ...u, totpVersion: u.totpSecret, totpSecret: openTotpSecret(u.id, u.totpSecret) } : null;
}
