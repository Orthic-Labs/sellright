/**
 * Admin account security (P1b, security audit 2026-10-15): TOTP enrolment, recovery codes, password
 * change, and the per-store "require 2FA" setting. Moved out of admin-settings.ts.
 *
 * Every credential check here goes through the shared admin gate (auth/rate-limit.ts: (ip, account) +
 * per-account + per-IP budgets). Enabling 2FA, disabling it, regenerating recovery codes and changing the
 * password all re-prove the CURRENT password in the same request (an inline step-up), so a stolen
 * session cookie alone can neither swap in an attacker's authenticator nor lock the owner out.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { newTotpSecret, otpauthUri } from '../auth/totp.js';
import { totpQrSvg } from '../auth/totp-qr.js';
import { resolveStore } from '../store-context.js';
import { storeIdentityFromConfig } from './store-identity.js';
import { attemptPendingTotpEnrollment, consumePendingTotpEnrollment, setPendingTotpEnrollment, adminPasskeyCount } from '../auth/admin-auth-challenge.js';
import { AdminFactorMutationError, getAdminCredentialsById, mutateAdminSecondFactor } from '../auth/admin-staff.js';
import { changeAdminPassword, type AdminPrincipal } from '../auth/admin-session.js';
import { ADMIN_PASSWORD_MIN, hashPassword, verifyPassword } from '../auth/password.js';
import { remainingRecoveryCodes, verifyLoginFactor, verifySecondFactorDetailed, verifyTotpOnce } from '../auth/second-factor.js';
import { clientIp, reserveAdminAuthAttempt, clearAdminAuthFailures } from '../auth/rate-limit.js';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireOwner, requireHuman, requireStepUp, requireStepUpEpoch, guard } from './admin-helpers.js';
import { mutateStoreConfig } from './admin-settings.js';

export const adminSecurity = new OpenAPIHono();

const tooMany = { description: 'Too many attempts', ...errBody };

/** Shared gate: reserves one attempt (429 when the admin's budget is spent). `ok()` clears the password budgets and is
 *  only called after the CURRENT PASSWORD was verified (every route here re-proves it). */
async function credentialGate(c: Context, admin: AdminPrincipal): Promise<{ fail: (msg: string, status?: 401 | 409) => Promise<never>; ok: () => Promise<void> }> {
  const ip = clientIp(c);
  const retry = await reserveAdminAuthAttempt(ip, admin.email);
  if (retry > 0) throw new HttpError(429, `too many attempts — try again in ${retry}s`, 'RATE_LIMITED');
  return {
    fail: async (msg, status = 401) => { throw new HttpError(status, msg); }, // the attempt is already counted
    ok: () => clearAdminAuthFailures(ip, admin.email),
  };
}

/** Best-effort security audit row in the admin's current (or first) store; admins with no store skip it. */
async function audit(c: Context, admin: AdminPrincipal, action: string, data?: Record<string, unknown>): Promise<void> {
  const slug = c.req.header('x-store-slug');
  const st = admin.stores.find((x) => x.slug === slug) ?? admin.stores[0];
  if (!st) return;
  await withStore(st.storeId, (tx) => tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'admin_security', entityId: admin.id, action, data }));
}

