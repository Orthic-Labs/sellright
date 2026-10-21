import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { unsafeUnscopedDb as db, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import type { AdminPrincipal, AdminStoreAccess } from './admin-session.js';

export const AGENT_TOKEN_PREFIX = 'sra_';
export const AGENT_ROLES = new Set<AdminStoreAccess['role']>(['staff', 'manager', 'read_only']); // never owner (D2)
export function newAgentToken(): string { return AGENT_TOKEN_PREFIX + randomBytes(32).toString('base64url'); }
export function isAgentToken(t: string | undefined | null): t is string { return typeof t === 'string' && t.startsWith(AGENT_TOKEN_PREFIX); }
export function hashAgentToken(t: string): string { return createHash('sha256').update(t).digest('hex'); }

export async function mintAgentToken(tx: Tx, i: { adminUserId: string; storeId: string; name: string; createdBy: string | null; expiresAt: Date | null }): Promise<{ id: string; token: string }> {
  const token = newAgentToken();
  const [row] = await tx.insert(s.adminApiToken).values({ ...i, tokenHash: hashAgentToken(token) }).returning({ id: s.adminApiToken.id });
  return { id: row!.id, token };
}

/** Revoke every live token of one agent in one store; bound sessions are deleted in the same tx. */
export async function revokeAgentTokens(tx: Tx, adminUserId: string, storeId: string): Promise<{ revoked: number; expiresAt: Date | null }> {
  const rows = await tx.update(s.adminApiToken).set({ revokedAt: new Date() })
    .where(and(eq(s.adminApiToken.adminUserId, adminUserId), eq(s.adminApiToken.storeId, storeId), isNull(s.adminApiToken.revokedAt)))
    .returning({ id: s.adminApiToken.id, expiresAt: s.adminApiToken.expiresAt });
  for (const r of rows) await tx.delete(s.session).where(eq(s.session.apiTokenId, r.id));
  return { revoked: rows.length, expiresAt: rows[0]?.expiresAt ?? null };
}

export interface AgentSeat { tokenId: string; adminUserId: string; name: string; email: string; role: string; createdBy: string | null; lastUsedAt: Date | null; expiresAt: Date | null; createdAt: Date }
export async function listAgentSeats(tx: Tx, storeId: string): Promise<AgentSeat[]> {
  return tx.select({ tokenId: s.adminApiToken.id, adminUserId: s.adminApiToken.adminUserId, name: s.adminApiToken.name, email: s.adminUser.email, role: s.adminUserStore.role, createdBy: s.adminApiToken.createdBy, lastUsedAt: s.adminApiToken.lastUsedAt, expiresAt: s.adminApiToken.expiresAt, createdAt: s.adminApiToken.createdAt })
    .from(s.adminApiToken).innerJoin(s.adminUser, eq(s.adminUser.id, s.adminApiToken.adminUserId))
    .innerJoin(s.adminUserStore, and(eq(s.adminUserStore.adminUserId, s.adminApiToken.adminUserId), eq(s.adminUserStore.storeId, s.adminApiToken.storeId)))
    .where(and(eq(s.adminApiToken.storeId, storeId), isNull(s.adminApiToken.revokedAt)));
}

/** Registry read. Unknown / revoked / expired / not an agent / owner grant → null. The agent's REAL role and grants are returned. */
export async function resolveAgentByToken(token: string): Promise<AdminPrincipal | null> {
  const [r] = await db.select({
      tokenId: s.adminApiToken.id, expiresAt: s.adminApiToken.expiresAt, id: s.adminUser.id, email: s.adminUser.email, kind: s.adminUser.kind,
      storeId: s.store.id, slug: s.store.slug, name: s.store.name, currency: s.store.currency, taxRate: s.store.taxRate, shippingTaxable: s.store.shippingTaxable,
      role: s.adminUserStore.role, permissions: s.adminUserStore.permissions,
    }).from(s.adminApiToken)
    .innerJoin(s.adminUser, eq(s.adminUser.id, s.adminApiToken.adminUserId))
    .innerJoin(s.adminUserStore, and(eq(s.adminUserStore.adminUserId, s.adminApiToken.adminUserId), eq(s.adminUserStore.storeId, s.adminApiToken.storeId)))
    .innerJoin(s.store, eq(s.store.id, s.adminApiToken.storeId))
    .where(and(eq(s.adminApiToken.tokenHash, hashAgentToken(token)), isNull(s.adminApiToken.revokedAt))).limit(1);
  if (!r || (r.expiresAt && r.expiresAt.getTime() <= Date.now()) || r.kind !== 'agent' || !AGENT_ROLES.has(r.role)) return null;
  await db.update(s.adminApiToken).set({ lastUsedAt: new Date() })
    .where(and(eq(s.adminApiToken.id, r.tokenId), or(isNull(s.adminApiToken.lastUsedAt), lt(s.adminApiToken.lastUsedAt, sql`now() - interval '5 minutes'`))));
  return { id: r.id, email: r.email, kind: 'agent', auth: 'api_token', apiTokenId: r.tokenId, isInstallationAdmin: false, stepUpAt: null, stepUpEpoch: null, securityEpoch: 0,
    stores: [{ storeId: r.storeId, slug: r.slug, name: r.name, currency: r.currency, taxRate: r.taxRate ?? 0, shippingTaxable: r.shippingTaxable ?? false, role: r.role, permissions: (r.permissions as Record<string, boolean> | null) ?? null }] };
}
