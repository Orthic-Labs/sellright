// #355 phase 1: the target side of the saved-account hub sign-in handoff (auth/admin-handoff.ts has the contract).
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { issueHandoffCode, redeemHandoffCode, type AuthorizeRefusal } from '../auth/admin-handoff.js';
import { clientIp, reserveAdminSecondStepAttempt } from '../auth/rate-limit.js';
import { log } from '../lib/logger.js';
import type { HttpStatus } from '../lib/api-error.js';
import { HttpError, J, errBody, guard, requireAdmin } from './admin-helpers.js';

export const adminHandoff = new OpenAPIHono();

const REFUSAL: Record<AuthorizeRefusal, [HttpStatus, string, string]> = {
  disabled: [404, 'FEATURE_DISABLED', 'account handoff is not enabled on this server'],
  unknown_client: [400, 'HANDOFF_UNKNOWN_CLIENT', 'unknown client or callback'],
  bad_request: [400, 'HANDOFF_BAD_REQUEST', 'state and an S256 code challenge are required'],
  not_human_session: [403, 'HANDOFF_HUMAN_ONLY', 'only a signed-in person can add this account to another admin'],
  fresh_auth_required: [403, 'STEP_UP_REQUIRED', 'sign in again to add this account to another admin'],
};

adminHandoff.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/handoff/authorize',
    summary: 'Saved accounts (#355): issue a one-use, 60-second code for a registered hub client. Needs a human session signed in or stepped up in the last 10 minutes',
    request: { body: { content: J(z.object({
      clientId: z.string().max(64), redirectUri: z.string().max(512), state: z.string().max(256),
      codeChallenge: z.string().max(64), codeChallengeMethod: z.literal('S256'),
    })) } },
    responses: {
      200: { description: 'Navigate to redirectTo (the registered callback with code, state and iss)', content: J(z.object({ redirectTo: z.string() })) },
      400: { description: 'Unknown client/callback or malformed request', ...errBody },
      401: { description: 'Not signed in', ...errBody },
      403: { description: 'Agent, API token, stale sign-in, or CSRF', ...errBody },
      404: { description: 'Handoff not enabled', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const r = await issueHandoffCode(admin, c.req.valid('json'));
    if (!r.ok) { const [st, code, msg] = REFUSAL[r.reason]; throw new HttpError(st, msg, code); }
    log.info('admin_handoff_code_issued', { adminUserId: admin.id, clientId: c.req.valid('json').clientId });
    return c.json({ redirectTo: r.redirectTo }, 200);
  }),
);

adminHandoff.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/handoff/token',
    summary: 'Saved accounts (#355): the hub redeems a handoff code once, server to server, for a new admin session (bearer)',
    request: { body: { content: J(z.object({
      grantType: z.literal('authorization_code'), clientId: z.string().max(64), clientSecret: z.string().max(256),
      redirectUri: z.string().max(512), code: z.string().max(128), codeVerifier: z.string().max(128),
    })) } },
    responses: {
      200: { description: 'A new admin session for the hub', content: J(z.object({ token: z.string(), tokenType: z.literal('Bearer'), expiresInSeconds: z.number().int(), admin: z.object({ id: z.string(), email: z.string() }), issuer: z.string() })) },
      400: { description: 'invalid_grant: unknown, used, expired or mismatched code, wrong verifier, or the issuing sign-in ended', ...errBody },
      401: { description: 'invalid_client', ...errBody },
      404: { description: 'Handoff not enabled', ...errBody },
      429: { description: 'Too many attempts', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const body = c.req.valid('json');
    // Per-IP budget only: the client id is public, so a per-client bucket would let anyone lock the hub out. The
    // secret and the code are 256-bit; the budget only bounds noise.
    const retry = await reserveAdminSecondStepAttempt(clientIp(c), null);
    if (retry > 0) { c.header('Retry-After', String(retry)); throw new HttpError(429, `too many attempts — try again in ${retry}s`, 'RATE_LIMITED'); }
    const r = await redeemHandoffCode(body);
    if (!r.ok) {
      log.warn('admin_handoff_redeem_refused', { clientId: body.clientId, reason: r.reason });
      if (r.reason === 'disabled') throw new HttpError(404, 'account handoff is not enabled on this server', 'FEATURE_DISABLED');
      if (r.reason === 'invalid_client') throw new HttpError(401, 'invalid client', 'INVALID_CLIENT');
      throw new HttpError(400, 'invalid or expired code', 'INVALID_GRANT');
    }
    log.info('admin_handoff_code_redeemed', { adminUserId: r.admin.id, clientId: body.clientId });
    c.header('Cache-Control', 'no-store');
    return c.json({ token: r.token, tokenType: 'Bearer' as const, expiresInSeconds: r.expiresInSeconds, admin: r.admin, issuer: r.issuer }, 200);
  }),
);
