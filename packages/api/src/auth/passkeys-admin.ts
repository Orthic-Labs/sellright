/**
 * Passkeys — admin side (design §7 branches A and B, §4 epoch rule, §5 lock discipline).
 *
 * Global registries (admin_passkey_credential / admin_passkey_challenge are RLS-exempt like admin_recovery_code), so
 * everything runs on the unscoped runtime client. Every transaction: admin_user FOR UPDATE first, then the calling
 * session FOR UPDATE (authenticated kinds), then the challenge claim, then the credential FOR UPDATE, then writes.
 * Budgets (§8) are consumed by the caller/route BEFORE these transactions open; the per-credential budget is consumed
 * here after the unlocked identification but still before the transaction.
 */
import { randomBytes } from 'node:crypto';
import { and, count, eq, gt, isNull, sql } from 'drizzle-orm';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { unsafeUnscopedDb as db } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { log } from '../lib/logger.js';
import { adminSessionTtlMs } from './admin-session.js';
import { deleteRecoveryCodes, regenerateRecoveryCodesTx } from './second-factor.js';
import {
  CHALLENGE_TTL_SECONDS, MAX_PASSKEYS_PER_OWNER, STEP_UP_WINDOW_SECONDS, adminUserHandle, assertionUserHandle, authenticationOptions, b64url,
  budgets, clientDataChallenge, counterAcceptable, newNonce, registrationOptions, sha256hex, verifyAuthentication, verifyRegistration,
  type PasskeySummary, type RelyingParty,
} from './passkeys-core.js';

type Db = Parameters<Parameters<typeof db.transaction>[0]>[0];
const expiresAt = () => new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);
const summary = (r: { id: string; label: string; deviceType: string; backedUp: boolean; createdAt: Date; lastUsedAt: Date | null }): PasskeySummary =>
  ({ id: r.id, label: r.label, deviceType: r.deviceType, backedUp: r.backedUp, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt });

export type Refusal = { ok: false; code: 'RATE_LIMITED' | 'PASSKEY_INVALID' | 'CEREMONY_INVALID' | 'STEP_UP_REQUIRED' | 'TOO_MANY_PASSKEYS' | 'CREDENTIAL_EXISTS'; retry?: number };
const refuse = (code: Refusal['code'], retry?: number): Refusal => ({ ok: false, code, ...(retry ? { retry } : {}) });

/** Owner row under lock: the epoch every artifact is compared to. */
async function lockAdmin(tx: Db, adminId: string) {
  const [row] = await tx.select({ id: s.adminUser.id, epoch: s.adminUser.securityEpoch, kind: s.adminUser.kind, totp: s.adminUser.totpSecret, email: s.adminUser.email })
    .from(s.adminUser).where(eq(s.adminUser.id, adminId)).for('update').limit(1);
  return row && row.kind === 'human' ? row : null;
}

/** The calling session, locked and live (expiry + idle rule as admin-staff.ts); with `stepUp`, also fresh and earned
 *  under `epoch` (§4). */
async function lockLiveSession(tx: Db, adminId: string, sessionHash: string, stepUp?: { epoch: number }, createdWithinSeconds?: number) {
  const idle = env.ADMIN_SESSION_IDLE_HOURS;
  const conds = [
    eq(s.session.tokenHash, sessionHash), eq(s.session.adminUserId, adminId), isNull(s.session.apiTokenId),
    sql`${s.session.expiresAt} > clock_timestamp()`,
    sql`(${idle}::float8 <= 0 OR coalesce(${s.session.lastSeenAt}, ${s.session.createdAt}) > clock_timestamp() - make_interval(secs => ${idle}::float8 * 3600))`,
  ];
  if (stepUp) {
    conds.push(sql`${s.session.stepUpAt} > clock_timestamp() - make_interval(secs => ${STEP_UP_WINDOW_SECONDS})`, eq(s.session.stepUpEpoch, stepUp.epoch));
  }
  if (createdWithinSeconds !== undefined) conds.push(sql`${s.session.createdAt} > clock_timestamp() - make_interval(secs => ${createdWithinSeconds})`);
  const [row] = await tx.select({ id: s.session.id }).from(s.session).where(and(...conds)).for('update').limit(1);
  return row ?? null;
}

