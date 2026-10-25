/**
 * Saved admin accounts (#355, phase 1): the target side of the hub sign-in handoff (migration 0113).
 *
 * A hub (a central admin client that keeps target sessions in its own encrypted vault) enrols an account on this
 * server like an OAuth authorization-code + PKCE client, with every parameter fixed by configuration:
 *
 *  1. The admin signs in HERE (password, TOTP, passkey: this server's own ceremony and RP), then the admin SPA calls
 *     POST /v1/admin/handoff/authorize with the hub's client id, its exact callback, the hub's opaque state and an
 *     S256 code challenge. The call runs behind admin-agent-guard (MFA enrolment and passkey review still gate it),
 *     is refused for agents and API tokens, and needs a session signed in or stepped up in the last 10 minutes.
 *  2. The SPA navigates to the callback with `code`, `state` and `iss`. The code lives 60 seconds and only its sha256
 *     is stored, bound to the client, the callback, the challenge, the issuing session and the security epoch.
 *  3. The hub redeems it once, server to server: POST /v1/admin/handoff/token with the client secret and the PKCE
 *     verifier. The row is deleted in the same statement that reads it, so a code works at most once whatever the
 *     outcome; then the issuing session must still be live and the epoch unchanged. Success is a NEW session for the
 *     same admin (the hub's own credential; signing out here never ends it, and the hub revokes it with logout).
 *
 * Nothing here is configurable from a request: an unregistered client or a callback that is not byte-equal to the
 * registered one is refused before anything is stored.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { unsafeUnscopedDb as db } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { adminSessionTtlMs } from './admin-session.js';
import type { AdminPrincipal } from './admin-session.js';
import { parseHandoffClients, parseHandoffIssuer, type HandoffClient } from './admin-handoff-config.js';

export { parseHandoffClients };

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
/** RFC 7636: verifier 43-128 unreserved chars; an S256 challenge is 43 base64url chars. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9._~-]{16,256}$/;

export const HANDOFF_CODE_TTL_SECONDS = 60;
/** The issuing session must have signed in or stepped up this recently: the handoff hands out a long-lived session. */
export const HANDOFF_FRESH_AUTH_MS = 10 * 60 * 1000;

let cache: { raw: string | undefined; clients: HandoffClient[] } | undefined;
function clients(): HandoffClient[] {
  if (!cache || cache.raw !== env.ADMIN_HANDOFF_CLIENTS) cache = { raw: env.ADMIN_HANDOFF_CLIENTS, clients: parseHandoffClients(env.ADMIN_HANDOFF_CLIENTS, env.NODE_ENV === 'production') };
  return cache.clients;
}

/** The handoff is on only with an issuer and at least one registered client. */
export const handoffIssuer = (): string | null => (env.ADMIN_HANDOFF_ISSUER && clients().length ? parseHandoffIssuer(env.ADMIN_HANDOFF_ISSUER, env.NODE_ENV === 'production') : null);

/** The registered client whose id AND exact callback match, else null. */
export function findHandoffClient(clientId: string, redirectUri: string): HandoffClient | null {
  return clients().find((c) => c.id === clientId && c.redirectUri === redirectUri) ?? null;
}

export const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

