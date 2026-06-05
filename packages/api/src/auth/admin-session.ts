import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import * as s from '../db/schema.js';

const ADMIN_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export interface AdminStoreAccess {
  storeId: string;
  slug: string;
  name: string;
  currency: string;
  taxRate: number;
  role: 'owner' | 'manager' | 'staff' | 'read_only';
}

export interface AdminPrincipal {
  id: string;
  email: string;
  stores: AdminStoreAccess[];
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
      storeId: s.store.id,
      slug: s.store.slug,
      name: s.store.name,
      currency: s.store.currency,
      taxRate: s.store.taxRate,
      role: s.adminUserStore.role,
    })
    .from(s.session)
    .innerJoin(s.adminUser, eq(s.adminUser.id, s.session.adminUserId))
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
      role: r.role as AdminStoreAccess['role'],
    }));
  return { id: first.id, email: first.email, stores };
}

/** Find an admin user by email — global registry lookup on the default db client. */
export async function findAdminByEmail(email: string) {
  const [u] = await db
    .select({ id: s.adminUser.id, email: s.adminUser.email, passwordHash: s.adminUser.passwordHash })
    .from(s.adminUser)
    .where(eq(s.adminUser.email, email))
    .limit(1);
  return u ?? null;
}
