/**
 * Server-side tokens of the admin sign-in journey (migration 0110, issue #333). One global table, three kinds:
 *
 *  - login_2fa: POST /v1/admin/login verified the password of an account with a second factor (TOTP and/or passkey).
 *    The caller gets a random token (never a session); POST /v1/admin/login/2fa redeems it ONCE with the code. The
 *    row is bound to the owner's security epoch and to a digest of the password hash that was verified, so a password
 *    or 2FA change kills it. Attempts are capped per token on top of the shared admin auth budgets (rate-limit.ts).
 *  - totp_enroll: the pending authenticator secret of ONE session, sealed exactly like admin_user.totp_secret. Every
 *    POST /v1/admin/2fa/setup replaces it (the secret rotates until confirmed); POST /v1/admin/2fa/enable consumes it.
 *  - password_reset: the e-mailed admin reset link, bound to the epoch and password-hash digest it was issued for.
 *
 * Only sha256(token) is stored. Secrets are never logged.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, count, eq, gt, isNull, lt, or, sql, isNotNull } from 'drizzle-orm';
import { unsafeUnscopedDb as db } from '../db/client.js';
import * as s from '../db/schema.js';
import { openTotpSecret, sealTotpSecret } from './totp-secret.js';
import { consumeRecoveryCode, verifyTotpOnceTx } from './second-factor.js';
import { adminSessionTtlMs } from './admin-session.js';

export const LOGIN_CHALLENGE_TTL_SECONDS = 5 * 60;
export const LOGIN_CHALLENGE_MAX_ATTEMPTS = 5;
export const TOTP_ENROLL_TTL_SECONDS = 15 * 60;
export const TOTP_ENROLL_MAX_ATTEMPTS = 5;
export const PASSWORD_RESET_TTL_SECONDS = 30 * 60;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

/** Digest of the verified password hash (the hash itself is never copied into the challenge row). */
export function credentialDigest(adminUserId: string, passwordHash: string | null): string {
  return sha256(`sellright-admin-credential:${adminUserId}:${passwordHash ?? ''}`);
}

type Kind = 'login_2fa' | 'totp_enroll' | 'password_reset';
const live = (kind: Kind, tokenHash: string, maxAttempts?: number) => and(
  eq(s.adminAuthChallenge.tokenHash, tokenHash), eq(s.adminAuthChallenge.kind, kind), isNull(s.adminAuthChallenge.consumedAt),
  gt(s.adminAuthChallenge.expiresAt, sql`clock_timestamp()`),
  ...(maxAttempts === undefined ? [] : [lt(s.adminAuthChallenge.attempts, maxAttempts)]),
);

/** Admin row with the facts the journey needs; the TOTP secret opened, its stored form kept as `totpVersion`. */
export async function adminAuthFacts(adminUserId: string) {
  const [u] = await db.select({ id: s.adminUser.id, email: s.adminUser.email, kind: s.adminUser.kind, passwordHash: s.adminUser.passwordHash, totpSecret: s.adminUser.totpSecret, securityEpoch: s.adminUser.securityEpoch })
    .from(s.adminUser).where(eq(s.adminUser.id, adminUserId)).limit(1);
  return u ? { ...u, totpVersion: u.totpSecret, totpSecret: openTotpSecret(u.id, u.totpSecret) } : null;
}

/** How many passkeys the admin has (a registered passkey is a second factor on its own, issue #333). */
export async function adminPasskeyCount(adminUserId: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(s.adminPasskeyCredential).where(eq(s.adminPasskeyCredential.adminUserId, adminUserId));
  return Number(r?.n ?? 0);
}

// ── login_2fa ────────────────────────────────────────────────────────────────