/** Issue #333: the window in which a freshly signed-in session of an account with NO second factor yet may enrol its
 *  first one without re-entering the password (that sign-in proved everything the account has: its password). */
export const FRESH_ENROLL_SECONDS = 15 * 60;

/** The calling session may add a passkey: a current-epoch step-up, or — for the account's FIRST second factor only — a
 *  session created within FRESH_ENROLL_SECONDS. Caller holds the owner lock. */
async function lockEnrollSession(tx: Db, owner: { id: string; epoch: number; totp: string | null }, sessionHash: string) {
  const stepped = await lockLiveSession(tx, owner.id, sessionHash, { epoch: owner.epoch });
  if (stepped || owner.totp) return stepped;
  const [cnt] = await tx.select({ n: count() }).from(s.adminPasskeyCredential).where(eq(s.adminPasskeyCredential.adminUserId, owner.id));
  if (Number(cnt?.n ?? 0) > 0) return null;
  return lockLiveSession(tx, owner.id, sessionHash, undefined, FRESH_ENROLL_SECONDS);
}

async function ownCredentials(tx: Db | typeof db, adminId: string) {
  return tx.select({ id: s.adminPasskeyCredential.id, credentialId: s.adminPasskeyCredential.credentialId, transports: s.adminPasskeyCredential.transports })
    .from(s.adminPasskeyCredential).where(eq(s.adminPasskeyCredential.adminUserId, adminId));
}

/** Atomic claim with every binding (§7): kind, rp, owner/session/epoch (authenticated kinds), browser nonce, unconsumed, unexpired. */
async function claimChallenge(tx: Db, i: { challenge: string; kind: 'register' | 'login' | 'step_up'; rpId: string; nonce: string; adminId?: string; sessionHash?: string; epoch?: number }): Promise<boolean> {
  const conds = [
    eq(s.adminPasskeyChallenge.challengeHash, sha256hex(i.challenge)), eq(s.adminPasskeyChallenge.kind, i.kind), eq(s.adminPasskeyChallenge.rpId, i.rpId),
    isNull(s.adminPasskeyChallenge.consumedAt), gt(s.adminPasskeyChallenge.expiresAt, new Date()), eq(s.adminPasskeyChallenge.nonceHash, sha256hex(i.nonce)),
  ];
  if (i.kind === 'login') conds.push(isNull(s.adminPasskeyChallenge.adminUserId));
  else conds.push(eq(s.adminPasskeyChallenge.adminUserId, i.adminId!), eq(s.adminPasskeyChallenge.sessionHash, i.sessionHash!), eq(s.adminPasskeyChallenge.epoch, i.epoch!));
  const rows = await tx.update(s.adminPasskeyChallenge).set({ consumedAt: new Date() }).where(and(...conds)).returning({ h: s.adminPasskeyChallenge.challengeHash });
  return rows.length === 1;
}

/** Credential under lock, owned by `adminId` and issued under its current epoch; a stale-epoch row is deleted here. */
async function lockCredential(tx: Db, i: { id: string; adminId: string; epoch: number }) {
  const [cred] = await tx.select().from(s.adminPasskeyCredential).where(eq(s.adminPasskeyCredential.id, i.id)).for('update').limit(1);
  if (!cred || cred.adminUserId !== i.adminId) return null;
  if (cred.epoch !== i.epoch) {
    await tx.delete(s.adminPasskeyCredential).where(eq(s.adminPasskeyCredential.id, cred.id));
    log.warn('passkey_invalidated', { surface: 'admin', adminId: i.adminId, credential: cred.id, epoch: cred.epoch, current: i.epoch });
    return null;
  }
  return cred;
}

