/**
 * Customer passkeys (WebAuthn) — docs/plans/2026-10-21-passkeys-and-federated-signin.md §7.
 *
 * Login routes are public (app.ts exempts them from the customer CSRF check like /v1/shop/auth/login); every other
 * route needs a live customer session, resolved WITHOUT renewal (design §5) so the session row is never row-locked
 * inside the transactions that lock the customer. Management is proof → grant → one operation; the grant is bound
 * to the session and to the browser nonce cookie set on the grant response.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { PASSKEY_NONCE_COOKIE, clearPasskeyNonceCookie, cookie, newCsrf, setCustomerCookies, setPasskeyNonceCookie } from '../auth/cookies.js';
import { CHALLENGE_TTL_SECONDS, CREDENTIAL_ID_MAX, LABEL_MAX, MAILBOX_TTL_MINUTES, RESPONSE_FIELD_MAX, budgets, passkeysEnabled, relyingPartyFor, type RelyingParty } from '../auth/passkeys-core.js';
import {
  listCustomerPasskeys, shopDeletePasskey, shopGrantFromPassword, shopLoginOptions, shopLoginVerify, shopMailboxConfirm, shopMailboxRequest, shopManageOptions, shopManageVerify,
  shopRegisterOptions, shopRegisterVerify, type ShopRefusal,
} from '../auth/passkeys-shop.js';
import { clientIp } from '../auth/rate-limit.js';
import { customerToken, resolveCustomer, sessionPolicy } from '../auth/session.js';
import { withStore } from '../db/client.js';
import { enqueuePasskeyManageLink, resolveStorefrontUrl } from '../email/dispatch.js';
import { apiErrorSchema, errJson } from '../lib/api-error.js';
import { resolveStoreFromCtx } from './store-context.js';
import type { StoreCtx } from '../store-context.js';

export const shopPasskeys = new OpenAPIHono();

const J = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });
const err = { content: J(apiErrorSchema()) };
const field = z.string().max(RESPONSE_FIELD_MAX);
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
const Grant = z.string().min(20).max(256);
const Summary = z.object({ id: z.string(), label: z.string(), deviceType: z.string(), backedUp: z.boolean(), createdAt: z.string(), lastUsedAt: z.string().nullable() });
const Options = z.object({ options: z.record(z.string(), z.unknown()) });
const GrantOut = z.object({ grant: z.string() });
const CustomerOut = z.object({ id: z.string(), email: z.string(), firstName: z.string().nullable(), lastName: z.string().nullable(), phone: z.string().nullable(), emailVerified: z.boolean(), isMigrated: z.boolean() });

const emailStoreCtx = (st: StoreCtx) => ({ name: st.name, currency: st.currency, config: st.config });
const storeRp = (st: StoreCtx): RelyingParty => relyingPartyFor(resolveStorefrontUrl(emailStoreCtx(st)), st.name);
const customerCookieSeconds = (st: StoreCtx) => Math.ceil(sessionPolicy(st.config).ttlMs / 1000);
const toJson = (p: { createdAt: Date; lastUsedAt: Date | null; id: string; label: string; deviceType: string; backedUp: boolean }) =>
  ({ id: p.id, label: p.label, deviceType: p.deviceType, backedUp: p.backedUp, createdAt: p.createdAt.toISOString(), lastUsedAt: p.lastUsedAt ? p.lastUsedAt.toISOString() : null });

type Ctx = Parameters<typeof errJson>[0];
const disabled = (c: Ctx) => errJson(c, 404, 'FEATURE_DISABLED', 'passkeys are not enabled on this installation');
/** Refusals → HTTP: generic 401 for login, 409 for ceremonies/grants, 429 budgets. */
function refused(c: Ctx, r: ShopRefusal, generic: 401 | 409) {
  switch (r.code) {
    case 'RATE_LIMITED': return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${r.retry ?? 60}s`);
    case 'TOO_MANY_PASSKEYS': return errJson(c, 409, 'TOO_MANY_PASSKEYS', 'this account already has the maximum number of passkeys');
    case 'CREDENTIAL_EXISTS': return errJson(c, 409, 'CREDENTIAL_EXISTS', 'this passkey is already registered');
    case 'NO_RECOVERY_PATH': return errJson(c, 409, 'NO_RECOVERY_PATH', 'add a password or another sign-in method before removing your last passkey');
    case 'PASSKEY_INVALID': return generic === 401 ? errJson(c, 401, 'PASSKEY_INVALID', 'passkey could not be verified') : errJson(c, 409, 'CEREMONY_INVALID', 'passkey ceremony could not be completed — start again in this browser');
    default: return errJson(c, 409, 'CEREMONY_INVALID', 'passkey ceremony could not be completed — start again in this browser');
  }
}

/** Live customer for a management route: no renewal (design §5), generic 401 otherwise. */
async function sessionCustomer(c: Ctx, st: StoreCtx): Promise<{ id: string; token: string } | null> {
  const token = customerToken(c);
  if (!token) return null;
  const cust = await withStore(st.id, (tx) => resolveCustomer(tx, token, false, { renew: false }));
  return cust ? { id: cust.id, token } : null;
}
const unauth = (c: Ctx) => errJson(c, 401, 'NOT_AUTHENTICATED', 'not authenticated');

// ── public login ─────────────────────────────────────────────────────────────

shopPasskeys.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/auth/passkey/login/options', summary: 'Start a discoverable passkey sign-in',
    request: { body: { content: J(z.object({}).passthrough()) } },
    responses: { 200: { description: 'OK', content: J(Options) }, 404: { description: 'Disabled', ...err }, 429: { description: 'Rate limited', ...err } },
  }),
  async (c) => {
    if (!passkeysEnabled()) return disabled(c);
    const st = await resolveStoreFromCtx(c);
    const retry = await budgets.shopOptions(st.id, clientIp(c));
    if (retry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${retry}s`);
    const { options, nonce } = await shopLoginOptions({ rp: storeRp(st), storeId: st.id });
    setPasskeyNonceCookie(c, nonce, CHALLENGE_TTL_SECONDS);
    return c.json({ options: options as unknown as Record<string, unknown> }, 200);
  },
);