/** Issue the step-2 token. One live login challenge per admin: a newer password success replaces older ones. */
export async function issueLoginChallenge(adminUserId: string, passwordHash: string, epoch: number): Promise<string> {
  const token = newToken();
  await db.transaction(async (tx) => {
    await tx.delete(s.adminAuthChallenge).where(and(eq(s.adminAuthChallenge.adminUserId, adminUserId), eq(s.adminAuthChallenge.kind, 'login_2fa')));
    await tx.insert(s.adminAuthChallenge).values({ tokenHash: sha256(token), kind: 'login_2fa', adminUserId, credentialDigest: credentialDigest(adminUserId, passwordHash), epoch,
      expiresAt: new Date(Date.now() + LOGIN_CHALLENGE_TTL_SECONDS * 1000) });
  });
  return token;
}

/** Read-only: the owner of a live login challenge (used to pick the rate-limit account before anything is spent). */
export async function peekLoginChallenge(token: string): Promise<{ adminUserId: string } | null> {
  const [row] = await db.select({ adminUserId: s.adminAuthChallenge.adminUserId }).from(s.adminAuthChallenge)
    .where(live('login_2fa', sha256(token))).limit(1); // an exhausted token still names its account (budgets + EXHAUSTED)
  return row ?? null;
}

/** Atomically count one code attempt against the token. Returns why it cannot be used when it is dead. */
export async function attemptLoginChallenge(token: string): Promise<{ ok: true; adminUserId: string } | { ok: false; reason: 'expired' | 'exhausted' }> {
  const hash = sha256(token);
  const [row] = await db.update(s.adminAuthChallenge).set({ attempts: sql`${s.adminAuthChallenge.attempts} + 1` })
    .where(live('login_2fa', hash, LOGIN_CHALLENGE_MAX_ATTEMPTS)).returning({ adminUserId: s.adminAuthChallenge.adminUserId });
  if (row) return { ok: true, adminUserId: row.adminUserId };
  const [dead] = await db.select({ attempts: s.adminAuthChallenge.attempts }).from(s.adminAuthChallenge).where(live('login_2fa', hash)).limit(1);
  return { ok: false, reason: dead && dead.attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS ? 'exhausted' : 'expired' };
}

class RollbackFactor extends Error {}

/**
 * Step 2, atomically (issue #333 review): under the owner row lock, CLAIM the challenge (single use), re-check that the
 * password hash and security epoch it was issued for are still the account's, spend the factor (TOTP replay guard or
 * recovery code) and create the session — all in one transaction. A wrong code rolls everything back (the token stays
 * usable until its attempts run out; the attempt was counted before); two concurrent redemptions serialize on the
 * owner lock and only one can claim.
 */
export async function redeemLoginChallenge(token: string, adminUserId: string, code: string): Promise<{ ok: true; sessionToken: string } | { ok: false; reason: 'invalid_code' | 'expired' }> {
  try {
    return await db.transaction(async (tx) => {
      const [owner] = await tx.select({ id: s.adminUser.id, kind: s.adminUser.kind, hash: s.adminUser.passwordHash, totp: s.adminUser.totpSecret, epoch: s.adminUser.securityEpoch })
        .from(s.adminUser).where(eq(s.adminUser.id, adminUserId)).for('update').limit(1);
      if (!owner || owner.kind !== 'human') return { ok: false as const, reason: 'expired' as const };
      const [claim] = await tx.update(s.adminAuthChallenge).set({ consumedAt: sql`clock_timestamp()` })
        .where(and(live('login_2fa', sha256(token)), eq(s.adminAuthChallenge.adminUserId, owner.id)))
        .returning({ digest: s.adminAuthChallenge.credentialDigest, epoch: s.adminAuthChallenge.epoch });
      if (!claim) return { ok: false as const, reason: 'expired' as const };
      // The password verified at step 1 and the factor set must still be the account's; otherwise the claim stands
      // (the token is dead) and nothing else happens.
      if (claim.digest !== credentialDigest(owner.id, owner.hash) || claim.epoch !== owner.epoch) return { ok: false as const, reason: 'expired' as const };
      const secret = openTotpSecret(owner.id, owner.totp);
      const c = code.trim();
      const ok = secret && /^\d{6}$/.test(c) ? await verifyTotpOnceTx(owner.id, secret, c, tx)
        : /^\d{6}$/.test(c) ? false // no authenticator app: a 6-digit code is never a factor
        : await consumeRecoveryCode(owner.id, c, tx);
      if (!ok) throw new RollbackFactor(); // un-claims the token; the attempt counter (outside) stands
      const sessionToken = randomBytes(32).toString('hex');
      await tx.insert(s.session).values({ adminUserId: owner.id, tokenHash: sha256(sessionToken), expiresAt: new Date(Date.now() + adminSessionTtlMs()), lastSeenAt: new Date() });
      return { ok: true as const, sessionToken };
    });
  } catch (e) {
    if (e instanceof RollbackFactor) return { ok: false, reason: 'invalid_code' };
    throw e;
  }
}