/** Assertion verification + conditional counter advance (§7 steps 7–8). */
async function verifyAssertion(tx: Db, i: { rp: RelyingParty; response: AuthenticationResponseJSON; challenge: string; cred: typeof s.adminPasskeyCredential.$inferSelect }): Promise<boolean> {
  const v = await verifyAuthentication({ rp: i.rp, response: i.response, expectedChallenge: i.challenge,
    credential: { credentialId: i.cred.credentialId, publicKey: i.cred.publicKey, counter: i.cred.counter, transports: i.cred.transports } });
  if (!v) return false;
  if (!counterAcceptable(i.cred.counter, v.newCounter)) {
    log.warn('passkey_counter_regression', { surface: 'admin', credential: i.cred.id, stored: i.cred.counter, presented: v.newCounter });
    return false;
  }
  const upd = await tx.update(s.adminPasskeyCredential).set({ counter: v.newCounter, lastUsedAt: new Date() })
    .where(and(eq(s.adminPasskeyCredential.id, i.cred.id), eq(s.adminPasskeyCredential.counter, i.cred.counter))).returning({ id: s.adminPasskeyCredential.id });
  return upd.length === 1;
}

// ── Branch A: discoverable login ─────────────────────────────────────────────

export async function adminLoginOptions(rp: RelyingParty) {
  const options = await authenticationOptions({ rp, allow: [] });
  const nonce = newNonce();
  await db.insert(s.adminPasskeyChallenge).values({ challengeHash: sha256hex(options.challenge), kind: 'login', rpId: rp.rpId, nonceHash: sha256hex(nonce), expiresAt: expiresAt() });
  return { options, nonce };
}

export async function adminLoginVerify(i: { rp: RelyingParty; response: AuthenticationResponseJSON; nonce: string | undefined; ip: string }): Promise<{ ok: true; token: string; adminId: string } | Refusal> {
  const retry = await budgets.adminVerify(i.ip);
  if (retry > 0) return refuse('RATE_LIMITED', retry);
  const challenge = clientDataChallenge(i.response);
  if (!challenge || !i.nonce) return refuse('PASSKEY_INVALID');
  // Unlocked identification: which owner, so the owner can be locked first.
  const [found] = await db.select({ id: s.adminPasskeyCredential.id, adminUserId: s.adminPasskeyCredential.adminUserId }).from(s.adminPasskeyCredential)
    .where(and(eq(s.adminPasskeyCredential.rpId, i.rp.rpId), eq(s.adminPasskeyCredential.credentialId, i.response.id))).limit(1);
  if (!found) return refuse('PASSKEY_INVALID');
  const credRetry = await budgets.adminCredential(i.response.id);
  if (credRetry > 0) return refuse('RATE_LIMITED', credRetry);
  return db.transaction(async (tx) => {
    const owner = await lockAdmin(tx, found.adminUserId);
    if (!owner) return refuse('PASSKEY_INVALID');
    if (!(await claimChallenge(tx, { challenge, kind: 'login', rpId: i.rp.rpId, nonce: i.nonce! }))) return refuse('PASSKEY_INVALID');
    const cred = await lockCredential(tx, { id: found.id, adminId: owner.id, epoch: owner.epoch });
    if (!cred) return refuse('PASSKEY_INVALID');
    if (assertionUserHandle(i.response) !== b64url(adminUserHandle(owner.id))) return refuse('PASSKEY_INVALID');
    if (!(await verifyAssertion(tx, { rp: i.rp, response: i.response, challenge, cred }))) return refuse('PASSKEY_INVALID');
    // Second factor satisfied by construction (UV required): same session shape as a password + TOTP login.
    const token = randomBytes(32).toString('hex');
    await tx.insert(s.session).values({ adminUserId: owner.id, tokenHash: sha256hex(token), expiresAt: new Date(Date.now() + adminSessionTtlMs()), lastSeenAt: new Date() });
    return { ok: true as const, token, adminId: owner.id };
  });
}

// ── Branch A: step-up with a passkey ─────────────────────────────────────────