// ── 2FA status ────────────────────────────────────────────────────────────────
adminSecurity.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/2fa', summary: '2FA status for the signed-in admin',
    responses: { 200: { description: 'OK', content: J(z.object({ enabled: z.boolean(), required: z.boolean(), recoveryCodesRemaining: z.number().int(), passkeys: z.number().int() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const creds = await getAdminCredentialsById(admin.id);
    const enabled = !!creds?.totpSecret;
    const passkeys = await adminPasskeyCount(admin.id);
    return c.json({ enabled, required: admin.totpRequired === true, recoveryCodesRemaining: enabled || passkeys > 0 ? await remainingRecoveryCodes(admin.id) : 0, passkeys }, 200);
  }),
);

/** Issue #333: within this window enrolment needs only the 6-digit code (no password re-entry). */
const ENROLL_FRESH_MS = 15 * 60 * 1000;
const freshForEnrollment = (admin: AdminPrincipal) => admin.kind === 'human' && (
  // a current-epoch step-up within the window, or
  (!!admin.stepUpAt && Date.now() - admin.stepUpAt.getTime() <= ENROLL_FRESH_MS && admin.stepUpEpoch !== null && admin.stepUpEpoch === admin.securityEpoch)
  // the account's FIRST second factor, from a session signed in within the window (that sign-in proved the password).
  || (!admin.totpEnabled && !admin.passkeyEnabled && !!admin.sessionCreatedAt && Date.now() - admin.sessionCreatedAt.getTime() <= ENROLL_FRESH_MS));
/** Issuer shown in the authenticator app: the administered store's display name (store identity, as on the sign-in
 *  screens), for the x-store-slug store the admin belongs to, else their first store. */
async function issuerFor(c: Context, admin: AdminPrincipal): Promise<string> {
  const slug = c.req.header('x-store-slug');
  const st = admin.stores.find((x) => x.slug === slug) ?? admin.stores[0];
  if (!st) return 'SellRight';
  try { return storeIdentityFromConfig(await resolveStore(st.slug), true).storeName.trim() || st.name; } catch { return st.name?.trim() || 'SellRight'; }
}

adminSecurity.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/2fa/setup', summary: 'Start 2FA setup: a NEW pending secret for this session on every call (QR + manual key); replaces any earlier pending one',
    responses: {
      200: { description: 'OK', content: J(z.object({ setupId: z.string(), secret: z.string(), otpauthUri: z.string(), qrSvg: z.string(), issuer: z.string(), account: z.string(), passwordRequired: z.boolean() })) },
      401: { description: 'Unauthorized', ...errBody }, 409: { description: 'Already enabled', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin, token } = await requireAdmin(c);
    requireHuman(admin); // agents have no 2FA (deny set already blocks the route; belt and braces)
    const creds = await getAdminCredentialsById(admin.id);
    if (!creds) throw new HttpError(401, 'not authenticated', 'NOT_AUTHENTICATED');
    if (creds.totpSecret) throw new HttpError(409, '2FA already enabled — disable it first');
    // The pending secret lives server-side (sealed), bound to THIS session; it rotates on every visit until confirmed.
    const secret = newTotpSecret();
    const setupId = await setPendingTotpEnrollment(admin.id, token, creds.securityEpoch, secret);
    const issuer = await issuerFor(c, admin);
    const uri = otpauthUri(secret, admin.email, issuer);
    return c.json({ setupId, secret, otpauthUri: uri, qrSvg: totpQrSvg(uri), issuer, account: admin.email, passwordRequired: !freshForEnrollment(admin) }, 200);
  }),
);

adminSecurity.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/2fa/enable', summary: 'Confirm + enable 2FA with the 6-digit code for this session\'s pending secret (the current password only when the session is not freshly signed in); returns one-time recovery codes',
    request: { body: { content: J(z.object({
      code: z.string().max(16),
      password: z.string().min(1).optional(),
      /** The setupId of the QR the user scanned (from /2fa/setup); a superseded one answers SETUP_EXPIRED. */
      setupId: z.string().min(16).max(128).optional(),
      /** Legacy API clients: confirm a secret they hold themselves (always with the current password). */
      secret: z.string().min(16).max(64).optional(),
    })) } },
    responses: {
      200: { description: 'OK', content: J(z.object({ enabled: z.boolean(), recoveryCodes: z.array(z.string()) })) },
      401: { description: 'Unauthorized / wrong or missing password (PASSWORD_REQUIRED)', ...errBody }, 409: { description: 'Bad code, setup expired, or already enabled', ...errBody }, 429: tooMany,
    },
  }),
  async (c) => guard(c, async () => {
    const { admin, token } = await requireAdmin(c);
    requireHuman(admin);
    const { secret: clientSecret, code, password, setupId } = c.req.valid('json');
    // ra-sec: refuse to overwrite an existing factor. /disable requires the current
    // code, so replacing 2FA always proves possession of the old device.
    const creds = await getAdminCredentialsById(admin.id);
    if (creds?.totpSecret) throw new HttpError(409, '2FA already enabled — disable it first');
    // A hijacked OLD session cookie alone cannot enrol an attacker's device: outside the fresh sign-in window (and for
    // the legacy client-held secret) the current password is re-proved in this request.
    const needPassword = clientSecret !== undefined || !freshForEnrollment(admin);
    if (needPassword && !password) throw new HttpError(401, 'enter your current password to confirm', 'PASSWORD_REQUIRED');
    const gate = await credentialGate(c, admin);
    if (needPassword && !(await verifyPassword(password!, creds?.passwordHash ?? null))) await gate.fail('invalid password');
    let secret = clientSecret;
    let pendingHash: string | undefined;
    if (!secret) {
      const pending = await attemptPendingTotpEnrollment(admin.id, token, setupId);
      if (!pending || pending.epoch !== creds?.securityEpoch) throw new HttpError(409, 'this setup expired — start again to get a new code', 'SETUP_EXPIRED');
      secret = pending.secret; pendingHash = pending.tokenHash;
    }
    if (!(await verifyTotpOnce(admin.id, secret, code))) await gate.fail('code did not match — check your authenticator app', 409);
    if (needPassword) await gate.ok(); // only a verified PASSWORD resets the password-guessing budgets
    if (pendingHash && !(await consumePendingTotpEnrollment(pendingHash))) throw new HttpError(409, 'this setup expired — start again to get a new code', 'SETUP_EXPIRED');
    const changed = await mutateAdminSecondFactor({ adminId: admin.id, token, passwordHash: creds!.passwordHash, totpSecret: null, totpVersion: creds!.totpVersion, securityEpoch: creds!.securityEpoch, action: 'enable', secret });
    if (!changed) throw new HttpError(409, 'your credentials or session changed meanwhile — sign in again', 'CREDENTIAL_CHANGED');
    const { recoveryCodes } = changed;
    await audit(c, admin, '2fa_enable');
    return c.json({ enabled: true, recoveryCodes }, 200);
  }),
);