shopPasskeys.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/auth/passkey/login/verify', summary: 'Finish a passkey sign-in',
    request: { body: { content: J(z.object({ response: AssertionJSON })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ token: z.string(), customer: CustomerOut })) }, 401: { description: 'Invalid', ...err }, 404: { description: 'Disabled', ...err }, 409: { description: 'Ceremony error', ...err }, 429: { description: 'Rate limited', ...err } },
  }),
  async (c) => {
    if (!passkeysEnabled()) return disabled(c);
    const st = await resolveStoreFromCtx(c);
    const { response } = c.req.valid('json');
    const r = await shopLoginVerify({ rp: storeRp(st), storeId: st.id, storeConfig: st.config, response: response as unknown as AuthenticationResponseJSON, nonce: cookie(c, PASSKEY_NONCE_COOKIE), ip: clientIp(c) });
    clearPasskeyNonceCookie(c);
    if (!r.ok) return refused(c, r, 401);
    setCustomerCookies(c, r.token, newCsrf(), customerCookieSeconds(st));
    return c.json({ token: r.token, customer: r.customer }, 200);
  },
);

// ── proofs → grant ───────────────────────────────────────────────────────────

shopPasskeys.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/auth/passkey/grant/password', summary: 'Management grant from the current password',
    request: { body: { content: J(z.object({ password: z.string().min(1).max(256) })) } },
    responses: { 200: { description: 'OK', content: J(GrantOut) }, 401: { description: 'Unauthenticated', ...err }, 404: { description: 'Disabled', ...err }, 409: { description: 'Wrong password / not eligible', ...err }, 429: { description: 'Rate limited', ...err } },
  }),
  async (c) => {
    if (!passkeysEnabled()) return disabled(c);
    const st = await resolveStoreFromCtx(c);
    const me = await sessionCustomer(c, st);
    if (!me) return unauth(c);
    const { password } = c.req.valid('json');
    const r = await shopGrantFromPassword({ rp: storeRp(st), storeId: st.id, customerId: me.id, sessionToken: me.token, password });
    if (!r.ok) return refused(c, r, 409);
    setPasskeyNonceCookie(c, r.grantNonce, CHALLENGE_TTL_SECONDS);
    return c.json({ grant: r.grant }, 200);
  },
);

