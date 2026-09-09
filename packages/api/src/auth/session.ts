import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { cookie, CUST_COOKIE } from './cookies.js';

export const CUSTOMER_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
export const CUSTOMER_SESSION_RENEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function renewedSessionExpiry(expiresAt: Date, nowMs = Date.now()): Date | null {
  return expiresAt.getTime() <= nowMs + CUSTOMER_SESSION_RENEW_WINDOW_MS
    ? new Date(nowMs + CUSTOMER_SESSION_TTL_MS)
    : null;
}
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** Create a customer session, return the raw token (only the hash is stored). */
export async function createSession(tx: Tx, storeId: string, customerId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await tx.insert(s.session).values({
    storeId,
    customerId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + CUSTOMER_SESSION_TTL_MS),
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
    })
    .from(s.session)
    .innerJoin(s.customer, eq(s.customer.id, s.session.customerId))
    .where(and(eq(s.session.tokenHash, hashToken(token)), gt(s.session.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const renewedExpiry = forceRenew
    ? new Date(Date.now() + CUSTOMER_SESSION_TTL_MS)
    : renewedSessionExpiry(row.sessionExpiresAt);
  if (renewedExpiry) {
    await tx
      .update(s.session)
      .set({ expiresAt: renewedExpiry })
      .where(eq(s.session.id, row.sessionId));
  }
  const { sessionId: _sessionId, sessionExpiresAt: _sessionExpiresAt, ...customer } = row;
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
 * Resolve the customer session token from EITHER the Authorization bearer header
 * (API clients) OR the httpOnly `sr_cust` cookie (browsers). Additive — bearer
 * keeps working; cookies are the XSS-safe path for the storefront.
 */
export function customerToken(c: { req: { header: (k: string) => string | undefined } }): string | null {
  return bearer(c.req.header('authorization')) ?? cookie(c, CUST_COOKIE) ?? null;
}
