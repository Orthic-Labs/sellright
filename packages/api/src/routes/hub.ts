// #355 phase 2: the hub's HTTP surface (auth/hub.ts has the contract). Off (404 FEATURE_DISABLED) unless HUB_ORIGIN,
// HUB_TARGETS and HUB_VAULT_KEYS are all set. Mutations need the hub CSRF header and an Origin equal to HUB_ORIGIN.
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { cookie, newCsrf, shouldSetSecureCookie } from '../auth/cookies.js';
import {
  HUB_COOKIE, HUB_CSRF_COOKIE, HUB_CSRF_HEADER, HUB_RETURN_PATH, HUB_SESSION_TTL_MS, PROXY_METHODS,
  completeEnrolment, createHubSession, endHubSession, hubConfig, hubCsrfValid, listSlots, proxyPathAllowed, proxyToTarget,
  removeSlot, resolveHubSession, startEnrolment, type HubConfig,
} from '../auth/hub.js';
import { clientIp, reserveHubSessionCreate } from '../auth/rate-limit.js';
import { log } from '../lib/logger.js';
import { HttpError, J, errBody, guard } from './admin-helpers.js';

export const hub = new OpenAPIHono();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function config(): HubConfig {
  const cfg = hubConfig();
  if (!cfg) throw new HttpError(404, 'the account hub is not enabled on this server', 'FEATURE_DISABLED');
  return cfg;
}

function requireOrigin(c: Context, cfg: HubConfig): void {
  if (c.req.header('origin') !== cfg.origin) throw new HttpError(403, 'cross-origin request refused', 'HUB_ORIGIN_REFUSED');
}

async function requireSession(c: Context): Promise<{ id: string }> {
  const sess = await resolveHubSession(cookie(c, HUB_COOKIE));
  if (!sess) throw new HttpError(401, 'no hub session', 'HUB_NO_SESSION');
  return sess;
}

/** A state-changing call: same origin, live hub session, double-submit CSRF. */
async function mutation(c: Context, cfg: HubConfig): Promise<{ id: string }> {
  requireOrigin(c, cfg);
  const sess = await requireSession(c);
  if (!hubCsrfValid(c.req.header(HUB_CSRF_HEADER), cookie(c, HUB_CSRF_COOKIE))) throw new HttpError(403, 'missing or invalid CSRF token', 'CSRF_INVALID');
  return sess;
}

function setHubCookie(c: Context, name: string, value: string, maxAgeSeconds: number): void {
  const secure = shouldSetSecureCookie({ get: (k) => c.req.header(k) }, process.env.NODE_ENV ?? 'development') ? '; Secure' : '';
  c.header('Set-Cookie', `${name}=${value}; HttpOnly; Path=/v1/hub; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`, { append: true });
}

const noStore = (c: Context) => c.header('Cache-Control', 'no-store');
const targetsOf = (cfg: HubConfig) => cfg.targets.map((t) => ({ id: t.id, label: t.label }));
const Target = z.object({ id: z.string(), label: z.string() });
const Account = z.object({ id: z.string(), targetId: z.string(), targetLabel: z.string(), adminEmail: z.string(), expiresAt: z.string(), lastUsedAt: z.string().nullable() });