shopPasskeys.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/auth/passkey/manage/options', summary: 'Start a management proof with an existing passkey',
    request: { body: { content: J(z.object({}).passthrough()) } },
    responses: { 200: { description: 'OK', content: J(Options) }, 401: { description: 'Unauthenticated', ...err }, 404: { description: 'Disabled', ...err }, 409: { description: 'No passkey / not eligible', ...err }, 429: { description: 'Rate limited', ...err } },
  }),
  async (c) => {
    if (!passkeysEnabled()) return disabled(c);
    const st = await resolveStoreFromCtx(c);
    const me = await sessionCustomer(c, st);
    if (!me) return unauth(c);
    const r = await shopManageOptions({ rp: storeRp(st), storeId: st.id, customerId: me.id, sessionToken: me.token });
    if (!r.ok) return refused(c, r, 409);
    setPasskeyNonceCookie(c, r.nonce, CHALLENGE_TTL_SECONDS);
    return c.json({ options: r.options as unknown as Record<string, unknown> }, 200);
  },
);

shopPasskeys.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/auth/passkey/manage/verify', summary: 'Finish a management proof with an existing passkey → grant',
    request: { body: { content: J(z.object({ response: AssertionJSON })) } },
    responses: { 200: { description: 'OK', content: J(GrantOut) }, 401: { description: 'Unauthenticated', ...err }, 404: { description: 'Disabled', ...err }, 409: { description: 'CEREMONY_INVALID', ...err }, 429: { description: 'Rate limited', ...err } },
  }),
  async (c) => {
    if (!passkeysEnabled()) return disabled(c);
    const st = await resolveStoreFromCtx(c);
    const me = await sessionCustomer(c, st);
    if (!me) return unauth(c);
    const { response } = c.req.valid('json');
    const r = await shopManageVerify({ rp: storeRp(st), storeId: st.id, customerId: me.id, sessionToken: me.token, response: response as unknown as AuthenticationResponseJSON, nonce: cookie(c, PASSKEY_NONCE_COOKIE) });
    if (!r.ok) { clearPasskeyNonceCookie(c); return refused(c, r, 409); }
    setPasskeyNonceCookie(c, r.grantNonce, CHALLENGE_TTL_SECONDS);
    return c.json({ grant: r.grant }, 200);
  },
);

shopPasskeys.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/auth/passkey/grant/request', summary: 'Mail a management confirmation link (accounts with neither a password nor a passkey); identical answer whether or not it sent',
    request: { body: { content: J(z.object({}).passthrough()) } },
    responses: { 202: { description: 'Accepted', content: J(z.object({ ok: z.boolean() })) }, 401: { description: 'Unauthenticated', ...err }, 404: { description: 'Disabled', ...err }, 409: { description: 'Not eligible', ...err }, 429: { description: 'Rate limited', ...err } },
  }),
  async (c) => {
    if (!passkeysEnabled()) return disabled(c);
    const st = await resolveStoreFromCtx(c);
    const me = await sessionCustomer(c, st);
    if (!me) return unauth(c);
    const base = resolveStorefrontUrl(emailStoreCtx(st));
    const r = await shopMailboxRequest({ storeId: st.id, customerId: me.id, sessionToken: me.token, mail: async (tx, raw, email) => {
      await enqueuePasskeyManageLink(tx, st.id, emailStoreCtx(st), email, { url: `${base}/account/passkeys/confirm?token=${raw}`, ttlMinutes: MAILBOX_TTL_MINUTES });
    } });
    if (!r.ok) return refused(c, r, 409);
    setPasskeyNonceCookie(c, r.nonce, MAILBOX_TTL_MINUTES * 60);
    return c.json({ ok: true }, 202);
  },
);

shopPasskeys.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/auth/passkey/grant/confirm', summary: 'Redeem the mailed confirmation link (same session, same browser) → grant',
    request: { body: { content: J(z.object({ token: z.string().min(20).max(512) })) } },
    responses: { 200: { description: 'OK', content: J(GrantOut) }, 401: { description: 'Unauthenticated', ...err }, 404: { description: 'Disabled', ...err }, 409: { description: 'Invalid / not eligible', ...err }, 429: { description: 'Rate limited', ...err } },
  }),
  async (c) => {
    if (!passkeysEnabled()) return disabled(c);
    const st = await resolveStoreFromCtx(c);
    const me = await sessionCustomer(c, st);
    if (!me) return unauth(c);
    const { token } = c.req.valid('json');
    const r = await shopMailboxConfirm({ rp: storeRp(st), storeId: st.id, customerId: me.id, sessionToken: me.token, token, nonce: cookie(c, PASSKEY_NONCE_COOKIE) });
    if (!r.ok) { clearPasskeyNonceCookie(c); return refused(c, r, 409); }
    setPasskeyNonceCookie(c, r.grantNonce, CHALLENGE_TTL_SECONDS);
    return c.json({ grant: r.grant }, 200);
  },
);

