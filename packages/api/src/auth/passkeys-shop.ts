/**
 * Passkeys — customer side (design §7 branches A–E, §4 epoch rule, §5 lock discipline).
 *
 * Tenant tables (customer_passkey_credential / customer_passkey_challenge, forced RLS) are only reached through
 * withStore. Every transaction locks the customer row FOR UPDATE first and re-reads the calling session with a plain
 * SELECT (customer transactions never lock or delete a session row). Budgets (§8) are consumed before any
 * transaction; the per-credential budget after the unlocked identification but still outside the transaction.
 *
 * Management = proof → grant → one operation: a grant row (kind 'grant') is minted by a password proof (C), a manage
 * ceremony with an existing passkey (A), or a confirmed mailbox link (D); register/options and DELETE consume it (E).
 */
import { randomBytes } from 'node:crypto';
import { and, count, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { log } from '../lib/logger.js';
import { magicLinkPolicy } from './magic-link.js';
import { verifyPassword } from './password.js';
import { createSession, sessionPolicy } from './session.js';
import {
  CHALLENGE_TTL_SECONDS, MAILBOX_TTL_MINUTES, MAX_PASSKEYS_PER_OWNER, assertionUserHandle, authenticationOptions, b64url, budgets, clientDataChallenge,
  counterAcceptable, customerUserHandle, newNonce, registrationOptions, sha256hex, verifyAuthentication, verifyRegistration,
  type PasskeySummary, type RelyingParty,
} from './passkeys-core.js';

const expiresAt = () => new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);
const summary = (r: { id: string; label: string; deviceType: string; backedUp: boolean; createdAt: Date; lastUsedAt: Date | null }): PasskeySummary =>
  ({ id: r.id, label: r.label, deviceType: r.deviceType, backedUp: r.backedUp, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt });

export type ShopRefusal = { ok: false; code: 'RATE_LIMITED' | 'PASSKEY_INVALID' | 'CEREMONY_INVALID' | 'TOO_MANY_PASSKEYS' | 'CREDENTIAL_EXISTS' | 'NO_RECOVERY_PATH' | 'NOT_ELIGIBLE'; retry?: number };
const refuse = (code: ShopRefusal['code'], retry?: number): ShopRefusal => ({ ok: false, code, ...(retry ? { retry } : {}) });

/** Owner row under lock (§5: the first lock of every transaction). */
async function lockCustomer(tx: Tx, customerId: string) {
  const [row] = await tx.select({
    id: s.customer.id, epoch: s.customer.securityEpoch, email: s.customer.email, emailVerified: s.customer.emailVerified, passwordHash: s.customer.passwordHash,
    googleSub: s.customer.googleSub, appleUserId: s.customer.appleUserId, firstName: s.customer.firstName, lastName: s.customer.lastName, phone: s.customer.phone,
  }).from(s.customer).where(eq(s.customer.id, customerId)).for('update').limit(1);
  return row ?? null;
}

/** The calling session, live, same customer and store, legacy-expiry rule — plain read, never locked, never renewed. */
async function liveSession(tx: Tx, storeId: string, customerId: string, sessionHash: string): Promise<boolean> {
  const [row] = await tx.select({ id: s.session.id }).from(s.session).where(and(
    eq(s.session.tokenHash, sessionHash), eq(s.session.customerId, customerId), eq(s.session.storeId, storeId),
    gt(s.session.expiresAt, new Date()), or(isNull(s.session.legacyExpiresAt), gt(s.session.legacyExpiresAt, new Date())),
  )).limit(1);
  return !!row;
}

async function ownCredentials(tx: Tx, customerId: string) {
  return tx.select({ id: s.customerPasskeyCredential.id, credentialId: s.customerPasskeyCredential.credentialId, transports: s.customerPasskeyCredential.transports })
    .from(s.customerPasskeyCredential).where(eq(s.customerPasskeyCredential.customerId, customerId));
}