/** Single use: exactly one caller can consume a live token of `kind`. */
export async function consumeChallenge(kind: Kind, token: string): Promise<boolean> {
  const rows = await db.update(s.adminAuthChallenge).set({ consumedAt: sql`clock_timestamp()` })
    .where(live(kind, sha256(token))).returning({ h: s.adminAuthChallenge.tokenHash });
  return rows.length === 1;
}

// ── totp_enroll ──────────────────────────────────────────────────────────────

/** Store (replace) the pending authenticator secret of this session. Sealed at rest like admin_user.totp_secret. */
export async function setPendingTotpEnrollment(adminUserId: string, sessionToken: string, epoch: number, secretB32: string): Promise<string> {
  const sessionHash = sha256(sessionToken);
  const setupId = newToken();
  await db.transaction(async (tx) => {
    await tx.delete(s.adminAuthChallenge).where(and(eq(s.adminAuthChallenge.adminUserId, adminUserId), eq(s.adminAuthChallenge.kind, 'totp_enroll'),
      or(eq(s.adminAuthChallenge.sessionHash, sessionHash), lt(s.adminAuthChallenge.expiresAt, sql`clock_timestamp()`), isNotNull(s.adminAuthChallenge.consumedAt))));
    await tx.insert(s.adminAuthChallenge).values({ tokenHash: sha256(setupId), kind: 'totp_enroll', adminUserId, sessionHash, secret: sealTotpSecret(adminUserId, secretB32), epoch,
      expiresAt: new Date(Date.now() + TOTP_ENROLL_TTL_SECONDS * 1000) });
  });
  return setupId; // names THIS secret: a confirmation for a superseded QR is refused instead of checked against a newer one
}

/** Count one confirmation attempt against this session's pending secret and return it (opened); null when there is
 *  none, it expired, or its attempts are spent. */
export async function attemptPendingTotpEnrollment(adminUserId: string, sessionToken: string, setupId?: string): Promise<{ tokenHash: string; secret: string; epoch: number } | null> {
  const [row] = await db.update(s.adminAuthChallenge).set({ attempts: sql`${s.adminAuthChallenge.attempts} + 1` })
    .where(and(eq(s.adminAuthChallenge.adminUserId, adminUserId), eq(s.adminAuthChallenge.kind, 'totp_enroll'), eq(s.adminAuthChallenge.sessionHash, sha256(sessionToken)),
      ...(setupId ? [eq(s.adminAuthChallenge.tokenHash, sha256(setupId))] : []),
      isNull(s.adminAuthChallenge.consumedAt), gt(s.adminAuthChallenge.expiresAt, sql`clock_timestamp()`), lt(s.adminAuthChallenge.attempts, TOTP_ENROLL_MAX_ATTEMPTS)))
    .returning({ tokenHash: s.adminAuthChallenge.tokenHash, secret: s.adminAuthChallenge.secret, epoch: s.adminAuthChallenge.epoch });
  const secret = row ? openTotpSecret(adminUserId, row.secret) : null;
  return row && secret ? { tokenHash: row.tokenHash, secret, epoch: row.epoch } : null;
}

export async function consumePendingTotpEnrollment(tokenHash: string): Promise<boolean> {
  const rows = await db.update(s.adminAuthChallenge).set({ consumedAt: sql`clock_timestamp()` })
    .where(and(eq(s.adminAuthChallenge.tokenHash, tokenHash), eq(s.adminAuthChallenge.kind, 'totp_enroll'), isNull(s.adminAuthChallenge.consumedAt))).returning({ h: s.adminAuthChallenge.tokenHash });
  return rows.length === 1;
}