export async function adminStepUpOptions(i: { rp: RelyingParty; adminId: string; sessionToken: string }): Promise<{ ok: true; options: Awaited<ReturnType<typeof authenticationOptions>>; nonce: string } | Refusal> {
  const sessionHash = sha256hex(i.sessionToken);
  const retry = await budgets.adminSession(sessionHash);
  if (retry > 0) return refuse('RATE_LIMITED', retry);
  return db.transaction(async (tx) => {
    const owner = await lockAdmin(tx, i.adminId);
    if (!owner || !(await lockLiveSession(tx, owner.id, sessionHash))) return refuse('PASSKEY_INVALID');
    const allow = await ownCredentials(tx, owner.id);
    if (allow.length === 0) return refuse('PASSKEY_INVALID');
    const options = await authenticationOptions({ rp: i.rp, allow });
    const nonce = newNonce();
    await tx.insert(s.adminPasskeyChallenge).values({ challengeHash: sha256hex(options.challenge), kind: 'step_up', rpId: i.rp.rpId, adminUserId: owner.id, sessionHash, nonceHash: sha256hex(nonce), epoch: owner.epoch, expiresAt: expiresAt() });
    return { ok: true as const, options, nonce };
  });
}

export async function adminStepUpVerify(i: { rp: RelyingParty; adminId: string; sessionToken: string; response: AuthenticationResponseJSON; nonce: string | undefined }): Promise<{ ok: true } | Refusal> {
  const sessionHash = sha256hex(i.sessionToken);
  const retry = await budgets.adminSession(sessionHash);
  if (retry > 0) return refuse('RATE_LIMITED', retry);
  const challenge = clientDataChallenge(i.response);
  if (!challenge || !i.nonce) return refuse('PASSKEY_INVALID');
  const [found] = await db.select({ id: s.adminPasskeyCredential.id }).from(s.adminPasskeyCredential)
    .where(and(eq(s.adminPasskeyCredential.rpId, i.rp.rpId), eq(s.adminPasskeyCredential.credentialId, i.response.id), eq(s.adminPasskeyCredential.adminUserId, i.adminId))).limit(1);
  if (!found) return refuse('PASSKEY_INVALID');
  return db.transaction(async (tx) => {
    const owner = await lockAdmin(tx, i.adminId);
    if (!owner) return refuse('PASSKEY_INVALID');
    const session = await lockLiveSession(tx, owner.id, sessionHash);
    if (!session) return refuse('PASSKEY_INVALID');
    if (!(await claimChallenge(tx, { challenge, kind: 'step_up', rpId: i.rp.rpId, nonce: i.nonce!, adminId: owner.id, sessionHash, epoch: owner.epoch }))) return refuse('PASSKEY_INVALID');
    const cred = await lockCredential(tx, { id: found.id, adminId: owner.id, epoch: owner.epoch });
    if (!cred) return refuse('PASSKEY_INVALID');
    if (!(await verifyAssertion(tx, { rp: i.rp, response: i.response, challenge, cred }))) return refuse('PASSKEY_INVALID');
    await tx.update(s.session).set({ stepUpAt: new Date(), stepUpEpoch: owner.epoch }).where(eq(s.session.id, session.id));
    return { ok: true as const };
  });
}

// ── Branch B: registration ───────────────────────────────────────────────────

