import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { withStore } from '../db/client.js';
import { listAgentSeats } from '../auth/admin-api-token.js';
import { AgentNotFound, AgentTokenInvalid, bootstrapAgentSession, createAgentSeat, removeAgentSeat, rotateAgentSeat } from '../auth/agent-lifecycle.js';
import { newCsrf, setAuthCookies } from '../auth/cookies.js';
import { attemptRetryAfter, clientIp } from '../auth/rate-limit.js';
import { HttpError, J, errBody, guard, requireAdmin, requireManage, requireStore } from './admin-helpers.js';

export const adminAgents = new OpenAPIHono();
const AgentRoleIn = z.enum(['staff', 'manager', 'read_only']);
const AgentOut = z.object({ id: z.string(), adminUserId: z.string(), name: z.string(), email: z.string(), role: z.string(), createdBy: z.string().nullable(), createdAt: z.string(), lastUsedAt: z.string().nullable(), expiresAt: z.string().nullable() });
const mapErr = (e: unknown): never => { if (e instanceof AgentNotFound) throw new HttpError(404, e.message); if (e instanceof AgentTokenInvalid) throw new HttpError(401, e.message); throw e; };

adminAgents.openapi(
  createRoute({ method: 'get', path: '/v1/admin/agents', summary: 'List agent seats for this store',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(AgentOut) })) }, 401: { description: 'Unauthorized', ...errBody } } }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c); const st = requireStore(admin, c); requireManage(st);
    const rows = await withStore(st.storeId, (tx) => listAgentSeats(tx, st.storeId));
    return c.json({ items: rows.map((r) => ({ id: r.tokenId, adminUserId: r.adminUserId, name: r.name, email: r.email, role: r.role, createdBy: r.createdBy, createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null, expiresAt: r.expiresAt?.toISOString() ?? null })) }, 200);
  }),
);
adminAgents.openapi(
  createRoute({ method: 'post', path: '/v1/admin/agents', summary: 'Create an agent seat with a role; returns its API token exactly once',
    request: { body: { content: J(z.object({ name: z.string().trim().min(1).max(80), role: AgentRoleIn.default('staff'), expiresAt: z.string().datetime({ offset: true }).optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), adminUserId: z.string(), email: z.string(), role: z.string(), token: z.string() })) }, 400: { description: 'Bad expiry', ...errBody }, 401: { description: 'Unauthorized', ...errBody } } }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c); const st = requireStore(admin, c); requireManage(st);
    const { name, role, expiresAt } = c.req.valid('json');
    const exp = expiresAt ? new Date(expiresAt) : null;
    if (exp && exp.getTime() <= Date.now()) throw new HttpError(400, 'expiresAt must be in the future');
    const r = await createAgentSeat({ storeId: st.storeId, storeSlug: st.slug, name, role, actor: admin.email, expiresAt: exp });
    return c.json({ id: r.tokenId, adminUserId: r.adminUserId, email: r.email, role, token: r.token }, 200);
  }),
);
adminAgents.openapi(
  createRoute({ method: 'post', path: '/v1/admin/agents/{adminUserId}/rotate', summary: 'Revoke live tokens (and their sessions) and issue a new token; expiry preserved',
    request: { params: z.object({ adminUserId: z.string().uuid() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), token: z.string(), revoked: z.number().int() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } } }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c); const st = requireStore(admin, c); requireManage(st);
    const r = await rotateAgentSeat({ storeId: st.storeId, adminUserId: c.req.valid('param').adminUserId, actor: admin.email }).catch(mapErr);
    return c.json({ id: r.tokenId, token: r.token, revoked: r.revoked }, 200);
  }),
);
adminAgents.openapi(
  createRoute({ method: 'delete', path: '/v1/admin/agents/{adminUserId}', summary: 'Remove an agent seat: revoke tokens, drop sessions and the store grant',
    request: { params: z.object({ adminUserId: z.string().uuid() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean(), revoked: z.number().int() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } } }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c); const st = requireStore(admin, c); requireManage(st);
    const r = await removeAgentSeat({ storeId: st.storeId, adminUserId: c.req.valid('param').adminUserId, actor: admin.email }).catch(mapErr);
    return c.json({ ok: true, revoked: r.revoked }, 200);
  }),
);
adminAgents.openapi(
  createRoute({ method: 'post', path: '/v1/admin/agents/browser-session', summary: 'Exchange an agent API token (bearer) for a cookie session bound to that token (≤12 h; one live session per token)',
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean(), csrfToken: z.string(), expiresInSeconds: z.number().int() })) }, 401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Not an agent token', ...errBody }, 429: { description: 'Too many attempts', ...errBody } } }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    if (admin.auth !== 'api_token' || !admin.apiTokenId) throw new HttpError(403, 'browser-session requires an agent API token bearer');
    const retry = await attemptRetryAfter(clientIp(c), `agent-session:${admin.apiTokenId}`);
    if (retry > 0) throw new HttpError(429, `too many attempts — try again in ${retry}s`);
    const st = admin.stores[0]!;
    const r = await bootstrapAgentSession({ storeId: st.storeId, adminUserId: admin.id, apiTokenId: admin.apiTokenId, actor: admin.email }).catch(mapErr);
    const csrf = newCsrf();
    setAuthCookies(c, r.sessionToken, csrf);
    return c.json({ ok: true, csrfToken: csrf, expiresInSeconds: Math.floor(r.ttlMs / 1000) }, 200);
  }),
);