// ── password_reset ───────────────────────────────────────────────────────────

/** Issue a reset token; one live reset link per admin (a newer request replaces the older link). */
export async function issuePasswordReset(adminUserId: string, passwordHash: string | null, epoch: number): Promise<string> {
  const token = newToken();
  await db.transaction(async (tx) => {
    await tx.delete(s.adminAuthChallenge).where(and(eq(s.adminAuthChallenge.adminUserId, adminUserId), eq(s.adminAuthChallenge.kind, 'password_reset')));
    await tx.insert(s.adminAuthChallenge).values({ tokenHash: sha256(token), kind: 'password_reset', adminUserId, credentialDigest: credentialDigest(adminUserId, passwordHash), epoch,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000) });
  });
  return token;
}

/** Read-only view of a live reset token (the reset route validates it before hashing the new password). */
export async function peekPasswordReset(token: string): Promise<{ adminUserId: string; credentialDigest: string; epoch: number } | null> {
  const [row] = await db.select({ adminUserId: s.adminAuthChallenge.adminUserId, credentialDigest: s.adminAuthChallenge.credentialDigest, epoch: s.adminAuthChallenge.epoch })
    .from(s.adminAuthChallenge).where(live('password_reset', sha256(token))).limit(1);
  return row ? { adminUserId: row.adminUserId, credentialDigest: row.credentialDigest!, epoch: row.epoch } : null;
}

/**
 * Redeem a reset token: in ONE transaction, lock the owner, consume the token, require the password hash and epoch it
 * was issued for to be unchanged, set the new hash and sign out every session. The second factor is untouched: the
 * next sign-in still asks for it. Returns false when the token or the credential it was bound to is no longer current.
 */
export async function redeemPasswordReset(token: string, newHash: string): Promise<{ adminUserId: string; email: string; passkeyReviewRequired: boolean } | null> {
  return db.transaction(async (tx) => {
    const [peek] = await tx.select({ adminUserId: s.adminAuthChallenge.adminUserId }).from(s.adminAuthChallenge).where(live('password_reset', sha256(token))).limit(1);
    if (!peek) return null;
    const [owner] = await tx.select({ id: s.adminUser.id, email: s.adminUser.email, kind: s.adminUser.kind, hash: s.adminUser.passwordHash, epoch: s.adminUser.securityEpoch })
      .from(s.adminUser).where(eq(s.adminUser.id, peek.adminUserId)).for('update').limit(1);
    if (!owner || owner.kind !== 'human') return null;
    const [row] = await tx.update(s.adminAuthChallenge).set({ consumedAt: sql`clock_timestamp()` }).where(live('password_reset', sha256(token)))
      .returning({ digest: s.adminAuthChallenge.credentialDigest, epoch: s.adminAuthChallenge.epoch });
    if (!row || row.digest !== credentialDigest(owner.id, owner.hash) || row.epoch !== owner.epoch) return null;
    // #333 review: the reset bumps the security epoch (every step-up and pending ceremony dies) and signs out every
    // session. Passkeys survive (they may be the account's only second factor — dropping them would make the e-mailed
    // link a 2FA bypass) but are re-stamped to the new epoch and put under REVIEW: until the owner confirms, with the
    // NEW password, which ones to keep, every session of the account — passkey sign-ins included — can only do that.
    const [pk] = await tx.select({ n: count() }).from(s.adminPasskeyCredential).where(eq(s.adminPasskeyCredential.adminUserId, owner.id));
    const hasPasskeys = Number(pk?.n ?? 0) > 0;
    const next = owner.epoch + 1;
    await tx.update(s.adminUser).set({ passwordHash: newHash, securityEpoch: next, passkeyReviewRequired: hasPasskeys }).where(eq(s.adminUser.id, owner.id));
    if (hasPasskeys) await tx.update(s.adminPasskeyCredential).set({ epoch: next }).where(and(eq(s.adminPasskeyCredential.adminUserId, owner.id), eq(s.adminPasskeyCredential.epoch, owner.epoch)));
    await tx.delete(s.session).where(eq(s.session.adminUserId, owner.id));
    await tx.delete(s.adminAuthChallenge).where(and(eq(s.adminAuthChallenge.adminUserId, owner.id), isNull(s.adminAuthChallenge.consumedAt)));
    await tx.delete(s.adminPasskeyChallenge).where(and(eq(s.adminPasskeyChallenge.adminUserId, owner.id), isNull(s.adminPasskeyChallenge.consumedAt)));
    return { adminUserId: owner.id, email: owner.email, passkeyReviewRequired: hasPasskeys };
  });
}