export async function adminRegisterOptions(i: { rp: RelyingParty; adminId: string; sessionToken: string }): Promise<{ ok: true; options: Awaited<ReturnType<typeof registrationOptions>>; nonce: string } | Refusal> {
  const sessionHash = sha256hex(i.sessionToken);
  const retry = await budgets.adminSession(sessionHash);
  if (retry > 0) return refuse('RATE_LIMITED', retry);
  return db.transaction(async (tx) => {
    const owner = await lockAdmin(tx, i.adminId);
    if (!owner) return refuse('CEREMONY_INVALID');
    // Issue #333: a passkey is a second factor on its own — no authenticator app is needed first.
    if (!(await lockEnrollSession(tx, owner, sessionHash))) return refuse('STEP_UP_REQUIRED');
    const exclude = await ownCredentials(tx, owner.id);
    if (exclude.length >= MAX_PASSKEYS_PER_OWNER) return refuse('TOO_MANY_PASSKEYS');
    const options = await registrationOptions({ rp: i.rp, userHandle: adminUserHandle(owner.id), userName: owner.email, exclude });
    const nonce = newNonce();
    await tx.insert(s.adminPasskeyChallenge).values({ challengeHash: sha256hex(options.challenge), kind: 'register', rpId: i.rp.rpId, adminUserId: owner.id, sessionHash, nonceHash: sha256hex(nonce), epoch: owner.epoch, expiresAt: expiresAt() });
    return { ok: true as const, options, nonce };
  });
}

export async function adminRegisterVerify(i: { rp: RelyingParty; adminId: string; sessionToken: string; response: RegistrationResponseJSON; nonce: string | undefined; label: string }): Promise<{ ok: true; passkey: PasskeySummary; recoveryCodes?: string[] } | Refusal> {
  const sessionHash = sha256hex(i.sessionToken);
  const retry = await budgets.adminSession(sessionHash);
  if (retry > 0) return refuse('RATE_LIMITED', retry);
  const challenge = clientDataChallenge(i.response);
  if (!challenge || !i.nonce) return refuse('CEREMONY_INVALID');
  return db.transaction(async (tx) => {
    // Credential lock first (the order mutateAdminSecondFactor uses), then the owner row: recovery codes may be issued below.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-credentials:' + i.adminId}, 0))`);
    const owner = await lockAdmin(tx, i.adminId);
    if (!owner) return refuse('CEREMONY_INVALID');
    if (!(await lockEnrollSession(tx, owner, sessionHash))) return refuse('STEP_UP_REQUIRED');
    if (!(await claimChallenge(tx, { challenge, kind: 'register', rpId: i.rp.rpId, nonce: i.nonce!, adminId: owner.id, sessionHash, epoch: owner.epoch }))) return refuse('CEREMONY_INVALID');
    const v = await verifyRegistration({ rp: i.rp, response: i.response, expectedChallenge: challenge });
    if (!v) return refuse('CEREMONY_INVALID');
    const [cnt] = await tx.select({ n: count() }).from(s.adminPasskeyCredential).where(eq(s.adminPasskeyCredential.adminUserId, owner.id));
    if (Number(cnt?.n ?? 0) >= MAX_PASSKEYS_PER_OWNER) return refuse('TOO_MANY_PASSKEYS');
    const [existing] = await tx.select({ id: s.adminPasskeyCredential.id }).from(s.adminPasskeyCredential)
      .where(and(eq(s.adminPasskeyCredential.rpId, i.rp.rpId), eq(s.adminPasskeyCredential.credentialId, v.credentialId))).limit(1);
    if (existing) return refuse('CREDENTIAL_EXISTS');
    const [row] = await tx.insert(s.adminPasskeyCredential).values({
      adminUserId: owner.id, rpId: i.rp.rpId, credentialId: v.credentialId, publicKey: v.publicKey, counter: v.counter, transports: v.transports,
      deviceType: v.deviceType, backedUp: v.backedUp, aaguid: v.aaguid, label: i.label, epoch: owner.epoch,
    }).returning();
    // Issue #333: the FIRST strong factor of an account (no authenticator app, no earlier passkey) gets its one-time
    // recovery codes now, and every other session of the account is signed out — exactly what enabling TOTP does.
    let recoveryCodes: string[] | undefined;
    if (!owner.totp && Number(cnt?.n ?? 0) === 0) {
      recoveryCodes = await regenerateRecoveryCodesTx(owner.id, tx);
      await tx.delete(s.session).where(and(eq(s.session.adminUserId, owner.id), sql`${s.session.tokenHash} <> ${sessionHash}`));
    }
    return { ok: true as const, passkey: summary(row!), ...(recoveryCodes ? { recoveryCodes } : {}) };
  });
}