type Kind = 'register' | 'login' | 'manage' | 'grant';
/** Atomic claim with every binding (§7); authorizing-credential rows vanish with their credential (FK cascade). */
async function claim(tx: Tx, i: { hash: string; kind: Kind; rpId: string; storeId: string; nonce: string; customerId?: string; sessionHash?: string; epoch?: number }) {
  const conds = [
    eq(s.customerPasskeyChallenge.challengeHash, i.hash), eq(s.customerPasskeyChallenge.kind, i.kind), eq(s.customerPasskeyChallenge.rpId, i.rpId),
    eq(s.customerPasskeyChallenge.storeId, i.storeId), isNull(s.customerPasskeyChallenge.consumedAt), gt(s.customerPasskeyChallenge.expiresAt, new Date()),
    eq(s.customerPasskeyChallenge.nonceHash, sha256hex(i.nonce)),
  ];
  if (i.kind === 'login') conds.push(isNull(s.customerPasskeyChallenge.customerId));
  else conds.push(eq(s.customerPasskeyChallenge.customerId, i.customerId!), eq(s.customerPasskeyChallenge.sessionHash, i.sessionHash!), eq(s.customerPasskeyChallenge.epoch, i.epoch!));
  const rows = await tx.update(s.customerPasskeyChallenge).set({ consumedAt: new Date() }).where(and(...conds))
    .returning({ h: s.customerPasskeyChallenge.challengeHash, authorizing: s.customerPasskeyChallenge.authorizingCredentialId, source: s.customerPasskeyChallenge.grantSource });
  return rows.length === 1 ? rows[0]! : null;
}

async function lockCredential(tx: Tx, i: { id: string; storeId: string; customerId: string; epoch: number }) {
  const [cred] = await tx.select().from(s.customerPasskeyCredential).where(eq(s.customerPasskeyCredential.id, i.id)).for('update').limit(1);
  if (!cred || cred.storeId !== i.storeId || cred.customerId !== i.customerId) return null;
  if (cred.epoch !== i.epoch) {
    await tx.delete(s.customerPasskeyCredential).where(eq(s.customerPasskeyCredential.id, cred.id));
    log.warn('passkey_invalidated', { surface: 'shop', storeId: i.storeId, customerId: i.customerId, credential: cred.id, epoch: cred.epoch, current: i.epoch });
    return null;
  }
  return cred;
}

async function verifyAssertion(tx: Tx, i: { rp: RelyingParty; response: AuthenticationResponseJSON; challenge: string; cred: typeof s.customerPasskeyCredential.$inferSelect }): Promise<boolean> {
  const v = await verifyAuthentication({ rp: i.rp, response: i.response, expectedChallenge: i.challenge,
    credential: { credentialId: i.cred.credentialId, publicKey: i.cred.publicKey, counter: i.cred.counter, transports: i.cred.transports } });
  if (!v) return false;
  if (!counterAcceptable(i.cred.counter, v.newCounter)) {
    log.warn('passkey_counter_regression', { surface: 'shop', credential: i.cred.id, stored: i.cred.counter, presented: v.newCounter });
    return false;
  }
  const upd = await tx.update(s.customerPasskeyCredential).set({ counter: v.newCounter, lastUsedAt: new Date() })
    .where(and(eq(s.customerPasskeyCredential.id, i.cred.id), eq(s.customerPasskeyCredential.counter, i.cred.counter))).returning({ id: s.customerPasskeyCredential.id });
  return upd.length === 1;
}

/** A management grant row: single-use, bound to session + browser + epoch (+ the authorizing passkey). Returns the raw grant. */
async function mintGrant(tx: Tx, i: { storeId: string; rpId: string; customerId: string; sessionHash: string; epoch: number; source: 'password' | 'passkey' | 'mailbox'; authorizing?: string | null }) {
  const grant = randomBytes(32).toString('base64url');
  const nonce = newNonce();
  await tx.insert(s.customerPasskeyChallenge).values({
    challengeHash: sha256hex(grant), storeId: i.storeId, kind: 'grant', rpId: i.rpId, customerId: i.customerId, sessionHash: i.sessionHash, nonceHash: sha256hex(nonce),
    grantSource: i.source, authorizingCredentialId: i.authorizing ?? null, epoch: i.epoch, expiresAt: expiresAt(),
  });
  return { grant, nonce };
}