adminSecurity.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/2fa/disable', summary: 'Disable 2FA (current password + a TOTP or recovery code)',
    request: { body: { content: J(z.object({ code: z.string(), password: z.string().min(1) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ enabled: z.boolean() })) }, 401: { description: 'Unauthorized / wrong password', ...errBody },
      403: { description: '2FA required by policy', ...errBody }, 409: { description: 'Bad code', ...errBody }, 429: tooMany },
  }),
  async (c) => guard(c, async () => {
    const { admin, token } = await requireAdmin(c);
    requireHuman(admin);
    const { code, password } = c.req.valid('json');
    const creds = await getAdminCredentialsById(admin.id);
    if (!creds?.totpSecret) return c.json({ enabled: false }, 200);
    const gate = await credentialGate(c, admin);
    if (!(await verifyPassword(password, creds.passwordHash))) await gate.fail('invalid password');
    try {
      if (!(await mutateAdminSecondFactor({ adminId: admin.id, token, ...creds, action: 'disable', code }))) {
        throw new HttpError(409, 'your credentials or session changed meanwhile — sign in again', 'CREDENTIAL_CHANGED');
      }
    } catch (error) {
      if (error instanceof AdminFactorMutationError) {
        if (error.code === 'TOTP_REQUIRED') throw new HttpError(403, '2FA is required by security policy — add a passkey before removing your authenticator app', 'TOTP_REQUIRED');
        await gate.fail('invalid code', 409);
      }
      throw error;
    }
    await gate.ok();
    await audit(c, admin, '2fa_disable');
    return c.json({ enabled: false }, 200);
  }),
);

adminSecurity.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/2fa/recovery-codes', summary: 'Replace the recovery codes (current password + a TOTP or recovery code; a passkey-only account: a recovery code or a fresh passkey step-up); returns the new codes once',
    request: { body: { content: J(z.object({ code: z.string().max(64).optional(), password: z.string().min(1) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ recoveryCodes: z.array(z.string()) })) }, 401: { description: 'Unauthorized / wrong password', ...errBody },
      403: { description: 'step_up_required (passkey-only account without a code)', ...errBody }, 409: { description: 'Bad code or 2FA not enabled', ...errBody }, 429: tooMany },
  }),
  async (c) => guard(c, async () => {
    const { admin, token } = await requireAdmin(c);
    requireHuman(admin);
    const { code, password } = c.req.valid('json');
    const creds = await getAdminCredentialsById(admin.id);
    const passkeys = creds && !creds.totpSecret ? await adminPasskeyCount(admin.id) : 0;
    if (!creds || (!creds.totpSecret && passkeys === 0)) throw new HttpError(409, '2FA is not enabled');
    // #333 review: a passkey-only account proves its factor with a current recovery code or a fresh passkey step-up
    // under the current epoch; the password is re-proved either way.
    if (!creds.totpSecret && !code) requireStepUpEpoch(admin);
    const gate = await credentialGate(c, admin);
    if (!(await verifyPassword(password, creds.passwordHash))) await gate.fail('invalid password');
    let receipt: { id: string; usedAt: Date } | undefined;
    if (code || creds.totpSecret) {
      const factor = creds.totpSecret ? await verifySecondFactorDetailed(admin.id, creds.totpSecret, code) : await verifyLoginFactor(admin.id, null, code);
      if (!factor.ok) await gate.fail('invalid code', 409);
      receipt = factor.receipt;
    }
    await gate.ok();
    const changed = await mutateAdminSecondFactor({ adminId: admin.id, token, ...creds, receipt, action: 'recovery' });
    if (!changed) throw new HttpError(409, 'your credentials or session changed meanwhile — sign in again', 'CREDENTIAL_CHANGED');
    const { recoveryCodes } = changed;
    await audit(c, admin, '2fa_recovery_codes_regenerate');
    return c.json({ recoveryCodes }, 200);
  }),
);

