/**
 * Admin passkeys (WebAuthn) — docs/plans/2026-10-21-passkeys-and-federated-signin.md §7.
 *
 * Pre-session routes (capabilities, login/options, login/verify) are treated exactly like POST /v1/admin/login:
 * app.ts admits them without a credential and exempts them from CSRF, admin-agent-guard.ts lists them as PUBLIC
 * (no principal is resolved), and agent-policy.ts excepts the two POSTs from the irreversible-path gate. Every other
 * route here is a human session route; enrolment/removal/step-up are AGENT_DENIED (group credentials).
 *
 * With PASSKEYS_ENABLED=0 every route stays registered (the boundary script and the matrix inventory are static)
 * and answers 404 FEATURE_DISABLED before any work.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { resolveAdmin, type AdminPrincipal } from '../auth/admin-session.js';
import { PASSKEY_NONCE_COOKIE, clearPasskeyNonceCookie, cookie, newCsrf, setAuthCookies, setPasskeyNonceCookie } from '../auth/cookies.js';
import { clientIp } from '../auth/rate-limit.js';
import {
  adminLoginOptions, adminLoginVerify, adminRegisterOptions, adminRegisterVerify, adminStepUpOptions, adminStepUpVerify, deleteAdminPasskey, listAdminPasskeys, type Refusal,
} from '../auth/passkeys-admin.js';
import { CHALLENGE_TTL_SECONDS, CREDENTIAL_ID_MAX, LABEL_MAX, RESPONSE_FIELD_MAX, adminRelyingParty, budgets, passkeysEnabled } from '../auth/passkeys-core.js';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { HttpError, J, errBody, guard, requireAdmin, requireHuman, requireStepUpEpoch } from './admin-helpers.js';

export const adminPasskeys = new OpenAPIHono();

const field = z.string().max(RESPONSE_FIELD_MAX);
/** Body caps (§7): the credential id and each response field; the library validates the rest. */
const AssertionJSON = z.object({
  id: z.string().min(1).max(CREDENTIAL_ID_MAX), rawId: z.string().min(1).max(CREDENTIAL_ID_MAX), type: z.literal('public-key'),
  response: z.object({ clientDataJSON: field, authenticatorData: field, signature: field, userHandle: field.optional() }).passthrough(),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional(), authenticatorAttachment: z.string().max(32).optional(),
}).passthrough();
const AttestationJSON = z.object({
  id: z.string().min(1).max(CREDENTIAL_ID_MAX), rawId: z.string().min(1).max(CREDENTIAL_ID_MAX), type: z.literal('public-key'),
  response: z.object({ clientDataJSON: field, attestationObject: field, transports: z.array(z.string().max(32)).max(8).optional() }).passthrough(),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional(), authenticatorAttachment: z.string().max(32).optional(),
}).passthrough();
const Summary = z.object({ id: z.string(), label: z.string(), deviceType: z.string(), backedUp: z.boolean(), createdAt: z.string(), lastUsedAt: z.string().nullable() });
const Options = z.object({ options: z.record(z.string(), z.unknown()) });
const tooMany = { description: 'Too many attempts', ...errBody };
const disabled = { description: 'Passkeys disabled on this installation', ...errBody };

const enabledOr404 = () => { if (!passkeysEnabled()) throw new HttpError(404, 'passkeys are not enabled on this installation', 'FEATURE_DISABLED'); };
const toJson = (p: { createdAt: Date; lastUsedAt: Date | null; id: string; label: string; deviceType: string; backedUp: boolean }) =>
  ({ id: p.id, label: p.label, deviceType: p.deviceType, backedUp: p.backedUp, createdAt: p.createdAt.toISOString(), lastUsedAt: p.lastUsedAt ? p.lastUsedAt.toISOString() : null });
