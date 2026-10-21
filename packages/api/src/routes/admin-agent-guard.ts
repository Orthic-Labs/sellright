import type { MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import { bearer } from '../auth/session.js';
import { cookie, SESSION_COOKIE } from '../auth/cookies.js';
import { resolveAdmin, type AdminPrincipal } from '../auth/admin-session.js';
import { isAgentToken, resolveAgentByToken } from '../auth/admin-api-token.js';
import { agentDenied, type AgentRouteContext } from '../auth/agent-policy.js';
import { ENROLLMENT_ALLOWED } from '../auth/mfa-policy.js';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { errJson } from '../lib/api-error.js';
import { eq } from 'drizzle-orm';

declare module 'hono' { interface ContextVariableMap { adminPrincipal: AdminPrincipal } }

const PUBLIC = new Set(['/v1/admin/login', '/v1/admin/logout',
  // Passkeys (0108): pre-session routes treated exactly like /v1/admin/login — no principal is resolved, the ceremony decides.
  '/v1/admin/capabilities', '/v1/admin/passkeys/login/options', '/v1/admin/passkeys/login/verify']); // NOT staff/accept: it is public for the unauthenticated invitee, but an agent credential on it must still hit the deny set (Astra v5 F4)
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Engine admin routes that accept a non-session credential (or none) and authenticate it themselves. */
const SERVICE_CREDENTIAL_ROUTES = new Set(['POST /v1/admin/staff/accept', 'POST /v1/admin/cache/purge', 'POST /v1/admin/apps/releases']);
const MESSAGE: Record<string, string> = {
  delete: 'agents cannot delete — disable or trash instead; deletion needs a human',
  irreversible_order: 'agents cannot cancel or purge orders — trash is reversible, this is not',
  money_out: 'agents cannot move money out of the store',
  settlement: 'agents cannot re-drive settlement or reconciliation',
  credit: 'agents cannot issue or adjust customer credit — a human does that',
  entitlement: 'agents cannot issue, revoke or release entitlements',
  release: 'agents cannot publish releases',
  plugin: 'agents cannot call this plugin action — the plugin has not allowlisted it for agents',
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
export const adminAgentGuard: MiddlewareHandler = createAdminAgentGuard(() => undefined);

/** Guard bound to one app's route context (built-in route snapshot + plugin agent policies, see agent-policy.ts).
 *  The getter is read per request, so the app can fill the context after its plugins are mounted. */
export function createAdminAgentGuard(routeContext: () => AgentRouteContext | undefined): MiddlewareHandler {
  return (c, next) => guardImpl(c, next, routeContext());
}

const guardImpl = async (c: Parameters<MiddlewareHandler>[0], next: Parameters<MiddlewareHandler>[1], routeCtx: AgentRouteContext | undefined) => {
  const path = c.req.path;
  if (PUBLIC.has(path)) return next();
  const token = bearer(c.req.header('authorization')) ?? cookie(c, SESSION_COOKIE);
  if (!token) return next();
  const admin = isAgentToken(token) ? await resolveAgentByToken(token) : await resolveAdmin(token);
  if (!admin) {
    // P2 review: a credential that does not resolve is refused on engine-owned admin routes BEFORE validation (no
    // schema hints for a fabricated bearer). Exempt: pre-session routes and routes with their own service credential
    // (cache purge's shared token, the release-registration service token); plugin routes authenticate themselves.
    const concrete = [...matchedRoutes(c)].reverse().find((r) => !r.path.includes('*') && r.method !== 'ALL');
    const key = concrete ? `${c.req.method.toUpperCase()} ${concrete.path}` : null;
    if (key && routeCtx?.builtin.has(key) && !SERVICE_CREDENTIAL_ROUTES.has(key)) {
      return errJson(c, 401, 'NOT_AUTHENTICATED', 'invalid or expired session');
    }
    return next();
  }
  c.set('adminPrincipal', admin);
  const method = c.req.method.toUpperCase();
  const route = [...matchedRoutes(c)].reverse().find((r) => !r.path.includes('*'))?.path ?? path;
  if (admin.kind !== 'agent') {
    // P1b: TOTP is required for this admin but not enrolled — the session may only enrol (auth/mfa-policy.ts).
    if (admin.totpRequired && !admin.totpEnabled && !ENROLLMENT_ALLOWED.has(`${method} ${route}`)) {
      return errJson(c, 403, 'TOTP_ENROLLMENT_REQUIRED', 'two-factor authentication is required for your account — set up an authenticator app to continue');
    }
    return next();
  }
  const st = admin.stores[0]!;
  // Every concrete route that matched (not only the last): an engine deny on ANY of them wins, so a plugin cannot
  // shadow an engine-denied route with an allowlisted twin (e.g. a renamed path parameter) — P1c review.
  const candidates = [...new Set([...matchedRoutes(c)].filter((r) => !r.path.includes('*') && r.method !== 'ALL').map((r) => r.path))];
  let group: ReturnType<typeof agentDenied> = null;
  for (const r of candidates.length ? candidates : [route]) {
    group = agentDenied(method, r, routeCtx, path);
    if (group) break;
  }
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