export async function listAdminPasskeys(adminId: string): Promise<PasskeySummary[]> {
  const rows = await db.select().from(s.adminPasskeyCredential).where(eq(s.adminPasskeyCredential.adminUserId, adminId)).orderBy(s.adminPasskeyCredential.createdAt);
  return rows.map(summary);
}

/** §4 "admin passkey deleted": the row, every pending challenge of the admin, and step-up authority on ALL of the
 *  admin's sessions (the calling one included) — a step-up earned with the deleted credential cannot enrol a successor. */
export async function deleteAdminPasskey(i: { adminId: string; id: string; secondFactorRequired?: boolean }): Promise<boolean | 'LAST_FACTOR'> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-credentials:' + i.adminId}, 0))`);
    const owner = await lockAdmin(tx, i.adminId);
    if (!owner) return false;
    const del = await tx.delete(s.adminPasskeyCredential).where(and(eq(s.adminPasskeyCredential.id, i.id), eq(s.adminPasskeyCredential.adminUserId, owner.id))).returning({ id: s.adminPasskeyCredential.id });
    if (del.length !== 1) return false;
    // Issue #333: the last passkey of an account without an authenticator app is its only second factor.
    const [left] = await tx.select({ n: count() }).from(s.adminPasskeyCredential).where(eq(s.adminPasskeyCredential.adminUserId, owner.id));
    if (!owner.totp && Number(left?.n ?? 0) === 0) {
      if (i.secondFactorRequired) throw new LastFactorError();
      await deleteRecoveryCodes(owner.id, tx);
    }
    await invalidateAdminPending(tx, owner.id);
    await tx.update(s.session).set({ stepUpAt: null, stepUpEpoch: null }).where(and(eq(s.session.adminUserId, owner.id), sql`${s.session.stepUpAt} IS NOT NULL`));
    return true;
  });
}

class LastFactorError extends Error {}
/** Route wrapper: the refusal rolls the deletion back. */
export async function deleteAdminPasskeyChecked(i: { adminId: string; id: string; secondFactorRequired: boolean }): Promise<boolean | 'LAST_FACTOR'> {
  try { return await deleteAdminPasskey(i); } catch (e) { if (e instanceof LastFactorError) return 'LAST_FACTOR'; throw e; }
}

/** Rename one of the admin's passkeys (issue #333: account settings manage passkeys). Labels are not credentials. */
export async function renameAdminPasskey(i: { adminId: string; id: string; label: string }): Promise<PasskeySummary | null> {
  const [row] = await db.update(s.adminPasskeyCredential).set({ label: i.label })
    .where(and(eq(s.adminPasskeyCredential.id, i.id), eq(s.adminPasskeyCredential.adminUserId, i.adminId))).returning();
  return row ? summary(row) : null;
}

/** Delete every unconsumed challenge of an admin (caller holds the admin_user lock). */
export async function invalidateAdminPending(tx: Db, adminId: string): Promise<void> {
  await tx.delete(s.adminPasskeyChallenge).where(and(eq(s.adminPasskeyChallenge.adminUserId, adminId), isNull(s.adminPasskeyChallenge.consumedAt)));
}

/** TOTP invariant (§7): with ≥ 1 passkey the second factor cannot be disabled. Caller holds the admin_user lock. */
export async function adminHasPasskeys(tx: Db, adminId: string): Promise<boolean> {
  const [cnt] = await tx.select({ n: count() }).from(s.adminPasskeyCredential).where(eq(s.adminPasskeyCredential.adminUserId, adminId));
  return Number(cnt?.n ?? 0) > 0;
}

/** Expired challenge rows (job). */
export async function pruneAdminPasskeyChallenges(): Promise<number> {
  const rows = await db.delete(s.adminPasskeyChallenge).where(sql`${s.adminPasskeyChallenge.expiresAt} < now() - interval '1 hour'`).returning({ h: s.adminPasskeyChallenge.challengeHash });
  return rows.length;
}