/** §4 deletions for a customer whose pending authorization must end (caller holds the customer lock). */
export async function invalidateCustomerPending(tx: Tx, storeId: string, customerId: string): Promise<void> {
  await tx.delete(s.customerPasskeyChallenge).where(and(eq(s.customerPasskeyChallenge.storeId, storeId), eq(s.customerPasskeyChallenge.customerId, customerId), isNull(s.customerPasskeyChallenge.consumedAt)));
  await tx.update(s.customerToken).set({ usedAt: new Date() }).where(and(eq(s.customerToken.customerId, customerId), eq(s.customerToken.kind, 'passkey_manage'), isNull(s.customerToken.usedAt)));
}

/** Password reset / signed-in password change (§4): every credential and every pending authorization of the customer. */
export async function deleteCustomerPasskeysForRecovery(tx: Tx, storeId: string, customerId: string): Promise<number> {
  await invalidateCustomerPending(tx, storeId, customerId);
  const rows = await tx.delete(s.customerPasskeyCredential).where(and(eq(s.customerPasskeyCredential.storeId, storeId), eq(s.customerPasskeyCredential.customerId, customerId))).returning({ id: s.customerPasskeyCredential.id });
  return rows.length;
}

export async function customerHasPasskeys(tx: Tx, customerId: string): Promise<boolean> {
  const [cnt] = await tx.select({ n: count() }).from(s.customerPasskeyCredential).where(eq(s.customerPasskeyCredential.customerId, customerId));
  return Number(cnt?.n ?? 0) > 0;
}

// ── Branch A: discoverable login ─────────────────────────────────────────────

export async function shopLoginOptions(i: { rp: RelyingParty; storeId: string }) {
  const options = await authenticationOptions({ rp: i.rp, allow: [] });
  const nonce = newNonce();
  await withStore(i.storeId, (tx) => tx.insert(s.customerPasskeyChallenge).values({
    challengeHash: sha256hex(options.challenge), storeId: i.storeId, kind: 'login', rpId: i.rp.rpId, nonceHash: sha256hex(nonce), expiresAt: expiresAt(),
  }));
  return { options, nonce };
}

export type CustomerRow = { id: string; email: string; firstName: string | null; lastName: string | null; phone: string | null; emailVerified: boolean; isMigrated: boolean };

export async function shopLoginVerify(i: { rp: RelyingParty; storeId: string; storeConfig: unknown; response: AuthenticationResponseJSON; nonce: string | undefined; ip: string }): Promise<{ ok: true; token: string; customer: CustomerRow } | ShopRefusal> {
  const retry = await budgets.shopVerify(i.storeId, i.ip);
  if (retry > 0) return refuse('RATE_LIMITED', retry);
  const challenge = clientDataChallenge(i.response);
  if (!challenge || !i.nonce) return refuse('PASSKEY_INVALID');
  const found = await withStore(i.storeId, async (tx) => (await tx.select({ id: s.customerPasskeyCredential.id, customerId: s.customerPasskeyCredential.customerId })
    .from(s.customerPasskeyCredential).where(and(eq(s.customerPasskeyCredential.rpId, i.rp.rpId), eq(s.customerPasskeyCredential.credentialId, i.response.id))).limit(1))[0] ?? null);
  if (!found) return refuse('PASSKEY_INVALID');
  const credRetry = await budgets.shopCredential(i.storeId, i.response.id);
  if (credRetry > 0) return refuse('RATE_LIMITED', credRetry);
  return withStore(i.storeId, async (tx) => {
    const owner = await lockCustomer(tx, found.customerId);
    if (!owner) return refuse('PASSKEY_INVALID');
    if (!(await claim(tx, { hash: sha256hex(challenge), kind: 'login', rpId: i.rp.rpId, storeId: i.storeId, nonce: i.nonce! }))) return refuse('PASSKEY_INVALID');
    const cred = await lockCredential(tx, { id: found.id, storeId: i.storeId, customerId: owner.id, epoch: owner.epoch });
    if (!cred) return refuse('PASSKEY_INVALID');
    if (assertionUserHandle(i.response) !== b64url(customerUserHandle(i.storeId, owner.id))) return refuse('PASSKEY_INVALID');
    if (!(await verifyAssertion(tx, { rp: i.rp, response: i.response, challenge, cred }))) return refuse('PASSKEY_INVALID');
    // Same rule as native login: an account that never proved its mailbox gets no session (checked after verification,
    // so this is never an account-existence oracle).
    if (!owner.emailVerified) return refuse('PASSKEY_INVALID');
    const token = await createSession(tx, i.storeId, owner.id, sessionPolicy(i.storeConfig));
    return { ok: true as const, token, customer: { id: owner.id, email: owner.email, firstName: owner.firstName, lastName: owner.lastName, phone: owner.phone, emailVerified: owner.emailVerified, isMigrated: owner.passwordHash == null } };
  });
}