hub.openapi(
  createRoute({
    method: 'post', path: '/v1/hub/session',
    summary: 'Saved accounts (#355): start or resume this browser\'s hub session; returns the CSRF token for hub mutations',
    responses: {
      200: { description: 'Hub session ready', content: J(z.object({ csrf: z.string(), targets: z.array(Target) })) },
      403: { description: 'Cross-origin request', ...errBody },
      404: { description: 'Hub not enabled', ...errBody },
      429: { description: 'Too many new sessions from this address', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const cfg = config();
    requireOrigin(c, cfg);
    noStore(c);
    const live = await resolveHubSession(cookie(c, HUB_COOKIE));
    let csrf = cookie(c, HUB_CSRF_COOKIE);
    if (!live) {
      const retry = await reserveHubSessionCreate(clientIp(c));
      if (retry > 0) { c.header('Retry-After', String(retry)); throw new HttpError(429, `too many attempts — try again in ${retry}s`, 'RATE_LIMITED'); }
      const created = await createHubSession();
      setHubCookie(c, HUB_COOKIE, created.token, HUB_SESSION_TTL_MS / 1000);
      csrf = undefined;
    }
    if (!csrf || !/^[0-9a-f]{32}$/.test(csrf)) { csrf = newCsrf(); setHubCookie(c, HUB_CSRF_COOKIE, csrf, HUB_SESSION_TTL_MS / 1000); }
    return c.json({ csrf, targets: targetsOf(cfg) }, 200);
  }),
);

hub.openapi(
  createRoute({
    method: 'get', path: '/v1/hub/accounts',
    summary: 'Saved accounts (#355): the configured servers and the accounts saved in this hub session',
    responses: {
      200: { description: 'Targets and saved accounts', content: J(z.object({ targets: z.array(Target), accounts: z.array(Account) })) },
      401: { description: 'No hub session', ...errBody },
      404: { description: 'Hub not enabled', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const cfg = config();
    noStore(c);
    const sess = await requireSession(c);
    return c.json({ targets: targetsOf(cfg), accounts: await listSlots(cfg, sess.id) }, 200);
  }),
);

hub.openapi(
  createRoute({
    method: 'post', path: '/v1/hub/enrol',
    summary: 'Saved accounts (#355): begin adding an account on a configured server; navigate to redirectTo to sign in there',
    request: { body: { content: J(z.object({ targetId: z.string().max(64) })) } },
    responses: {
      200: { description: 'The target\'s sign-in handoff page', content: J(z.object({ redirectTo: z.string() })) },
      400: { description: 'Unknown target', ...errBody },
      401: { description: 'No hub session', ...errBody },
      403: { description: 'Cross-origin request or CSRF', ...errBody },
      404: { description: 'Hub not enabled', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const cfg = config();
    const sess = await mutation(c, cfg);
    noStore(c);
    const redirectTo = await startEnrolment(cfg, sess.id, c.req.valid('json').targetId);
    if (!redirectTo) throw new HttpError(400, 'unknown server', 'HUB_UNKNOWN_TARGET');
    return c.json({ redirectTo }, 200);
  }),
);

hub.openapi(
  createRoute({
    method: 'get', path: '/v1/hub/callback/{targetId}',
    summary: 'Saved accounts (#355): the target sends the browser here with a one-use code; the hub redeems it and returns to the saved-accounts screen',
    request: { params: z.object({ targetId: z.string().max(64) }), query: z.object({ code: z.string().max(128).optional(), state: z.string().max(256).optional(), iss: z.string().max(512).optional() }) },
    responses: {
      302: { description: 'Back to the hub admin with enrolled=<account id> or error=<reason>' },
      404: { description: 'Hub not enabled', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const cfg = config();
    noStore(c);
    c.header('Referrer-Policy', 'no-referrer');
    const back = new URL(HUB_RETURN_PATH, cfg.origin);
    const { targetId } = c.req.valid('param');
    const sess = await resolveHubSession(cookie(c, HUB_COOKIE));
    if (!sess) { back.searchParams.set('error', 'no_session'); return c.redirect(back.href, 302); }
    const r = await completeEnrolment(cfg, sess.id, targetId, c.req.valid('query'));
    if (r.ok) { log.info('hub_account_enrolled', { targetId, slotId: r.slotId }); back.searchParams.set('enrolled', r.slotId); }
    else { log.warn('hub_enrolment_refused', { targetId, reason: r.reason }); back.searchParams.set('error', r.reason); }
    return c.redirect(back.href, 302);
  }),
);

hub.openapi(
  createRoute({
    method: 'delete', path: '/v1/hub/accounts/{slotId}',
    summary: 'Saved accounts (#355): forget one saved account and sign its session out on the target',
    request: { params: z.object({ slotId: z.string().regex(UUID) }) },
    responses: {
      200: { description: 'Removed', content: J(z.object({ ok: z.literal(true) })) },
      401: { description: 'No hub session', ...errBody },
      403: { description: 'Cross-origin request or CSRF', ...errBody },
      404: { description: 'Hub not enabled, or no such saved account', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const cfg = config();
    const sess = await mutation(c, cfg);
    noStore(c);
    if (!(await removeSlot(cfg, sess.id, c.req.valid('param').slotId))) throw new HttpError(404, 'no such saved account', 'HUB_SLOT_NOT_FOUND');
    return c.json({ ok: true as const }, 200);
  }),
);

hub.openapi(
  createRoute({
    method: 'post', path: '/v1/hub/signout',
    summary: 'Saved accounts (#355): sign out of the hub; every saved account is signed out on its server',
    responses: {
      200: { description: 'Signed out', content: J(z.object({ ok: z.literal(true) })) },
      401: { description: 'No hub session', ...errBody },
      403: { description: 'Cross-origin request or CSRF', ...errBody },
      404: { description: 'Hub not enabled', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const cfg = config();
    const sess = await mutation(c, cfg);
    noStore(c);
    await endHubSession(cfg, sess.id);
    setHubCookie(c, HUB_COOKIE, '', 0);
    setHubCookie(c, HUB_CSRF_COOKIE, '', 0);
    return c.json({ ok: true as const }, 200);
  }),
);

/** The relay: /v1/hub/accounts/<slot>/admin/<admin API path>. Not in OpenAPI (it mirrors the target's admin API). */
hub.on([...PROXY_METHODS], '/v1/hub/accounts/:slotId/admin/*', async (c) => guard(c, async () => {
  const cfg = config();
  const slotId = c.req.param('slotId');
  noStore(c);
  // The path is checked before the session is touched: a refused path changes nothing.
  const url = new URL(c.req.url);
  const prefix = `/v1/hub/accounts/${slotId}/admin/`;
  const subpath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
  if (!UUID.test(slotId ?? '') || !proxyPathAllowed(subpath)) throw new HttpError(400, 'path not allowed through the hub', 'HUB_PATH_REFUSED');
  // Reads need only the session (SameSite=Lax keeps cross-site subresource reads out; browsers omit Origin on same-origin GETs).
  const sess = c.req.method === 'GET' ? await requireSession(c) : await mutation(c, cfg);
  const r = await proxyToTarget(cfg, sess.id, slotId!, {
    method: c.req.method, subpath, search: url.search,
    contentType: c.req.header('content-type'), accept: c.req.header('accept'),
    storeSlug: c.req.header('x-store-slug'), idempotencyKey: c.req.header('idempotency-key'),
    body: c.req.method === 'GET' ? undefined : await c.req.arrayBuffer(),
  });
  if (!r.ok) {
    if (r.reason === 'not_found') throw new HttpError(404, 'no such saved account', 'HUB_SLOT_NOT_FOUND');
    if (r.reason === 'reauth') throw new HttpError(401, 'this saved account needs a new sign-in', 'HUB_SLOT_REAUTH');
    throw new HttpError(502, 'the server did not answer', 'HUB_UPSTREAM');
  }
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (r.contentType) headers.set('Content-Type', r.contentType);
  return new Response(r.status === 204 || r.status === 304 ? null : r.body, { status: r.status, headers });
}));