/** Refusals → HTTP: generic 401 for login/step-up, 409 for ceremonies, 403 step-up, 429 budgets. */
function raise(r: Refusal, generic: 401 | 409): never {
  switch (r.code) {
    case 'RATE_LIMITED': throw new HttpError(429, `too many attempts — try again in ${r.retry ?? 60}s`, 'RATE_LIMITED');
    case 'STEP_UP_REQUIRED': throw new HttpError(403, 'step_up_required');
    case 'TOTP_REQUIRED_FIRST': throw new HttpError(409, 'set up your authenticator app before adding a passkey', 'TOTP_REQUIRED_FIRST');
    case 'TOO_MANY_PASSKEYS': throw new HttpError(409, 'this account already has the maximum number of passkeys', 'TOO_MANY_PASSKEYS');
    case 'CREDENTIAL_EXISTS': throw new HttpError(409, 'this passkey is already registered', 'CREDENTIAL_EXISTS');
    case 'PASSKEY_INVALID': throw new HttpError(generic, generic === 401 ? 'passkey could not be verified' : 'passkey ceremony could not be completed', generic === 401 ? 'PASSKEY_INVALID' : 'CEREMONY_INVALID');
    case 'CEREMONY_INVALID': throw new HttpError(409, 'passkey ceremony could not be completed — start again in this browser', 'CEREMONY_INVALID');
  }
}
/** Best-effort security audit row (same shape as admin-security.ts). */
async function audit(c: Context, admin: AdminPrincipal, action: string, data?: Record<string, unknown>): Promise<void> {
  const slug = c.req.header('x-store-slug');
  const st = admin.stores.find((x) => x.slug === slug) ?? admin.stores[0];
  if (!st) return;
  await withStore(st.storeId, (tx) => tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'admin_security', entityId: admin.id, action, data }));
}

// ── pre-session ──────────────────────────────────────────────────────────────

adminPasskeys.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/capabilities', summary: 'Installation sign-in capabilities (pre-session; identical for every caller)',
    responses: { 200: { description: 'OK', content: J(z.object({ passkeys: z.boolean() })) } },
  }),
  async (c) => c.json({ passkeys: passkeysEnabled() }, 200),
);

adminPasskeys.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/passkeys/login/options', summary: 'Start a discoverable passkey sign-in (pre-session)',
    request: { body: { content: J(z.object({}).passthrough()) } },
    responses: { 200: { description: 'OK', content: J(Options) }, 404: disabled, 429: tooMany },
  }),
  async (c) => guard(c, async () => {
    enabledOr404();
    const retry = await budgets.adminOptions(clientIp(c));
    if (retry > 0) throw new HttpError(429, `too many attempts — try again in ${retry}s`, 'RATE_LIMITED');
    const { options, nonce } = await adminLoginOptions(adminRelyingParty());
    setPasskeyNonceCookie(c, nonce, CHALLENGE_TTL_SECONDS);
    return c.json({ options: options as unknown as Record<string, unknown> }, 200);
  }),
);

adminPasskeys.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/passkeys/login/verify', summary: 'Finish a passkey sign-in (pre-session): same response as POST /v1/admin/login',
    request: { body: { content: J(z.object({ response: AssertionJSON, returnToken: z.boolean().optional() })) } },
    responses: {
      200: { description: 'OK', content: J(z.object({ token: z.string().optional(), csrfToken: z.string(), admin: z.object({ email: z.string() }), stores: z.array(z.unknown()), totpEnrollmentRequired: z.boolean().optional() })) },
      401: { description: 'Invalid', ...errBody }, 404: disabled, 429: tooMany,
    },
  }),
  async (c) => guard(c, async () => {
    enabledOr404();
    const { response, returnToken } = c.req.valid('json');
    const r = await adminLoginVerify({ rp: adminRelyingParty(), response: response as unknown as AuthenticationResponseJSON, nonce: cookie(c, PASSKEY_NONCE_COOKIE), ip: clientIp(c) });
    clearPasskeyNonceCookie(c);
    if (!r.ok) raise(r, 401);
    const csrf = newCsrf();
    setAuthCookies(c, r.token, csrf);
    const admin = await resolveAdmin(r.token);
    const totpEnrollmentRequired = !!admin && admin.totpRequired === true && !admin.totpEnabled;
    return c.json({ ...(returnToken === true ? { token: r.token } : {}), csrfToken: csrf, admin: { email: admin?.email ?? '' }, stores: admin?.stores ?? [], ...(totpEnrollmentRequired ? { totpEnrollmentRequired } : {}) }, 200);
  }),
);

// ── session routes ───────────────────────────────────────────────────────────

adminPasskeys.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/passkeys', summary: 'List the signed-in admin\'s passkeys',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(Summary) })) }, 401: { description: 'Unauthorized', ...errBody }, 404: disabled },
  }),
  async (c) => guard(c, async () => {
    enabledOr404();
    const { admin } = await requireAdmin(c);
    requireHuman(admin);
    return c.json({ items: (await listAdminPasskeys(admin.id)).map(toJson) }, 200);
  }),
);