// ── password change ───────────────────────────────────────────────────────────
adminSecurity.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/password', summary: 'Change the signed-in admin\'s password (requires a recent step-up and the current password); signs out every other session',
    request: { body: { content: J(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(ADMIN_PASSWORD_MIN).max(256) })) } },
    responses: {
      200: { description: 'OK', content: J(z.object({ ok: z.boolean(), revokedSessions: z.number().int() })) },
      400: { description: 'New password rejected', ...errBody }, 401: { description: 'Unauthorized / wrong password', ...errBody },
      403: { description: 'step_up_required', ...errBody }, 429: tooMany,
    },
  }),
  async (c) => guard(c, async () => {
    const { admin, token } = await requireAdmin(c);
    requireHuman(admin);
    requireStepUpEpoch(admin); // 0108: earned under the current epoch; re-checked against the locked session row below
    const { currentPassword, newPassword } = c.req.valid('json');
    if (newPassword === currentPassword) throw new HttpError(400, 'the new password must differ from the current one', 'PASSWORD_UNCHANGED', 'newPassword');
    const creds = await getAdminCredentialsById(admin.id);
    const gate = await credentialGate(c, admin);
    if (!(await verifyPassword(currentPassword, creds?.passwordHash ?? null))) await gate.fail('invalid password');
    await gate.ok();
    const revokedSessions = await changeAdminPassword(admin.id, creds!.passwordHash!, await hashPassword(newPassword), token,
      { epoch: creds!.securityEpoch, totpVersion: creds!.totpVersion, stepUpAt: admin.stepUpAt, stepUpEpoch: admin.stepUpEpoch });
    if (revokedSessions === null) throw new HttpError(409, 'your password or session changed meanwhile — sign in again', 'CREDENTIAL_CHANGED');
    await audit(c, admin, 'password_change', { revokedSessions });
    return c.json({ ok: true, revokedSessions }, 200);
  }),
);

// ── per-store "require 2FA" ───────────────────────────────────────────────────
const SecuritySettings = z.object({ requireTotp: z.boolean(), installRequireTotp: z.enum(['off', 'privileged', 'all']) });

adminSecurity.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/settings/security', summary: 'Store security settings (2FA requirement)',
    responses: { 200: { description: 'OK', content: J(SecuritySettings) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    return c.json({ requireTotp: st.requireTotp === true, installRequireTotp: env.ADMIN_REQUIRE_TOTP }, 200);
  }),
);

adminSecurity.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/settings/security', summary: 'Require 2FA for this store\'s owners and managers (owner only; recent step-up)',
    request: { body: { content: J(z.object({ requireTotp: z.boolean() })) } },
    responses: { 200: { description: 'OK', content: J(SecuritySettings) }, 401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Owner only / step_up_required', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    requireHuman(admin);
    const st = requireStore(admin, c);
    requireOwner(st);
    requireStepUpEpoch(admin); // 0108
    const { requireTotp } = c.req.valid('json');
    await mutateStoreConfig(st.storeId, (config) => ({
      ...config,
      security: { ...(config.security as Record<string, unknown> | undefined), requireTotp },
    }), {
      actor: admin.email,
      action: 'security-require-totp',
      detail: (prev) => ({ before: { requireTotp: (prev.security as { requireTotp?: unknown } | undefined)?.requireTotp === true }, after: { requireTotp } }),
    });
    return c.json({ requireTotp, installRequireTotp: env.ADMIN_REQUIRE_TOTP }, 200);
  }),
);