// ── Branch A (manage) + C + D: proofs that mint a grant ──────────────────────

export async function shopManageOptions(i: { rp: RelyingParty; storeId: string; customerId: string; sessionToken: string }): Promise<{ ok: true; options: Awaited<ReturnType<typeof authenticationOptions>>; nonce: string } | ShopRefusal> {
  const sessionHash = sha256hex(i.sessionToken);
  const retry = await budgets.shopSession(sessionHash);
  if (retry > 0) return refuse('RATE_LIMITED', retry);
  return withStore(i.storeId, async (tx) => {
    const owner = await lockCustomer(tx, i.customerId);
    if (!owner || !owner.emailVerified || !(await liveSession(tx, i.storeId, owner.id, sessionHash))) return refuse('CEREMONY_INVALID');
    const allow = await ownCredentials(tx, owner.id);
    if (allow.length === 0) return refuse('CEREMONY_INVALID');
    const options = await authenticationOptions({ rp: i.rp, allow });
    const nonce = newNonce();
    await tx.insert(s.customerPasskeyChallenge).values({ challengeHash: sha256hex(options.challenge), storeId: i.storeId, kind: 'manage', rpId: i.rp.rpId, customerId: owner.id, sessionHash, nonceHash: sha256hex(nonce), epoch: owner.epoch, expiresAt: expiresAt() });
    return { ok: true as const, options, nonce };
  });
}

export async function shopManageVerify(i: { rp: RelyingParty; storeId: string; customerId: string; sessionToken: string; response: AuthenticationResponseJSON; nonce: string | undefined }): Promise<{ ok: true; grant: string; grantNonce: string } | ShopRefusal> {
  const sessionHash = sha256hex(i.sessionToken);
  const retry = await budgets.shopSession(sessionHash);
  if (retry > 0) return refuse('RATE_LIMITED', retry);
  const challenge = clientDataChallenge(i.response);
  if (!challenge || !i.nonce) return refuse('CEREMONY_INVALID');
  return withStore(i.storeId, async (tx) => {
    const owner = await lockCustomer(tx, i.customerId);
    if (!owner || !owner.emailVerified || !(await liveSession(tx, i.storeId, owner.id, sessionHash))) return refuse('CEREMONY_INVALID');
    const [found] = await tx.select({ id: s.customerPasskeyCredential.id }).from(s.customerPasskeyCredential)
      .where(and(eq(s.customerPasskeyCredential.rpId, i.rp.rpId), eq(s.customerPasskeyCredential.credentialId, i.response.id), eq(s.customerPasskeyCredential.customerId, owner.id))).limit(1);
    if (!found) return refuse('CEREMONY_INVALID');
    if (!(await claim(tx, { hash: sha256hex(challenge), kind: 'manage', rpId: i.rp.rpId, storeId: i.storeId, nonce: i.nonce!, customerId: owner.id, sessionHash, epoch: owner.epoch }))) return refuse('CEREMONY_INVALID');
    const cred = await lockCredential(tx, { id: found.id, storeId: i.storeId, customerId: owner.id, epoch: owner.epoch });
    if (!cred) return refuse('CEREMONY_INVALID');
    if (!(await verifyAssertion(tx, { rp: i.rp, response: i.response, challenge, cred }))) return refuse('CEREMONY_INVALID');
    const g = await mintGrant(tx, { storeId: i.storeId, rpId: i.rp.rpId, customerId: owner.id, sessionHash, epoch: owner.epoch, source: 'passkey', authorizing: cred.id });
    return { ok: true as const, grant: g.grant, grantNonce: g.nonce };
  });
}