adminPasskeys.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/passkeys/register/options', summary: 'Start adding a passkey (recent step-up under the current security epoch; TOTP must be enrolled)',
    request: { body: { content: J(z.object({}).passthrough()) } },
    responses: { 200: { description: 'OK', content: J(Options) }, 401: { description: 'Unauthorized', ...errBody }, 403: { description: 'step_up_required', ...errBody }, 404: disabled, 409: { description: 'TOTP_REQUIRED_FIRST / TOO_MANY_PASSKEYS', ...errBody }, 429: tooMany },
  }),
  async (c) => guard(c, async () => {
    enabledOr404();
    const { admin, token } = await requireAdmin(c);
    requireHuman(admin);
    requireStepUpEpoch(admin);
    const r = await adminRegisterOptions({ rp: adminRelyingParty(), adminId: admin.id, sessionToken: token });
    if (!r.ok) raise(r, 409);
    setPasskeyNonceCookie(c, r.nonce, CHALLENGE_TTL_SECONDS);
    return c.json({ options: r.options as unknown as Record<string, unknown> }, 200);
  }),
);

adminPasskeys.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/passkeys/register/verify', summary: 'Finish adding a passkey',
    request: { body: { content: J(z.object({ response: AttestationJSON, label: z.string().trim().min(1).max(LABEL_MAX) })) } },
    responses: { 200: { description: 'OK', content: J(Summary) }, 401: { description: 'Unauthorized', ...errBody }, 403: { description: 'step_up_required', ...errBody }, 404: disabled, 409: { description: 'CEREMONY_INVALID / CREDENTIAL_EXISTS / TOO_MANY_PASSKEYS', ...errBody }, 429: tooMany },
  }),
  async (c) => guard(c, async () => {
    enabledOr404();
    const { admin, token } = await requireAdmin(c);
    requireHuman(admin);
    const { response, label } = c.req.valid('json');
    const r = await adminRegisterVerify({ rp: adminRelyingParty(), adminId: admin.id, sessionToken: token, response: response as unknown as RegistrationResponseJSON, nonce: cookie(c, PASSKEY_NONCE_COOKIE), label });
    clearPasskeyNonceCookie(c);
    if (!r.ok) raise(r, 409);
    await audit(c, admin, 'passkey_add', { credential: r.passkey.id, label });
    return c.json(toJson(r.passkey), 200);
  }),
);

adminPasskeys.openapi(
  createRoute({
    method: 'delete', path: '/v1/admin/passkeys/{id}', summary: 'Remove one of the signed-in admin\'s passkeys (recent step-up; clears step-up on every session)',
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 401: { description: 'Unauthorized', ...errBody }, 403: { description: 'step_up_required', ...errBody }, 404: { description: 'Not found / disabled', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    enabledOr404();
    const { admin } = await requireAdmin(c);
    requireHuman(admin);
    requireStepUpEpoch(admin);
    const { id } = c.req.valid('param');
    if (!(await deleteAdminPasskey({ adminId: admin.id, id }))) throw new HttpError(404, 'passkey not found');
    await audit(c, admin, 'passkey_remove', { credential: id });
    return c.json({ ok: true }, 200);
  }),
);

adminPasskeys.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/step-up/passkey/options', summary: 'Start a passkey step-up for this session',
    request: { body: { content: J(z.object({}).passthrough()) } },
    responses: { 200: { description: 'OK', content: J(Options) }, 401: { description: 'Unauthorized / no passkey', ...errBody }, 404: disabled, 429: tooMany },
  }),
  async (c) => guard(c, async () => {
    enabledOr404();
    const { admin, token } = await requireAdmin(c);
    requireHuman(admin);
    const r = await adminStepUpOptions({ rp: adminRelyingParty(), adminId: admin.id, sessionToken: token });
    if (!r.ok) raise(r, 401);
    setPasskeyNonceCookie(c, r.nonce, CHALLENGE_TTL_SECONDS);
    return c.json({ options: r.options as unknown as Record<string, unknown> }, 200);
  }),
);

adminPasskeys.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/step-up/passkey/verify', summary: 'Finish a passkey step-up: unlocks step-up-gated actions for 5 minutes on this session',
    request: { body: { content: J(z.object({ response: AssertionJSON })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 401: { description: 'Invalid', ...errBody }, 404: disabled, 429: tooMany },
  }),
  async (c) => guard(c, async () => {
    enabledOr404();
    const { admin, token } = await requireAdmin(c);
    requireHuman(admin);
    const { response } = c.req.valid('json');
    const r = await adminStepUpVerify({ rp: adminRelyingParty(), adminId: admin.id, sessionToken: token, response: response as unknown as AuthenticationResponseJSON, nonce: cookie(c, PASSKEY_NONCE_COOKIE) });
    clearPasskeyNonceCookie(c);
    if (!r.ok) raise(r, 401);
    await audit(c, admin, 'step_up_verify', { method: 'passkey' });
    return c.json({ ok: true }, 200);
  }),
);