function secretMatches(client: HandoffClient, secret: string): boolean {
  const a = Buffer.from(sha256(secret), 'hex'), b = Buffer.from(client.secretSha256, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export type AuthorizeRefusal = 'disabled' | 'unknown_client' | 'bad_request' | 'not_human_session' | 'fresh_auth_required';

/** Step 1: issue a code for this principal. The caller has already passed admin-agent-guard + requireAdmin. */
export async function issueHandoffCode(principal: AdminPrincipal, p: { clientId: string; redirectUri: string; state: string; codeChallenge: string; codeChallengeMethod: string }, now = Date.now()):
  Promise<{ ok: true; redirectTo: string } | { ok: false; reason: AuthorizeRefusal }> {
  const issuer = handoffIssuer();
  if (!issuer) return { ok: false, reason: 'disabled' };
  const client = findHandoffClient(p.clientId, p.redirectUri);
  if (!client) return { ok: false, reason: 'unknown_client' };
  if (p.codeChallengeMethod !== 'S256' || !CHALLENGE.test(p.codeChallenge) || !STATE.test(p.state)) return { ok: false, reason: 'bad_request' };
  if (principal.kind !== 'human' || principal.auth !== 'session' || principal.apiTokenId || !principal.sessionId) return { ok: false, reason: 'not_human_session' };
  const freshAt = Math.max(principal.sessionCreatedAt?.getTime() ?? 0,
    principal.stepUpAt && principal.stepUpEpoch === principal.securityEpoch ? principal.stepUpAt.getTime() : 0);
  if (now - freshAt > HANDOFF_FRESH_AUTH_MS) return { ok: false, reason: 'fresh_auth_required' };
  const code = randomBytes(32).toString('base64url');
  await db.transaction(async (tx) => {
    await tx.delete(s.adminHandoffCode).where(lt(s.adminHandoffCode.expiresAt, sql`clock_timestamp()`));
    await tx.insert(s.adminHandoffCode).values({ codeHash: sha256(code), clientId: client.id, redirectUri: client.redirectUri, codeChallenge: p.codeChallenge,
      adminUserId: principal.id, sessionId: principal.sessionId!, epoch: principal.securityEpoch, expiresAt: new Date(now + HANDOFF_CODE_TTL_SECONDS * 1000) });
  });
  const to = new URL(client.redirectUri);
  to.searchParams.set('code', code);
  to.searchParams.set('state', p.state);
  to.searchParams.set('iss', issuer);
  return { ok: true, redirectTo: to.href };
}

export type RedeemResult =
  | { ok: true; token: string; expiresInSeconds: number; admin: { id: string; email: string }; issuer: string }
  | { ok: false; reason: 'disabled' | 'invalid_client' | 'invalid_grant' };

/** Step 3: redeem once. Every failure after the client check spends the code. */
export async function redeemHandoffCode(p: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string }): Promise<RedeemResult> {
  const issuer = handoffIssuer();
  if (!issuer) return { ok: false, reason: 'disabled' };
  const client = findHandoffClient(p.clientId, p.redirectUri);
  if (!client || !secretMatches(client, p.clientSecret)) return { ok: false, reason: 'invalid_client' };
  const [row] = await db.delete(s.adminHandoffCode)
    .where(and(eq(s.adminHandoffCode.codeHash, sha256(p.code)), gt(s.adminHandoffCode.expiresAt, sql`clock_timestamp()`)))
    .returning();
  if (!row || row.clientId !== client.id || row.redirectUri !== client.redirectUri) return { ok: false, reason: 'invalid_grant' };
  if (!VERIFIER.test(p.codeVerifier)) return { ok: false, reason: 'invalid_grant' };
  const want = Buffer.from(row.codeChallenge), got = Buffer.from(s256(p.codeVerifier));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: 'invalid_grant' };
  // Owner row first, FOR SHARE (the P1b order of createAdminSessionIfCredential): a password reset or change, or a
  // first-factor enrolment that signs out other sessions, either commits before this check (and the code is refused)
  // or waits until the new session exists and then revokes it too. The issuing session must still be live (not
  // signed out, expired, idle or revoked) and the security epoch unchanged (no TOTP change or password reset since
  // the code was issued; passkey changes do not move the epoch, the 60-second lifetime bounds that window).
  const idleHours = env.ADMIN_SESSION_IDLE_HOURS;
  const minted = await db.transaction(async (tx) => {
    const [u] = await tx.select({ email: s.adminUser.email, epoch: s.adminUser.securityEpoch, kind: s.adminUser.kind })
      .from(s.adminUser).where(eq(s.adminUser.id, row.adminUserId)).for('share').limit(1);
    if (!u || u.epoch !== row.epoch || u.kind === 'agent') return null;
    const [own] = await tx.select({ id: s.session.id }).from(s.session)
      .where(and(eq(s.session.id, row.sessionId), eq(s.session.adminUserId, row.adminUserId), isNull(s.session.apiTokenId), gt(s.session.expiresAt, sql`clock_timestamp()`),
        ...(idleHours > 0 ? [sql`coalesce(${s.session.lastSeenAt}, ${s.session.createdAt}) > clock_timestamp() - make_interval(secs => ${idleHours * 3600})`] : [])))
      .limit(1);
    if (!own) return null;
    const token = randomBytes(32).toString('hex');
    await tx.insert(s.session).values({ adminUserId: row.adminUserId, tokenHash: sha256(token), handoffClientId: client.id,
      expiresAt: new Date(Date.now() + adminSessionTtlMs()), lastSeenAt: new Date() });
    return { token, email: u.email };
  });
  if (!minted) return { ok: false, reason: 'invalid_grant' };
  return { ok: true, token: minted.token, expiresInSeconds: Math.floor(adminSessionTtlMs() / 1000), admin: { id: row.adminUserId, email: minted.email }, issuer };
}
