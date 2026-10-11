import type { MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import { bearer } from '../auth/session.js';
import { cookie, SESSION_COOKIE } from '../auth/cookies.js';
import { resolveAdmin, type AdminPrincipal } from '../auth/admin-session.js';
import { isAgentToken, resolveAgentByToken } from '../auth/admin-api-token.js';
import { agentDenied } from '../auth/agent-policy.js';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { errJson } from '../lib/api-error.js';
import { eq } from 'drizzle-orm';

declare module 'hono' { interface ContextVariableMap { adminPrincipal: AdminPrincipal } }

const PUBLIC = new Set(['/v1/admin/login', '/v1/admin/logout']); // NOT staff/accept: it is public for the unauthenticated invitee, but an agent credential on it must still hit the deny set (Astra v5 F4)
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MESSAGE: Record<string, string> = {
  delete: 'agents cannot delete — disable or trash instead; deletion needs a human',
  irreversible_order: 'agents cannot cancel or purge orders — trash is reversible, this is not',
  money_out: 'agents cannot move money out of the store',
  settlement: 'agents cannot re-drive settlement or reconciliation',
  credit: 'agents cannot issue or adjust customer credit — a human does that',
  entitlement: 'agents cannot issue, revoke or release entitlements',
  release: 'agents cannot publish releases',
  identity: 'agents cannot manage staff or agents',
  credentials: 'agents cannot change credentials or payment/e-mail secrets',
  system: 'agents cannot run system operations',
};

/**
 * Resolves the admin principal once per /v1/admin request (reused by requireAdmin) and applies the
 * agent deny set (auth/agent-policy.ts). Route identity = the last matched route whose path has no '*'
 * (OpenAPI routes never use wildcards; middleware does). The request body is never read here.
 * Denials are audited in their own transaction before any handler runs. For allowed MUTATIONS an
 * attribution row (action 'request') is written durably BEFORE the handler runs — so every agent mutation
 * attempt is attributed even if the handler has no entity audit of its own — and its status is filled in
 * afterwards on a best-effort basis (entity-level audit rows remain the handlers' job).
 */
export const adminAgentGuard: MiddlewareHandler = async (c, next) => {
  const path = c.req.path;
  if (PUBLIC.has(path)) return next();
  const token = bearer(c.req.header('authorization')) ?? cookie(c, SESSION_COOKIE);
  if (!token) return next();
  const admin = isAgentToken(token) ? await resolveAgentByToken(token) : await resolveAdmin(token);
  if (!admin) return next();
  c.set('adminPrincipal', admin);
  if (admin.kind !== 'agent') return next();
  const method = c.req.method.toUpperCase();
  const route = [...matchedRoutes(c)].reverse().find((r) => !r.path.includes('*'))?.path ?? path;
  const st = admin.stores[0]!;
  const group = agentDenied(method, route);
  if (group) {
    await withStore(st.storeId, (tx) => tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'agent', entityId: admin.id, action: 'denied', data: { method, path, route, group } }));
    return errJson(c, 403, 'AGENT_NOT_ALLOWED', MESSAGE[group]!);
  }
  let requestRowId: string | null = null;
  if (MUTATING.has(method)) {
    const [row] = await withStore(st.storeId, (tx) => tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'agent', entityId: admin.id, action: 'request', data: { method, path, route } }).returning({ id: s.auditLog.id }));
    requestRowId = row!.id;
  }
  await next();
  if (requestRowId) {
    try { await withStore(st.storeId, (tx) => tx.update(s.auditLog).set({ data: { method, path, route, status: c.res.status } }).where(eq(s.auditLog.id, requestRowId!))); } catch { /* status fill-in is best-effort; the attribution row already exists */ }
  }
};