// ── grant → registration / deletion ─────────────────────────────────────────

shopPasskeys.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/auth/passkey/register/options', summary: 'Start adding a passkey (consumes a management grant)',
    request: { body: { content: J(z.object({ grant: Grant })) } },
    responses: { 200: { description: 'OK', content: J(Options) }, 401: { description: 'Unauthenticated', ...err }, 404: { description: 'Disabled', ...err }, 409: { description: 'CEREMONY_INVALID / TOO_MANY_PASSKEYS', ...err }, 429: { description: 'Rate limited', ...err } },
  }),
  async (c) => {
    if (!passkeysEnabled()) return disabled(c);
    const st = await resolveStoreFromCtx(c);
    const me = await sessionCustomer(c, st);
    if (!me) return unauth(c);
    const { grant } = c.req.valid('json');
    const r = await shopRegisterOptions({ rp: storeRp(st), storeId: st.id, customerId: me.id, sessionToken: me.token, grant, nonce: cookie(c, PASSKEY_NONCE_COOKIE) });
    if (!r.ok) { clearPasskeyNonceCookie(c); return refused(c, r, 409); }
    setPasskeyNonceCookie(c, r.nonce, CHALLENGE_TTL_SECONDS);
    return c.json({ options: r.options as unknown as Record<string, unknown> }, 200);
  },
);

shopPasskeys.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/auth/passkey/register/verify', summary: 'Finish adding a passkey',
    request: { body: { content: J(z.object({ response: AttestationJSON, label: z.string().trim().min(1).max(LABEL_MAX) })) } },
    responses: { 200: { description: 'OK', content: J(Summary) }, 401: { description: 'Unauthenticated', ...err }, 404: { description: 'Disabled', ...err }, 409: { description: 'CEREMONY_INVALID / CREDENTIAL_EXISTS / TOO_MANY_PASSKEYS', ...err }, 429: { description: 'Rate limited', ...err } },
  }),
  async (c) => {
    if (!passkeysEnabled()) return disabled(c);
    const st = await resolveStoreFromCtx(c);
    const me = await sessionCustomer(c, st);
    if (!me) return unauth(c);
    const { response, label } = c.req.valid('json');
    const r = await shopRegisterVerify({ rp: storeRp(st), storeId: st.id, customerId: me.id, sessionToken: me.token, response: response as unknown as RegistrationResponseJSON, nonce: cookie(c, PASSKEY_NONCE_COOKIE), label });
    clearPasskeyNonceCookie(c);
    if (!r.ok) return refused(c, r, 409);
    return c.json(toJson(r.passkey), 200);
  },
);

shopPasskeys.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/account/passkeys', summary: 'List my passkeys in this store',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(Summary) })) }, 401: { description: 'Unauthenticated', ...err }, 404: { description: 'Disabled', ...err } },
  }),
  async (c) => {
    if (!passkeysEnabled()) return disabled(c);
    const st = await resolveStoreFromCtx(c);
    const me = await sessionCustomer(c, st);
    if (!me) return unauth(c);
    return c.json({ items: (await listCustomerPasskeys(st.id, me.id)).map(toJson) }, 200);
  },
);

shopPasskeys.openapi(
  createRoute({
    method: 'delete', path: '/v1/shop/account/passkeys/{id}', summary: 'Remove one of my passkeys (consumes a management grant)',
    request: { params: z.object({ id: z.string().uuid() }), body: { content: J(z.object({ grant: Grant })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 401: { description: 'Unauthenticated', ...err }, 404: { description: 'Disabled', ...err }, 409: { description: 'CEREMONY_INVALID / NO_RECOVERY_PATH', ...err }, 429: { description: 'Rate limited', ...err } },
  }),
  async (c) => {
    if (!passkeysEnabled()) return disabled(c);
    const st = await resolveStoreFromCtx(c);
    const me = await sessionCustomer(c, st);
    if (!me) return unauth(c);
    const { id } = c.req.valid('param');
    const { grant } = c.req.valid('json');
    const r = await shopDeletePasskey({ rp: storeRp(st), storeId: st.id, storeConfig: st.config, customerId: me.id, sessionToken: me.token, id, grant, nonce: cookie(c, PASSKEY_NONCE_COOKIE) });
    clearPasskeyNonceCookie(c);
    if (!r.ok) return refused(c, r, 409);
    return c.json({ ok: true }, 200);
  },
);
