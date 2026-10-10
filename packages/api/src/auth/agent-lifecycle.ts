import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { AGENT_ROLES, mintAgentToken, revokeAgentTokens } from './admin-api-token.js';
import { createAdminSessionTx, type AdminStoreAccess } from './admin-session.js';

export const AGENT_BROWSER_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // D3
export type AgentRole = 'staff' | 'manager' | 'read_only';
export class AgentNotFound extends Error { constructor() { super('agent not found in this store'); } }
export class AgentTokenInvalid extends Error { constructor() { super('agent token revoked or expired'); } }
export function agentEmail(storeSlug: string): string { return `${storeSlug}-agent-${randomBytes(4).toString('hex')}@agents.invalid`; }

/** FOR UPDATE on the grant row serializes rotate / remove / bootstrap for one agent. Identity is the user's kind, not its role. */
async function lockAgentGrant(tx: Tx, adminUserId: string, storeId: string): Promise<{ name: string | null }> {
  const [m] = await tx.select({ kind: s.adminUser.kind, name: s.adminUser.name }).from(s.adminUserStore)
    .innerJoin(s.adminUser, eq(s.adminUser.id, s.adminUserStore.adminUserId))
    .where(and(eq(s.adminUserStore.adminUserId, adminUserId), eq(s.adminUserStore.storeId, storeId))).for('update', { of: s.adminUserStore }).limit(1);
  if (!m || m.kind !== 'agent') throw new AgentNotFound();
  return { name: m.name };
}

export async function createAgentSeat(i: { storeId: string; storeSlug: string; name: string; role: AgentRole; actor: string; expiresAt: Date | null }) {
  if (!AGENT_ROLES.has(i.role as AdminStoreAccess['role'])) throw new Error('agents cannot be owners');
  return withStore(i.storeId, async (tx) => {
    const email = agentEmail(i.storeSlug);
    const [u] = await tx.insert(s.adminUser).values({ email, passwordHash: null, name: `Agent: ${i.name}`, kind: 'agent' }).returning({ id: s.adminUser.id });
    const adminUserId = u!.id;
    await tx.insert(s.adminUserStore).values({ adminUserId, storeId: i.storeId, role: i.role });
    const minted = await mintAgentToken(tx, { adminUserId, storeId: i.storeId, name: i.name, createdBy: i.actor, expiresAt: i.expiresAt });
    await tx.insert(s.auditLog).values({ storeId: i.storeId, actor: i.actor, entity: 'agent', entityId: adminUserId, action: 'create', data: { name: i.name, email, role: i.role, tokenId: minted.id } });
    return { adminUserId, email, tokenId: minted.id, token: minted.token };
  });
}

export async function rotateAgentSeat(i: { storeId: string; adminUserId: string; actor: string }) {
  return withStore(i.storeId, async (tx) => {
    const g = await lockAgentGrant(tx, i.adminUserId, i.storeId);
    const r = await revokeAgentTokens(tx, i.adminUserId, i.storeId);
    const minted = await mintAgentToken(tx, { adminUserId: i.adminUserId, storeId: i.storeId, name: (g.name ?? 'Agent').replace(/^Agent: /, ''), createdBy: i.actor, expiresAt: r.expiresAt });
    await tx.insert(s.auditLog).values({ storeId: i.storeId, actor: i.actor, entity: 'agent', entityId: i.adminUserId, action: 'rotate', data: { revoked: r.revoked, tokenId: minted.id } });
    return { tokenId: minted.id, token: minted.token, revoked: r.revoked };
  });
}

export async function removeAgentSeat(i: { storeId: string; adminUserId: string; actor: string }) {
  return withStore(i.storeId, async (tx) => {
    await lockAgentGrant(tx, i.adminUserId, i.storeId);
    const r = await revokeAgentTokens(tx, i.adminUserId, i.storeId);
    await tx.delete(s.session).where(eq(s.session.adminUserId, i.adminUserId));
    await tx.delete(s.adminUserStore).where(and(eq(s.adminUserStore.adminUserId, i.adminUserId), eq(s.adminUserStore.storeId, i.storeId)));
    await tx.insert(s.auditLog).values({ storeId: i.storeId, actor: i.actor, entity: 'agent', entityId: i.adminUserId, action: 'remove', data: { revoked: r.revoked } });
    return { revoked: r.revoked }; // admin_user row stays (kind 'agent', no grants) so audit actors resolve
  });
}

/** Atomic token→cookie bootstrap: lock the grant, re-check the token's owner/store/liveness, replace the single live session. */
export async function bootstrapAgentSession(i: { storeId: string; adminUserId: string; apiTokenId: string; actor: string }): Promise<{ sessionToken: string; ttlMs: number }> {
  return withStore(i.storeId, async (tx) => {
    try { await lockAgentGrant(tx, i.adminUserId, i.storeId); } catch (e) { if (e instanceof AgentNotFound) throw new AgentTokenInvalid(); throw e; } // seat removed while this request was in flight: the token is dead (401), not a missing resource
    const [t] = await tx.select({ revokedAt: s.adminApiToken.revokedAt, expiresAt: s.adminApiToken.expiresAt }).from(s.adminApiToken)
      .where(and(eq(s.adminApiToken.id, i.apiTokenId), eq(s.adminApiToken.adminUserId, i.adminUserId), eq(s.adminApiToken.storeId, i.storeId))).for('update').limit(1);
    if (!t || t.revokedAt) throw new AgentTokenInvalid();
    const ttlMs = Math.min(AGENT_BROWSER_SESSION_TTL_MS, t.expiresAt ? t.expiresAt.getTime() - Date.now() : AGENT_BROWSER_SESSION_TTL_MS);
    if (ttlMs <= 0) throw new AgentTokenInvalid();
    await tx.delete(s.session).where(eq(s.session.apiTokenId, i.apiTokenId)); // plus the unique partial index
    const sessionToken = await createAdminSessionTx(tx, i.adminUserId, ttlMs, i.apiTokenId);
    await tx.insert(s.auditLog).values({ storeId: i.storeId, actor: i.actor, entity: 'agent', entityId: i.adminUserId, action: 'browser_session', data: { ttlMs } });
    return { sessionToken, ttlMs };
  });
}
