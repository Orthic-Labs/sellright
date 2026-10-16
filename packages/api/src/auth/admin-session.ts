import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull, ne, sql } from 'drizzle-orm';
import { totpRequiredFor } from './mfa-policy.js';
import { unsafeUnscopedDb as db, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { normalizeEmail } from './email.js';
import { openTotpSecret } from './totp-secret.js';

const ADMIN_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
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
  stores: AdminStoreAccess[];
  /** P1b: the admin has a TOTP secret enrolled. Absent for agents. */
  totpEnabled?: boolean;
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
    expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL_MS),
  });
  return token;
}

/**
 * Sign-in session bound to the credential that was just verified (P1b review): in one transaction, the admin row is
 * read FOR SHARE and the session is created only if its password hash is still `verifiedHash`. A password change
 * (changeAdminPassword: UPDATE + revoke in one transaction) therefore either completes first — and this login is
 * refused — or waits for this session and then revokes it. Returns null when the credential changed meanwhile.
 */
export async function createAdminSessionIfCredential(adminUserId: string, verifiedHash: string, secondFactorVerified: boolean): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ hash: s.adminUser.passwordHash, totp: s.adminUser.totpSecret }).from(s.adminUser).where(eq(s.adminUser.id, adminUserId)).for('share').limit(1);
    if (!row || row.hash !== verifiedHash) return null;
    // A sign-in that verified no second factor must not succeed if 2FA was enabled meanwhile (enrolment races).
    if (!secondFactorVerified && row.totp !== null) return null;
    const token = randomBytes(32).toString('hex');
    await tx.insert(s.session).values({ adminUserId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL_MS) });
    return token;
  });
}

/** Password change: new hash + sign out every OTHER session, atomically (see createAdminSessionIfCredential). Applies
 *  only if the stored hash is still the one just verified AND the caller's session still exists — a concurrent change
 *  (which revoked this session) wins. Returns null when refused. */
export async function changeAdminPassword(adminUserId: string, verifiedHash: string, newHash: string, keepToken: string): Promise<number | null> {
  return db.transaction(async (tx) => {
    const [own] = await tx.select({ id: s.session.id }).from(s.session).where(eq(s.session.tokenHash, hashToken(keepToken))).for('update').limit(1);
    if (!own) return null;
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
      storeRequireTotp: sql<boolean>`coalesce((${s.store.config} -> 'security' ->> 'requireTotp') = 'true', false)`,
      stepUpAt: s.session.stepUpAt,
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
  const principal: AdminPrincipal = { id: first.id, email: first.email, kind, auth: 'session', apiTokenId: first.apiTokenId, isInstallationAdmin: first.isInstallationAdmin, stepUpAt: first.stepUpAt, stores };
  if (kind === 'human') {
    principal.totpEnabled = first.totpEnabled === true;
    principal.totpRequired = totpRequiredFor(principal);
  }
  return principal;
}

/** Sign out every OTHER session of this admin (password change). Returns the number revoked. */
export async function revokeOtherAdminSessions(adminUserId: string, keepToken: string): Promise<number> {
  const del = await db
    .delete(s.session)
    .where(and(eq(s.session.adminUserId, adminUserId), ne(s.session.tokenHash, hashToken(keepToken))))
    .returning({ id: s.session.id });
  return del.length;
}

/** Records that THIS session (identified by its own bearer token, not the
 *  admin generally) just re-verified the admin's credentials. Called by
 *  POST /v1/admin/step-up on success. */
export async function markStepUpVerified(token: string): Promise<void> {
  await db.update(s.session).set({ stepUpAt: new Date() }).where(eq(s.session.tokenHash, hashToken(token)));
}

/** Find an admin user by email — global registry lookup on the default db client. */
export async function findAdminByEmail(email: string) {
  const [u] = await db
    .select({ id: s.adminUser.id, email: s.adminUser.email, kind: s.adminUser.kind, passwordHash: s.adminUser.passwordHash, totpSecret: s.adminUser.totpSecret })
    .from(s.adminUser)
    .where(eq(s.adminUser.email, normalizeEmail(email)))
    .limit(1);
  return u ? { ...u, totpSecret: openTotpSecret(u.id, u.totpSecret) } : null;
}
