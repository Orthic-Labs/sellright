import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { cookie, CUST_COOKIE } from './cookies.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Customer-session policy, resolved per store. `store.config.auth` wins;
 * env is the deployment default:
 *   auth.sessionTtlDays          <- SESSION_TTL_DAYS          (default 30)
 *   auth.renewable               <- SESSION_RENEWABLE         (default false)
 *   auth.sessionRenewWindowDays  <- SESSION_RENEW_WINDOW_DAYS (default 7)
 * SellRight's defaults keep the historical 30-day non-renewing behavior; a
 * deployment or tenant opts into longer/sliding sessions explicitly (e.g.
 * RightSites runs 365-day renewable sessions downstream).
 */
export interface SessionPolicy {
  /** Session (and customer-cookie) lifetime. */
  ttlMs: number;
  /** Whether an authenticated resolve may extend expiresAt. */
  renewable: boolean;
  /** Renew when the remaining lifetime drops below this. */
  renewWindowMs: number;
}

/** The `auth` section of store.config, or {} — shared by session/magic-link/apple resolvers. */
export function storeAuthConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object') return {};
  const auth = (config as Record<string, unknown>).auth;
  return auth && typeof auth === 'object' ? (auth as Record<string, unknown>) : {};
}

const positiveNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

export function sessionPolicy(config: unknown): SessionPolicy {
  const auth = storeAuthConfig(config);
  const ttlDays = positiveNumber(auth.sessionTtlDays) ?? env.SESSION_TTL_DAYS;
  const renewable = typeof auth.renewable === 'boolean' ? auth.renewable : env.SESSION_RENEWABLE === 'true';
  const windowDays = positiveNumber(auth.sessionRenewWindowDays) ?? env.SESSION_RENEW_WINDOW_DAYS;
  return { ttlMs: ttlDays * DAY_MS, renewable, renewWindowMs: windowDays * DAY_MS };
}

/**
 * The expiry a renewable session should slide to, or null to leave it alone.
 * Pure decision logic — unit-testable without a DB. Renewal only ever EXTENDS:
 * a session already past now+ttl keeps its earlier expiry.
 */
export function renewedSessionExpiry(expiresAt: Date, nowMs: number, policy: SessionPolicy): Date | null {
  if (!policy.renewable) return null;
  if (expiresAt.getTime() > nowMs + policy.renewWindowMs) return null;
  // A window >= ttl (deliberate sliding-forever config) must still never
  // SHORTEN a session — only write when the extension is real.
  const next = nowMs + policy.ttlMs;
  return next > expiresAt.getTime() ? new Date(next) : null;
}

async function loadStoreConfig(tx: Tx, storeId: string): Promise<unknown> {
  const [row] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
  return row?.config ?? null;
}

/** Create a customer session, return the raw token (only the hash is stored).
 *  `policy` is optional — callers holding the resolved StoreCtx pass
 *  sessionPolicy(st.config); everyone else gets the store row's config loaded
 *  in the same tx (RLS-scoped). */
export async function createSession(tx: Tx, storeId: string, customerId: string, policy?: SessionPolicy): Promise<string> {
  const p = policy ?? sessionPolicy(await loadStoreConfig(tx, storeId));
  const token = randomBytes(32).toString('hex');
  await tx.insert(s.session).values({
    storeId,
    customerId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + p.ttlMs),
  });
  return token;
}

export interface SessionCustomer {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  emailVerified: boolean;
  activeVerifications: string[];
  // WP5: a migrated-from-Vendure customer has no password hash (imported with
  // `password_hash: null` by design). isMigrated = true → the storefront should
  // nudge them to set one via the forgot-password flow. The flag is computed
  // from password_hash so a freshly-registered customer who later clears their
  // password (v2 admin action) would also show as migrated — the only path
  // that clears it is the explicit admin reset, which is also a "set a new
  // password" moment, so the flag remains semantically correct.
  passwordHash: string | null;
  isMigrated: boolean;
}

/**
 * Resolve a session token to its customer. When the session's store policy is
 * renewable and the expiry is inside the renew window, the new expiry is
 * PERSISTED in the same tx (authoritative server-side — the token hash is
 * untouched, so revocation via deleteSession still works). `forceRenew`
 * extends regardless of the window (used by /auth/me so an explicit account
 * refresh is authoritative) but still requires the policy to be renewable.
 * The store join carries no extra query — config rides along in the select.
 */
export async function resolveCustomer(
  tx: Tx,
  token: string,
  forceRenew = false,
): Promise<SessionCustomer | null> {
  const rows = await tx
    .select({
      id: s.customer.id,
      email: s.customer.email,
      firstName: s.customer.firstName,
      lastName: s.customer.lastName,
      phone: s.customer.phone,
      emailVerified: s.customer.emailVerified,
      activeVerifications: s.customer.activeVerifications,
      passwordHash: s.customer.passwordHash,
      sessionId: s.session.id,
      sessionExpiresAt: s.session.expiresAt,
      storeConfig: s.store.config,
    })
    .from(s.session)
    .innerJoin(s.customer, eq(s.customer.id, s.session.customerId))
    .leftJoin(s.store, eq(s.store.id, s.session.storeId))
    .where(and(eq(s.session.tokenHash, hashToken(token)), gt(s.session.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const policy = sessionPolicy(row.storeConfig);
  let renewedExpiry = renewedSessionExpiry(row.sessionExpiresAt, Date.now(), policy);
  if (!renewedExpiry && forceRenew && policy.renewable) {
    // Outside the window but explicitly asked to renew (/auth/me). Same rule:
    // only ever extend — a later expiry (e.g. ttl was lowered) stands.
    const next = Date.now() + policy.ttlMs;
    if (next > row.sessionExpiresAt.getTime()) renewedExpiry = new Date(next);
  }
  if (renewedExpiry) {
    await tx
      .update(s.session)
      .set({ expiresAt: renewedExpiry })
      .where(eq(s.session.id, row.sessionId));
  }
  const { sessionId: _sessionId, sessionExpiresAt: _sessionExpiresAt, storeConfig: _storeConfig, ...customer } = row;
  return { ...customer, activeVerifications: customer.activeVerifications ?? [], isMigrated: customer.passwordHash == null };
}

export async function deleteSession(tx: Tx, token: string): Promise<void> {
  await tx.delete(s.session).where(eq(s.session.tokenHash, hashToken(token)));
}

/** Extract a bearer token from the Authorization header. */
export function bearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1]! : null;
}

/**
 * Resolve the customer session token from EITHER the Authorization bearer
 * header (API clients) OR the httpOnly `sr_cust` cookie (browsers). Additive —
 * bearer keeps working; cookies are the XSS-safe path for the storefront.
 */
export function customerToken(c: { req: { header: (k: string) => string | undefined } }): string | null {
  return bearer(c.req.header('authorization')) ?? cookie(c, CUST_COOKIE) ?? null;
}