/** Expired rows (job): an hour after expiry. */
export async function pruneAdminAuthChallenges(): Promise<number> {
  const rows = await db.delete(s.adminAuthChallenge).where(sql`${s.adminAuthChallenge.expiresAt} < now() - interval '1 hour'`).returning({ h: s.adminAuthChallenge.tokenHash });
  return rows.length;
}

/** The store whose mail settings carry an admin's reset e-mail: the store the request came in on when the admin
 *  belongs to it, else the admin's first store; null for an admin with no store. */
export async function adminMailStore(adminUserId: string, preferredStoreId?: string | null) {
  const rows = await db.select({ id: s.store.id, slug: s.store.slug, name: s.store.name, currency: s.store.currency, config: s.store.config })
    .from(s.adminUserStore).innerJoin(s.store, eq(s.store.id, s.adminUserStore.storeId))
    .where(eq(s.adminUserStore.adminUserId, adminUserId)).orderBy(s.store.createdAt);
  return rows.find((r) => r.id === preferredStoreId) ?? rows[0] ?? null;
}

/** The account's passkeys for the reset e-mail (labels and dates only). */
export async function adminPasskeyLabels(adminUserId: string): Promise<{ label: string; createdAt: Date }[]> {
  return db.select({ label: s.adminPasskeyCredential.label, createdAt: s.adminPasskeyCredential.createdAt }).from(s.adminPasskeyCredential)
    .where(eq(s.adminPasskeyCredential.adminUserId, adminUserId)).orderBy(s.adminPasskeyCredential.createdAt);
}

/**
 * Passkey review after a password reset: keep exactly `keep` (ids of the admin's own passkeys), delete the rest, clear
 * the review flag. The caller verified the CURRENT password in this request. When nothing is left and there is no
 * authenticator app, the recovery codes go too (they only make sense next to a factor).
 */
export async function completePasskeyReview(adminUserId: string, verifiedHash: string, keep: string[]): Promise<{ removed: number } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-credentials:' + adminUserId}, 0))`);
    const [owner] = await tx.select({ hash: s.adminUser.passwordHash, totp: s.adminUser.totpSecret, review: s.adminUser.passkeyReviewRequired })
      .from(s.adminUser).where(eq(s.adminUser.id, adminUserId)).for('update').limit(1);
    if (!owner || owner.hash !== verifiedHash || !owner.review) return null;
    const mine = await tx.select({ id: s.adminPasskeyCredential.id }).from(s.adminPasskeyCredential).where(eq(s.adminPasskeyCredential.adminUserId, adminUserId));
    const drop = mine.filter((p) => !keep.includes(p.id)).map((p) => p.id);
    for (const id of drop) await tx.delete(s.adminPasskeyCredential).where(and(eq(s.adminPasskeyCredential.id, id), eq(s.adminPasskeyCredential.adminUserId, adminUserId)));
    if (!owner.totp && drop.length === mine.length) await tx.delete(s.adminRecoveryCode).where(eq(s.adminRecoveryCode.adminUserId, adminUserId));
    await tx.update(s.adminUser).set({ passkeyReviewRequired: false }).where(eq(s.adminUser.id, adminUserId));
    return { removed: drop.length };
  });
}
