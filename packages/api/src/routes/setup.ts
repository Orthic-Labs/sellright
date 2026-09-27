/**
 * One-click install: pre-auth claim surface (plan §1.3/§1.4).
 *
 * Every route here 404s once ANY admin_user row exists — not just once an
 * installation administrator exists. An existing deployment upgraded to a
 * release with admin_user.is_installation_admin has real admins but none
 * flagged installation-admin until the post-migrate promotion
 * (0075_promote_installation_admin.sql) runs; gating on
 * hasInstallationAdmin() alone would read that upgrade as "unclaimed" and
 * lock every existing admin out behind the claim-only UI (see hasAnyAdmin()'s
 * doc comment in setup-claim.ts). An outside observer must not be able to
 * tell "already claimed" from "route never existed" either way (see
 * SetupAlreadyClaimedError/InvalidClaimTokenError). Onboarding after the
 * claim (store basics, preview, checklist, publish) is ordinary authenticated
 * admin work — see admin-settings.ts.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HttpError, J, errBody, guard } from './admin-helpers.js';
import { clientIp, attemptRetryAfter } from '../auth/rate-limit.js';
import { setAuthCookies, newCsrf } from '../auth/cookies.js';
import {
  claimInstallation,
  hasAnyAdmin,
  InvalidClaimTokenError,
  SetupAlreadyClaimedError,
} from '../auth/setup-claim.js';
import { createAdminSession } from '../auth/admin-session.js';

export const setup = new OpenAPIHono();

async function assertUnclaimed(): Promise<void> {
  // HttpError, not the raw SetupAlreadyClaimedError — guard() only translates
  // HttpError into a JSON response; this exact bug (a 500 instead of a 404 on
  // an already-claimed install) was only ever missed because no test hit
  // this route via real HTTP with hasAnyAdmin() already true until
  // setup.upgrade-promotion.db.test.ts's end-to-end case did.
  if (await hasAnyAdmin()) throw new HttpError(404, new SetupAlreadyClaimedError().message);
}

setup.openapi(
  createRoute({
    method: 'get', path: '/v1/setup/status', summary: 'Whether this installation still needs claiming',
    responses: {
      200: { description: 'Unclaimed', content: J(z.object({ claimed: z.literal(false) })) },
      404: { description: 'Already claimed', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    await assertUnclaimed();
    // Never confirms whether a token exists/is valid — that's the point of
    // /v1/setup/claim's own 404 on a bad token. This only answers "does ANY
    // admin_user row exist yet", so the admin UI can decide whether to render
    // the claim screen at all before a token is even known.
    return c.json({ claimed: false as const }, 200);
  }),
);

setup.openapi(
  createRoute({
    method: 'post', path: '/v1/setup/claim', summary: 'Redeem a setup-link token; creates the installation admin + first store',
    request: {
      body: {
        content: J(z.object({
          token: z.string().min(1),
          email: z.string().email(),
          name: z.string().min(1).max(200),
          password: z.string().min(12),
        })),
      },
    },
    responses: {
      200: {
        description: 'Claimed',
        content: J(z.object({ token: z.string(), csrfToken: z.string(), storeSlug: z.string() })),
      },
      404: { description: 'Already claimed, or invalid/expired/used token', ...errBody },
      429: { description: 'Too many attempts', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const ip = clientIp(c);
    // Attempt-counted, not failure-counted (rate-limit.ts): there is no
    // authentication-failure signal here (a bad token 404s exactly like a
    // route that doesn't exist), and this is a high-risk one-shot action
    // like checkout, so every request — success or failure — consumes a slot.
    const retry = attemptRetryAfter(ip, 'setup:claim');
    if (retry > 0) throw new HttpError(429, `too many attempts — try again in ${retry}s`);

    const body = c.req.valid('json');
    let result;
    try {
      result = await claimInstallation(body);
    } catch (e) {
      if (e instanceof SetupAlreadyClaimedError || e instanceof InvalidClaimTokenError) {
        throw new HttpError(404, e.message);
      }
      throw e;
    }

    // Onboarding is ordinary authenticated admin work from here (plan §1.4) —
    // log the new installation admin in immediately, exactly like /v1/admin/login.
    const token = await createAdminSession(result.adminId);
    const csrf = newCsrf();
    setAuthCookies(c, token, csrf);
    return c.json({ token, csrfToken: csrf, storeSlug: result.storeSlug }, 200);
  }),
);