/** Branch C. The Argon2 verification runs outside the transaction; the hash is re-checked under the lock. */
export async function shopGrantFromPassword(i: { rp: RelyingParty; storeId: string; customerId: string; sessionToken: string; password: string }): Promise<{ ok: true; grant: string; grantNonce: string } | ShopRefusal> {
  const sessionHash = sha256hex(i.sessionToken);
  const retry = await budgets.shopSession(sessionHash);
  if (retry > 0) return refuse('RATE_LIMITED', retry);
  const current = await withStore(i.storeId, async (tx) => (await tx.select({ hash: s.customer.passwordHash }).from(s.customer).where(eq(s.customer.id, i.customerId)).limit(1))[0]?.hash ?? null);
  if (!(await verifyPassword(i.password, current))) return refuse('CEREMONY_INVALID');
  return withStore(i.storeId, async (tx) => {
    const owner = await lockCustomer(tx, i.customerId);
    if (!owner || !owner.emailVerified || owner.passwordHash !== current || !(await liveSession(tx, i.storeId, owner.id, sessionHash))) return refuse('CEREMONY_INVALID');
    const g = await mintGrant(tx, { storeId: i.storeId, rpId: i.rp.rpId, customerId: owner.id, sessionHash, epoch: owner.epoch, source: 'password' });
    return { ok: true as const, grant: g.grant, grantNonce: g.nonce };
  });
}

/** Branch D, request: only for an account with neither a password nor a passkey; the token payload binds the
 *  initiating session, browser and epoch. `mail` enqueues the message inside the same transaction. */
export async function shopMailboxRequest(i: { storeId: string; customerId: string; sessionToken: string; mail: (tx: Tx, rawToken: string, email: string) => Promise<void> }): Promise<{ ok: true; nonce: string; sent: boolean } | ShopRefusal> {
  const sessionHash = sha256hex(i.sessionToken);
  const retry = await budgets.shopSession(sessionHash);
  if (retry > 0) return refuse('RATE_LIMITED', retry);
  const mailRetry = await budgets.shopMail(i.storeId, i.customerId);
  if (mailRetry > 0) return refuse('RATE_LIMITED', mailRetry);
  const nonce = newNonce();
  return withStore(i.storeId, async (tx) => {
    const owner = await lockCustomer(tx, i.customerId);
    if (!owner || !owner.emailVerified || !(await liveSession(tx, i.storeId, owner.id, sessionHash))) return refuse('CEREMONY_INVALID');
    if (owner.passwordHash || (await customerHasPasskeys(tx, owner.id))) return { ok: true as const, nonce, sent: false }; // identical answer: not eligible, nothing minted
    const raw = randomBytes(32).toString('base64url');
    await tx.insert(s.customerToken).values({
      storeId: i.storeId, customerId: owner.id, kind: 'passkey_manage', tokenHash: sha256hex(raw), expiresAt: new Date(Date.now() + MAILBOX_TTL_MINUTES * 60 * 1000),
      payload: { sessionHash, nonceHash: sha256hex(nonce), epoch: owner.epoch },
    });
    await i.mail(tx, raw, owner.email);
    return { ok: true as const, nonce, sent: true };
  });
}

/** Branch D, confirm: same session, same browser, same epoch, still eligible; atomic claim → grant. */
export async function shopMailboxConfirm(i: { rp: RelyingParty; storeId: string; customerId: string; sessionToken: string; token: string; nonce: string | undefined }): Promise<{ ok: true; grant: string; grantNonce: string } | ShopRefusal> {
  const sessionHash = sha256hex(i.sessionToken);
  const retry = await budgets.shopSession(sessionHash);
  if (retry > 0) return refuse('RATE_LIMITED', retry);
  if (!i.nonce) return refuse('CEREMONY_INVALID');
  return withStore(i.storeId, async (tx) => {
    const owner = await lockCustomer(tx, i.customerId);
    if (!owner || !owner.emailVerified || !(await liveSession(tx, i.storeId, owner.id, sessionHash))) return refuse('CEREMONY_INVALID');
    if (owner.passwordHash || (await customerHasPasskeys(tx, owner.id))) return refuse('CEREMONY_INVALID');
    const claimed = await tx.update(s.customerToken).set({ usedAt: new Date() }).where(and(
      eq(s.customerToken.tokenHash, sha256hex(i.token)), eq(s.customerToken.kind, 'passkey_manage'), eq(s.customerToken.storeId, i.storeId), eq(s.customerToken.customerId, owner.id),
      isNull(s.customerToken.usedAt), gt(s.customerToken.expiresAt, new Date()),
      sql`${s.customerToken.payload} ->> 'sessionHash' = ${sessionHash}`, sql`${s.customerToken.payload} ->> 'nonceHash' = ${sha256hex(i.nonce!)}`,
      sql`(${s.customerToken.payload} ->> 'epoch')::int = ${owner.epoch}`,
    )).returning({ id: s.customerToken.id });
    if (claimed.length !== 1) return refuse('CEREMONY_INVALID');
    const g = await mintGrant(tx, { storeId: i.storeId, rpId: i.rp.rpId, customerId: owner.id, sessionHash, epoch: owner.epoch, source: 'mailbox' });
    return { ok: true as const, grant: g.grant, grantNonce: g.nonce };
  });
}

