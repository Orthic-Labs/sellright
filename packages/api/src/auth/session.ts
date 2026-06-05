import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** Create a customer session, return the raw token (only the hash is stored). */
export async function createSession(tx: Tx, storeId: string, customerId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await tx.insert(s.session).values({
    storeId,
    customerId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

export interface SessionCustomer {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  emailVerified: boolean;
}

export async function resolveCustomer(tx: Tx, token: string): Promise<SessionCustomer | null> {
  const rows = await tx
    .select({
      id: s.customer.id,
      email: s.customer.email,
      firstName: s.customer.firstName,
      lastName: s.customer.lastName,
      emailVerified: s.customer.emailVerified,
    })
    .from(s.session)
    .innerJoin(s.customer, eq(s.customer.id, s.session.customerId))
    .where(and(eq(s.session.tokenHash, hashToken(token)), gt(s.session.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
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
