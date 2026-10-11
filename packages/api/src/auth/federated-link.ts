/**
 * Federated sign-in confirmation links (provider-neutral; Google today, Apple next).
 *
 * When an external identity provider cannot vouch for the address on its token, the sign-in endpoint must not look
 * the address up (that would reveal whether an account exists). It mails this link to the address instead and answers
 * every such request identically; only redeeming the link — proof of CURRENT mailbox control by the browser that
 * started the flow — may link or create an account.
 *
 * The link is a stateless signed token, hardened three ways:
 *  - bound to the initiating browser: the token carries sha256(nonce); the nonce itself rides in an HttpOnly cookie set
 *    on the 202 response. A link opened in another browser (or forwarded to an attacker) carries no matching cookie.
 *  - single use: redemption records sha256(jti) in federated_link_redemption (migration 0096); a replay conflicts.
 *  - short-lived (30 min) and keyed by a purpose-derived key, never the raw deployment secret.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { env } from '../env.js';

export type FederatedProvider = 'google' | 'apple';
const PROVIDERS: ReadonlySet<string> = new Set<FederatedProvider>(['google', 'apple']);

export const FEDERATED_LINK_TTL_MS = 30 * 60 * 1000;
export const MIN_LINK_SECRET_LENGTH = 32;
const KEY_PURPOSE = 'sellright/federated-link/v1';

export class FederatedLinkUnavailableError extends Error {
  constructor() {
    super('federated sign-in links need a deployment secret of at least 32 characters (COOKIE_SECRET, LICENSING_HMAC_SECRET or DOWNLOAD_URL_SECRET)');
  }
}

/**
 * Purpose key = HMAC(secret, KEY_PURPOSE). `raw` is the first non-empty deployment secret (callers pick with `||`, so
 * an empty string is skipped, not used as a key). A secret shorter than 32 chars is refused. Outside production a
 * missing or short secret falls back to a random per-process key (links die on restart); in production it throws, so a
 * misconfigured deploy cannot mint forgeable links.
 */
export function deriveLinkKey(raw: string | undefined, nodeEnv: string): Buffer {
  const secret = raw && raw.length >= MIN_LINK_SECRET_LENGTH ? raw : undefined;
  if (!secret) {
    if (nodeEnv === 'production') throw new FederatedLinkUnavailableError();
    return createHmac('sha256', randomBytes(32)).update(KEY_PURPOSE).digest();
  }
  return createHmac('sha256', secret).update(KEY_PURPOSE).digest();
}

let cachedKey: Buffer | undefined;
const linkKey = (): Buffer =>
  (cachedKey ??= deriveLinkKey(
    env.COOKIE_SECRET || process.env.COOKIE_SECRET || env.LICENSING_HMAC_SECRET || process.env.LICENSING_HMAC_SECRET || env.DOWNLOAD_URL_SECRET || undefined,
    env.NODE_ENV,
  ));

/** True when links can be minted (always outside production; in production only with a usable secret). */
export function federatedLinkAvailable(): boolean {
  try { linkKey(); return true; } catch { return false; }
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
export const newLinkNonce = (): string => randomBytes(32).toString('base64url');
export const hashLinkNonce = sha256hex;

export type FederatedLinkClaims = {
  provider: FederatedProvider;
  storeId: string;
  subject: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
};
export type VerifiedFederatedLink = FederatedLinkClaims & { nonceHash: string; jti: string; exp: number };

const sign = (body: string, key: Buffer) => createHmac('sha256', key).update(body).digest('base64url');

/** Mint a link token bound to `nonceHash` (sha256 of the browser nonce). Throws FederatedLinkUnavailableError in a misconfigured production. */
export function signFederatedLink(c: FederatedLinkClaims, nonceHash: string, now = Date.now(), key: Buffer = linkKey()): string {
  const body = Buffer.from(JSON.stringify({ v: 1, p: c.provider, st: c.storeId, sub: c.subject, em: c.email, fn: c.firstName, ln: c.lastName, nh: nonceHash, jti: randomBytes(16).toString('base64url'), exp: now + FEDERATED_LINK_TTL_MS })).toString('base64url');
  return `${body}.${sign(body, key)}`;
}

/** Claims when signature, expiry, provider and store all check out; otherwise null (including when links are unavailable). */
export function verifyFederatedLink(token: string, storeId: string, now = Date.now(), key?: Buffer): VerifiedFederatedLink | null {
  let k: Buffer;
  try { k = key ?? linkKey(); } catch { return null; }
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(sign(body, k));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (p.v !== 1 || p.st !== storeId || typeof p.p !== 'string' || !PROVIDERS.has(p.p) || typeof p.sub !== 'string' || typeof p.em !== 'string' ||
        typeof p.nh !== 'string' || typeof p.jti !== 'string' || typeof p.exp !== 'number' || p.exp <= now) return null;
    return { provider: p.p as FederatedProvider, storeId, subject: p.sub, email: p.em, firstName: typeof p.fn === 'string' ? p.fn : null, lastName: typeof p.ln === 'string' ? p.ln : null, nonceHash: p.nh, jti: p.jti, exp: p.exp };
  } catch {
    return null;
  }
}

/** Constant-time check that the browser's cookie nonce is the one the token was bound to. */
export function nonceMatches(cookieNonce: string | undefined, nonceHash: string): boolean {
  if (!cookieNonce) return false;
  const a = Buffer.from(hashLinkNonce(cookieNonce));
  const b = Buffer.from(nonceHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Record a redemption; true the first time, false on any replay. Runs in the caller's store-scoped tx. */
export async function redeemFederatedLink(tx: Tx, storeId: string, jti: string, expMs: number): Promise<boolean> {
  const r = await tx.execute(sql`
    INSERT INTO federated_link_redemption (store_id, jti_hash, expires_at)
    VALUES (${storeId}, ${sha256hex(jti)}, ${new Date(expMs).toISOString()}::timestamptz)
    ON CONFLICT DO NOTHING
    RETURNING jti_hash
  `);
  return r.rows.length > 0;
}