// ── Branch E + B: grant consumption, registration, deletion ──────────────────

export async function shopRegisterOptions(i: { rp: RelyingParty; storeId: string; customerId: string; sessionToken: string; grant: string; nonce: string | undefined }): Promise<{ ok: true; options: Awaited<ReturnType<typeof registrationOptions>>; nonce: string } | ShopRefusal> {
  const sessionHash = sha256hex(i.sessionToken);
  const retry = await budgets.shopSession(sessionHash);
  if (retry > 0) return refuse('RATE_LIMITED', retry);
  if (!i.nonce) return refuse('CEREMONY_INVALID');
  return withStore(i.storeId, async (tx) => {
    const owner = await lockCustomer(tx, i.customerId);
    if (!owner || !owner.emailVerified || !(await liveSession(tx, i.storeId, owner.id, sessionHash))) return refuse('CEREMONY_INVALID');
    const g = await claim(tx, { hash: sha256hex(i.grant), kind: 'grant', rpId: i.rp.rpId, storeId: i.storeId, nonce: i.nonce!, customerId: owner.id, sessionHash, epoch: owner.epoch });
    if (!g) return refuse('CEREMONY_INVALID');
    const exclude = await ownCredentials(tx, owner.id);
    if (exclude.length >= MAX_PASSKEYS_PER_OWNER) return refuse('TOO_MANY_PASSKEYS');
    const options = await registrationOptions({ rp: i.rp, userHandle: customerUserHandle(i.storeId, owner.id), userName: owner.email, exclude });
    const nonce = newNonce();
    await tx.insert(s.customerPasskeyChallenge).values({
      challengeHash: sha256hex(options.challenge), storeId: i.storeId, kind: 'register', rpId: i.rp.rpId, customerId: owner.id, sessionHash, nonceHash: sha256hex(nonce),
      authorizingCredentialId: g.authorizing ?? null, epoch: owner.epoch, expiresAt: expiresAt(),
    });
    return { ok: true as const, options, nonce };
  });
}

export async function shopRegisterVerify(i: { rp: RelyingParty; storeId: string; customerId: string; sessionToken: string; response: RegistrationResponseJSON; nonce: string | undefined; label: string }): Promise<{ ok: true; passkey: PasskeySummary } | ShopRefusal> {
  const sessionHash = sha256hex(i.sessionToken);
  const retry = await budgets.shopSession(sessionHash);
  if (retry > 0) return refuse('RATE_LIMITED', retry);
  const challenge = clientDataChallenge(i.response);
  if (!challenge || !i.nonce) return refuse('CEREMONY_INVALID');
  return withStore(i.storeId, async (tx) => {
    const owner = await lockCustomer(tx, i.customerId);
    if (!owner || !owner.emailVerified || !(await liveSession(tx, i.storeId, owner.id, sessionHash))) return refuse('CEREMONY_INVALID');
    if (!(await claim(tx, { hash: sha256hex(challenge), kind: 'register', rpId: i.rp.rpId, storeId: i.storeId, nonce: i.nonce!, customerId: owner.id, sessionHash, epoch: owner.epoch }))) return refuse('CEREMONY_INVALID');
    const v = await verifyRegistration({ rp: i.rp, response: i.response, expectedChallenge: challenge });
    if (!v) return refuse('CEREMONY_INVALID');
    const existing = await ownCredentials(tx, owner.id);
    if (existing.length >= MAX_PASSKEYS_PER_OWNER) return refuse('TOO_MANY_PASSKEYS');
    const [dup] = await tx.select({ id: s.customerPasskeyCredential.id }).from(s.customerPasskeyCredential)
      .where(and(eq(s.customerPasskeyCredential.rpId, i.rp.rpId), eq(s.customerPasskeyCredential.credentialId, v.credentialId))).limit(1);
    if (dup) return refuse('CREDENTIAL_EXISTS');
    const [row] = await tx.insert(s.customerPasskeyCredential).values({
      storeId: i.storeId, customerId: owner.id, rpId: i.rp.rpId, credentialId: v.credentialId, publicKey: v.publicKey, counter: v.counter, transports: v.transports,
      deviceType: v.deviceType, backedUp: v.backedUp, aaguid: v.aaguid, label: i.label, epoch: owner.epoch,
    }).returning();
    // §4 "customer passkey registered": mailbox bootstrap eligibility ended, and when this is the first current-epoch
    // credential every pending authorization (grants, outstanding register challenges) ends with it.
    await tx.update(s.customerToken).set({ usedAt: new Date() }).where(and(eq(s.customerToken.customerId, owner.id), eq(s.customerToken.kind, 'passkey_manage'), isNull(s.customerToken.usedAt)));
    if (existing.length === 0) await tx.delete(s.customerPasskeyChallenge).where(and(eq(s.customerPasskeyChallenge.storeId, i.storeId), eq(s.customerPasskeyChallenge.customerId, owner.id), isNull(s.customerPasskeyChallenge.consumedAt)));
    return { ok: true as const, passkey: summary(row!) };
  });
}

export async function listCustomerPasskeys(storeId: string, customerId: string): Promise<PasskeySummary[]> {
  const rows = await withStore(storeId, (tx) => tx.select().from(s.customerPasskeyCredential).where(eq(s.customerPasskeyCredential.customerId, customerId)).orderBy(s.customerPasskeyCredential.createdAt));
  return rows.map(summary);
}

/** Branch E (delete): consumes the grant; last-credential guard (§7); then §4 deletions. */
export async function shopDeletePasskey(i: { rp: RelyingParty; storeId: string; storeConfig: unknown; customerId: string; sessionToken: string; id: string; grant: string; nonce: string | undefined }): Promise<{ ok: true } | ShopRefusal> {
  const sessionHash = sha256hex(i.sessionToken);
  const retry = await budgets.shopSession(sessionHash);
  if (retry > 0) return refuse('RATE_LIMITED', retry);
  if (!i.nonce) return refuse('CEREMONY_INVALID');
  return withStore(i.storeId, async (tx) => {
    const owner = await lockCustomer(tx, i.customerId);
    if (!owner || !owner.emailVerified || !(await liveSession(tx, i.storeId, owner.id, sessionHash))) return refuse('CEREMONY_INVALID');
    if (!(await claim(tx, { hash: sha256hex(i.grant), kind: 'grant', rpId: i.rp.rpId, storeId: i.storeId, nonce: i.nonce!, customerId: owner.id, sessionHash, epoch: owner.epoch }))) return refuse('CEREMONY_INVALID');
    const own = await ownCredentials(tx, owner.id);
    if (!own.some((c) => c.id === i.id)) return refuse('CEREMONY_INVALID');
    const last = own.length === 1;
    const recoverable = !!owner.passwordHash || !!owner.googleSub || !!owner.appleUserId || magicLinkPolicy(i.storeConfig).enabled;
    if (last && !recoverable) return refuse('NO_RECOVERY_PATH');
    await tx.delete(s.customerPasskeyCredential).where(and(eq(s.customerPasskeyCredential.id, i.id), eq(s.customerPasskeyCredential.customerId, owner.id)));
    await invalidateCustomerPending(tx, i.storeId, owner.id);
    return { ok: true as const };
  });
}

/** Expired challenge/grant rows of one store (job; the table is RLS-forced so the job walks the stores). */
export async function pruneCustomerPasskeyChallenges(storeId: string): Promise<number> {
  const rows = await withStore(storeId, (tx) => tx.delete(s.customerPasskeyChallenge)
    .where(and(eq(s.customerPasskeyChallenge.storeId, storeId), sql`${s.customerPasskeyChallenge.expiresAt} < now() - interval '1 hour'`)).returning({ h: s.customerPasskeyChallenge.challengeHash }));
  return rows.length;
}
